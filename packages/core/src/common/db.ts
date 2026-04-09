/**
 * db — SQLite database for embeddings and chat sessions.
 *
 * Single file: {WORKSPACE}/workspace.db
 * Uses better-sqlite3 (synchronous, fast, zero-config).
 *
 * Tables:
 *   embeddings — one row per (chunk, model) pair
 *   sessions   — chat sessions
 *   messages   — chat messages per session
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { WORKSPACE } from "../config.js";

// ── Singleton ───────────────────────────────────────────────────────

let _db: Database.Database | null = null;
let _overridePath: string | null = null;

/** Get or create the database singleton. */
export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = join(_overridePath ?? WORKSPACE, "workspace.db");
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");  // wait up to 5s if another process is writing
  _db.pragma("foreign_keys = ON");

  initSchema(_db);
  migrateSchema(_db);
  return _db;
}

/** Close the database connection. Next getDb() call will reopen. */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Reset the database path.
 * Closes the current connection so the next getDb() opens from the new path.
 */
export function resetDb(basePath: string): void {
  closeDb();
  _overridePath = basePath;
}

// ── Schema ──────────────────────────────────────────────────────────

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id          TEXT NOT NULL,
      source      TEXT NOT NULL,
      content     TEXT NOT NULL,
      vector      BLOB NOT NULL,
      model       TEXT NOT NULL,
      dimensions  INTEGER NOT NULL,
      created_at  TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (id, model)
    );

    CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);
    CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source);

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      title       TEXT,
      summary     TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      tokens      INTEGER,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS token_usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT,
      kind          TEXT NOT NULL,
      provider      TEXT NOT NULL,
      base_url      TEXT,
      model         TEXT NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_usage_session ON token_usage(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_created ON token_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_kind    ON token_usage(kind);

    CREATE TABLE IF NOT EXISTS memories (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      content           TEXT NOT NULL,
      category          TEXT,
      source_session_id TEXT,
      active            INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(active);
    CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_session_id);

    CREATE TABLE IF NOT EXISTS app_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS message_embeddings (
      message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      vector      BLOB NOT NULL,
      model       TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_msgemb_model ON message_embeddings(model);
  `);
}

// ── Migrations ─────────────────────────────────────────────────────
// Auto-fix existing databases that were created with older schemas.

function migrateSchema(db: Database.Database): void {
  const sessionCols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  if (!sessionCols.includes("summary")) {
    db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT DEFAULT ''");
  }

  // token_usage migration: add base_url column to older installs
  const usageCols = (db.prepare("PRAGMA table_info(token_usage)").all() as { name: string }[]).map((c) => c.name);
  if (usageCols.length > 0 && !usageCols.includes("base_url")) {
    db.exec("ALTER TABLE token_usage ADD COLUMN base_url TEXT");
  }
}

// ── Token usage tracking ─────────────────────────────────────────────

export interface UsageRecord {
  sessionId: string | null;
  kind: string;         // 'chat' | 'focus' | 'deep_search' | 'compaction' | 'qa_prepare' | 'discover' | 'classify' | 'synthesize' | ...
  provider: string;     // 'anthropic' | 'uptimize'
  baseUrl: string | null; // Optional endpoint URL (useful to distinguish dev vs prod)
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageTotal {
  totalInput: number;
  totalOutput: number;
  callCount: number;
}

export interface UsageByKind extends UsageTotal {
  kind: string;
}

export interface UsageByDay extends UsageTotal {
  date: string; // YYYY-MM-DD
}

export interface UsageByProvider extends UsageTotal {
  provider: string;
  baseUrl: string | null;
  model: string;
}

/** Record a single LLM call's token usage. */
export function recordUsage(rec: UsageRecord): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO token_usage (session_id, kind, provider, base_url, model, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(rec.sessionId, rec.kind, rec.provider, rec.baseUrl, rec.model, rec.inputTokens, rec.outputTokens);
}

/** Total token usage across all calls. */
export function getUsageTotal(): UsageTotal {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) as totalInput,
           COALESCE(SUM(output_tokens), 0) as totalOutput,
           COUNT(*) as callCount
    FROM token_usage
  `).get() as UsageTotal;
  return row;
}

/** Token usage broken down by kind ('chat', 'focus', 'discover', ...). */
export function getUsageByKind(): UsageByKind[] {
  const db = getDb();
  return db.prepare(`
    SELECT kind,
           COALESCE(SUM(input_tokens), 0) as totalInput,
           COALESCE(SUM(output_tokens), 0) as totalOutput,
           COUNT(*) as callCount
    FROM token_usage
    GROUP BY kind
    ORDER BY (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC
  `).all() as UsageByKind[];
}

/** Token usage per day for the last N days. */
export function getUsageByDay(days: number = 30): UsageByDay[] {
  const db = getDb();
  return db.prepare(`
    SELECT date(created_at) as date,
           COALESCE(SUM(input_tokens), 0) as totalInput,
           COALESCE(SUM(output_tokens), 0) as totalOutput,
           COUNT(*) as callCount
    FROM token_usage
    WHERE created_at >= date('now', ?)
    GROUP BY date(created_at)
    ORDER BY date DESC
  `).all(`-${days} days`) as UsageByDay[];
}

/** Token usage broken down by provider + base_url + model (to compare dev vs prod endpoints). */
export function getUsageByProvider(): UsageByProvider[] {
  const db = getDb();
  return db.prepare(`
    SELECT provider,
           base_url as baseUrl,
           model,
           COALESCE(SUM(input_tokens), 0) as totalInput,
           COALESCE(SUM(output_tokens), 0) as totalOutput,
           COUNT(*) as callCount
    FROM token_usage
    GROUP BY provider, base_url, model
    ORDER BY (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC
  `).all() as UsageByProvider[];
}

/** Token usage for a specific session. */
export function getUsageBySession(sessionId: string): UsageTotal {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) as totalInput,
           COALESCE(SUM(output_tokens), 0) as totalOutput,
           COUNT(*) as callCount
    FROM token_usage
    WHERE session_id = ?
  `).get(sessionId) as UsageTotal;
  return row;
}

// ── Memories (cross-session persistent facts) ────────────────────────

export interface Memory {
  id: number;
  content: string;
  category: string | null;
  sourceSessionId: string | null;
  active: number; // 0 or 1
  createdAt: string;
  updatedAt: string;
}

export interface NewMemory {
  content: string;
  category?: string | null;
  sourceSessionId?: string | null;
}

/** Insert a new memory. Returns the id. */
export function addMemory(mem: NewMemory): number {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO memories (content, category, source_session_id, active)
    VALUES (?, ?, ?, 1)
  `).run(mem.content.trim(), mem.category ?? null, mem.sourceSessionId ?? null);
  return info.lastInsertRowid as number;
}

/** Insert multiple memories in one transaction. Returns inserted ids. */
export function addMemories(mems: NewMemory[]): number[] {
  if (mems.length === 0) return [];
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO memories (content, category, source_session_id, active)
    VALUES (?, ?, ?, 1)
  `);
  const tx = db.transaction((items: NewMemory[]) => {
    const ids: number[] = [];
    for (const m of items) {
      const info = stmt.run(m.content.trim(), m.category ?? null, m.sourceSessionId ?? null);
      ids.push(info.lastInsertRowid as number);
    }
    return ids;
  });
  return tx(mems);
}

/** List all memories, ordered by most recent first. */
export function listMemories(opts?: { activeOnly?: boolean }): Memory[] {
  const db = getDb();
  const where = opts?.activeOnly ? "WHERE active = 1" : "";
  return db.prepare(`
    SELECT id, content, category, source_session_id as sourceSessionId,
           active, created_at as createdAt, updated_at as updatedAt
    FROM memories
    ${where}
    ORDER BY created_at DESC
  `).all() as Memory[];
}

/** Get all active memories — used when injecting into the chat system prompt. */
export function getActiveMemories(): Memory[] {
  return listMemories({ activeOnly: true });
}

/** Toggle a memory's active state. */
export function setMemoryActive(id: number, active: boolean): void {
  const db = getDb();
  db.prepare(`
    UPDATE memories SET active = ?, updated_at = datetime('now') WHERE id = ?
  `).run(active ? 1 : 0, id);
}

/** Update a memory's content and/or category. */
export function updateMemory(id: number, updates: { content?: string; category?: string | null }): void {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.content !== undefined) {
    fields.push("content = ?");
    values.push(updates.content.trim());
  }
  if (updates.category !== undefined) {
    fields.push("category = ?");
    values.push(updates.category);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

/** Delete a memory permanently. */
export function deleteMemory(id: number): void {
  const db = getDb();
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

/** Count total memories and active ones. */
export function getMemoryStats(): { total: number; active: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active
    FROM memories
  `).get() as { total: number; active: number | null };
  return { total: row.total ?? 0, active: row.active ?? 0 };
}

// ── App settings (per-workspace key/value config) ────────────────────

/** Read a setting from the DB. Returns the default if not set. */
export function getSetting(key: string, defaultValue: string): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? defaultValue;
}

/** Read a boolean setting. Accepts "true"/"1"/"yes" as truthy. */
export function getBoolSetting(key: string, defaultValue: boolean): boolean {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return defaultValue;
  const v = row.value.toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Write a setting to the DB (upsert). */
export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

/** Get all settings as a plain object. */
export function getAllSettings(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM app_settings").all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

// ── Message embeddings (for semantic history search) ────────────────

export interface MessageEmbeddingRow {
  messageId: number;
  vector: number[];
  model: string;
}

/** Upsert an embedding for a message. */
export function upsertMessageEmbedding(messageId: number, vector: number[], model: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO message_embeddings (message_id, vector, model)
    VALUES (?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET vector = excluded.vector, model = excluded.model
  `).run(messageId, vectorToBuffer(vector), model);
}

/** Load all embeddings for a given model into memory (used at startup). */
export function loadAllMessageEmbeddings(model: string): MessageEmbeddingRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT message_id as messageId, vector, model
    FROM message_embeddings
    WHERE model = ?
  `).all(model) as { messageId: number; vector: Buffer; model: string }[];
  return rows.map((r) => ({
    messageId: r.messageId,
    vector: bufferToVector(r.vector),
    model: r.model,
  }));
}

/** Get a single message + its session info by id (for search results). */
export interface MessageWithSession {
  id: number;
  sessionId: string;
  sessionTitle: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
export function getMessageWithSession(messageId: number): MessageWithSession | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT m.id, m.session_id as sessionId, s.title as sessionTitle,
           m.role, m.content, m.created_at as createdAt
    FROM messages m
    INNER JOIN sessions s ON m.session_id = s.id
    WHERE m.id = ?
  `).get(messageId) as MessageWithSession | undefined;
  return row ?? null;
}

/** Bulk-fetch messages with session info (efficient for search result hydration). */
export function getMessagesWithSession(messageIds: number[]): MessageWithSession[] {
  if (messageIds.length === 0) return [];
  const db = getDb();
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT m.id, m.session_id as sessionId, s.title as sessionTitle,
           m.role, m.content, m.created_at as createdAt
    FROM messages m
    INNER JOIN sessions s ON m.session_id = s.id
    WHERE m.id IN (${placeholders})
  `).all(...messageIds) as MessageWithSession[];
  return rows;
}

/** Count messages and embedded messages (for stats). */
export function getHistoryStats(): { totalMessages: number; embeddedMessages: number } {
  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c;
  const embedded = (db.prepare("SELECT COUNT(*) as c FROM message_embeddings").get() as { c: number }).c;
  return { totalMessages: total, embeddedMessages: embedded };
}

// ── Vector serialization ────────────────────────────────────────────
// Float32Array ↔ Buffer — compact binary storage (~3 KB for 768 dims)

/** Serialize a number[] to a Buffer (Float32Array binary). */
export function vectorToBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

/** Deserialize a Buffer back to number[]. */
export function bufferToVector(buf: Buffer): number[] {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

// ── Embedding CRUD ──────────────────────────────────────────────────

export interface StoredEmbedding {
  id: string;
  source: string;
  content: string;
  vector: number[];
  model: string;
  dimensions: number;
}

/** Upsert a single embedding. */
export function upsertEmbedding(
  id: string, source: string, content: string,
  vector: number[], model: string, dimensions: number,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO embeddings (id, source, content, vector, model, dimensions)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, model) DO UPDATE SET
      source = excluded.source,
      content = excluded.content,
      vector = excluded.vector,
      dimensions = excluded.dimensions,
      created_at = datetime('now')
  `).run(id, source, content, vectorToBuffer(vector), model, dimensions);
}

/** Load all embeddings for a given model. Returns deserialized vectors. */
export function loadEmbeddings(model: string): StoredEmbedding[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, source, content, vector, model, dimensions FROM embeddings WHERE model = ?",
  ).all(model) as { id: string; source: string; content: string; vector: Buffer; model: string; dimensions: number }[];

  return rows.map((row) => ({
    ...row,
    vector: bufferToVector(row.vector),
  }));
}

/** Count embeddings by model. */
export function countEmbeddings(model?: string): number {
  const db = getDb();
  if (model) {
    return (db.prepare("SELECT COUNT(*) as cnt FROM embeddings WHERE model = ?").get(model) as { cnt: number }).cnt;
  }
  return (db.prepare("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number }).cnt;
}

/** Get set of existing embedding IDs for a given model (for skip logic). */
export function getEmbeddingIds(model: string): Set<string> {
  const db = getDb();
  const rows = db.prepare("SELECT id FROM embeddings WHERE model = ?").all(model) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Delete all embeddings for a given model (used when switching providers). */
export function clearEmbeddings(model?: string): number {
  const db = getDb();
  if (model) {
    return db.prepare("DELETE FROM embeddings WHERE model = ?").run(model).changes;
  }
  return db.prepare("DELETE FROM embeddings").run().changes;
}

// ── DB stats ────────────────────────────────────────────────────────

export function getDbStats(): { embeddings: number; sessions: number; messages: number; models: string[] } {
  const db = getDb();
  const embeddings = (db.prepare("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number }).cnt;
  const sessions = (db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number }).cnt;
  const messages = (db.prepare("SELECT COUNT(*) as cnt FROM messages").get() as { cnt: number }).cnt;
  const models = (db.prepare("SELECT DISTINCT model FROM embeddings").all() as { model: string }[]).map((r) => r.model);
  return { embeddings, sessions, messages, models };
}
