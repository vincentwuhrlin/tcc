/**
 * Session management — CRUD for chat sessions and messages.
 *
 * Includes compaction: when a session grows beyond COMPACT_THRESHOLD messages,
 * older messages are summarized into a ~200 token summary. The LLM receives:
 *   1. System prompt (PLAN.md + INDEX.md + RAG chunks)
 *   2. Session summary (compaction of older messages)
 *   3. Last SLIDING_WINDOW_SIZE exchanges (raw)
 *   4. Current question
 */
import { getDb } from "@tcc/core/src/common/db.js";

// ── Config ──────────────────────────────────────────────────────────

/** Start compacting after this many messages (user + assistant combined). */
export const COMPACT_THRESHOLD = 10;

/** Keep this many recent exchanges (1 exchange = user + assistant). */
export const SLIDING_WINDOW_SIZE = 5;

/** Recompute summary every N new messages after threshold. */
export const COMPACT_INTERVAL = 6;

// ── Types ────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  title: string;
  summary: string | null;
  summary_at_count: number;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

export interface SessionMessage {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

/** What gets sent to the LLM as conversation context. */
export interface SessionContext {
  summary: string | null;
  recentMessages: { role: "user" | "assistant"; content: string }[];
  totalMessages: number;
  needsCompaction: boolean;
}

// ── Schema migration ─────────────────────────────────────────────────

let _migrated = false;

function ensureMigration(): void {
  if (_migrated) return;
  const db = getDb();

  // Add summary columns if they don't exist (safe to run multiple times)
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  const colNames = new Set(columns.map((c) => c.name));

  if (!colNames.has("summary")) {
    db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT DEFAULT NULL");
  }
  if (!colNames.has("summary_at_count")) {
    db.exec("ALTER TABLE sessions ADD COLUMN summary_at_count INTEGER DEFAULT 0");
  }

  _migrated = true;
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function truncateTitle(text: string, maxLen = 60): string {
  const firstLine = text.split("\n")[0].trim();
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + "..." : firstLine;
}

// ── Session CRUD ─────────────────────────────────────────────────────

export function createSession(title?: string, existingId?: string): Session {
  ensureMigration();
  const db = getDb();
  const id = existingId ?? generateId();
  const now = new Date().toISOString();
  const sessionTitle = title ?? "New conversation";

  db.prepare(
    "INSERT INTO sessions (id, title, summary, summary_at_count, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)",
  ).run(id, sessionTitle, now, now);

  return { id, title: sessionTitle, summary: null, summary_at_count: 0, created_at: now, updated_at: now, message_count: 0 };
}

export function listSessions(): Session[] {
  ensureMigration();
  const db = getDb();
  return db.prepare(`
    SELECT s.id, s.title, s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count
    FROM sessions s
    ORDER BY s.updated_at DESC
  `).all() as Session[];
}

export function getSession(id: string): Session | null {
  ensureMigration();
  const db = getDb();
  const row = db.prepare(
    "SELECT id, title, summary, summary_at_count, created_at, updated_at FROM sessions WHERE id = ?",
  ).get(id) as Session | undefined;
  return row ?? null;
}

export function deleteSession(id: string): boolean {
  ensureMigration();
  const db = getDb();
  const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  return result.changes > 0;
}

export function updateSessionTitle(id: string, title: string): void {
  ensureMigration();
  const db = getDb();
  db.prepare("UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id);
}

// ── Message CRUD ─────────────────────────────────────────────────────

export function getSessionMessages(sessionId: string): SessionMessage[] {
  ensureMigration();
  const db = getDb();
  return db.prepare(
    "SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC",
  ).all(sessionId) as SessionMessage[];
}

export function getMessageCount(sessionId: string): number {
  const db = getDb();
  return (db.prepare(
    "SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?",
  ).get(sessionId) as { cnt: number }).cnt;
}

export function addMessage(sessionId: string, role: "user" | "assistant", content: string): SessionMessage {
  ensureMigration();
  const db = getDb();

  const result = db.prepare(
    "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)",
  ).run(sessionId, role, content);

  db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);

  // Auto-title from first user message
  if (role === "user") {
    const userMsgCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND role = 'user'",
    ).get(sessionId) as { cnt: number }).cnt;

    if (userMsgCount === 1) {
      updateSessionTitle(sessionId, truncateTitle(content));
    }
  }

  return {
    id: result.lastInsertRowid as number,
    session_id: sessionId,
    role,
    content,
    created_at: new Date().toISOString(),
  };
}

// ── Compaction ────────────────────────────────────────────────────────

/** Save a compaction summary for a session. */
export function saveCompactionSummary(sessionId: string, summary: string, atCount: number): void {
  ensureMigration();
  const db = getDb();
  db.prepare(
    "UPDATE sessions SET summary = ?, summary_at_count = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(summary, atCount, sessionId);
}

/**
 * Build the session context to send to the LLM.
 *
 * Returns:
 *   - summary: the compaction summary (null if < COMPACT_THRESHOLD messages)
 *   - recentMessages: the last SLIDING_WINDOW_SIZE exchanges
 *   - needsCompaction: true if a new summary should be generated
 */
export function buildSessionContext(sessionId: string): SessionContext {
  ensureMigration();
  const allMessages = getSessionMessages(sessionId);
  const totalMessages = allMessages.length;
  const session = getSession(sessionId);

  // Under threshold → send all messages, no compaction needed
  if (totalMessages <= COMPACT_THRESHOLD) {
    return {
      summary: null,
      recentMessages: allMessages.map(({ role, content }) => ({ role, content })),
      totalMessages,
      needsCompaction: false,
    };
  }

  // Sliding window: keep last N exchanges (N*2 messages)
  const windowSize = SLIDING_WINDOW_SIZE * 2;
  const recentMessages = allMessages.slice(-windowSize).map(({ role, content }) => ({ role, content }));

  // Check if compaction is needed
  const summaryAtCount = session?.summary_at_count ?? 0;
  const messagesSinceSummary = totalMessages - summaryAtCount;
  const needsCompaction = !session?.summary || messagesSinceSummary >= COMPACT_INTERVAL;

  return {
    summary: session?.summary ?? null,
    recentMessages,
    totalMessages,
    needsCompaction,
  };
}

/**
 * Get all messages that need to be summarized (everything except the sliding window).
 * Used to generate the compaction summary.
 */
export function getMessagesToSummarize(sessionId: string): { role: "user" | "assistant"; content: string }[] {
  const allMessages = getSessionMessages(sessionId);
  const windowSize = SLIDING_WINDOW_SIZE * 2;

  if (allMessages.length <= windowSize) return [];

  // Everything before the sliding window
  return allMessages.slice(0, -windowSize).map(({ role, content }) => ({ role, content }));
}
