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

/** Get or create the database singleton. */
export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = join(WORKSPACE, "workspace.db");
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");  // wait up to 5s if another process is writing
  _db.pragma("foreign_keys = ON");

  initSchema(_db);
  return _db;
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
  `);
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
