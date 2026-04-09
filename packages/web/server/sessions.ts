/**
 * Session management — CRUD for chat sessions and messages.
 *
 * Includes token-based compaction: when a session's total tokens exceed
 * CHAT_COMPACTION_THRESHOLD_TOKENS, older messages are summarized into a
 * structured summary (up to CHAT_COMPACTION_SUMMARY_TOKENS). The LLM receives:
 *   1. System prompt (instructions.md + domain.md + PLAN.md headers + RAG chunks)
 *   2. Session summary (structured compaction of older messages)
 *   3. Sliding window of the last CHAT_COMPACTION_WINDOW_TOKENS of verbatim messages
 *   4. Current question
 */
import { getDb } from "@tcc/core/src/common/db.js";
import {
  CHAT_COMPACTION_THRESHOLD_TOKENS,
  CHAT_COMPACTION_WINDOW_TOKENS,
} from "@tcc/core/src/config.js";

// ── Config (re-exported for legacy imports — values now come from env) ───

/** @deprecated Use CHAT_COMPACTION_THRESHOLD_TOKENS from config.ts instead. */
export const COMPACT_THRESHOLD = CHAT_COMPACTION_THRESHOLD_TOKENS;
/** @deprecated Use CHAT_COMPACTION_WINDOW_TOKENS from config.ts instead. */
export const SLIDING_WINDOW_SIZE = CHAT_COMPACTION_WINDOW_TOKENS;
/** @deprecated No longer used — compaction triggers on token threshold. */
export const COMPACT_INTERVAL = 0;

// ── Token estimation ────────────────────────────────────────────────
// Fast heuristic: ~4 chars per token. Good enough for triggering compaction
// since the LLM call will report exact usage after the fact.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

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
 * Token-based algorithm:
 *   1. Compute total tokens across all messages
 *   2. If total < CHAT_COMPACTION_THRESHOLD_TOKENS → no compaction, send everything
 *   3. Otherwise, walk from the end keeping messages until sliding window is full
 *      (CHAT_COMPACTION_WINDOW_TOKENS). Everything before that point is summarized.
 *   4. If the set of "to-summarize" messages has grown since last compaction,
 *      mark needsCompaction = true.
 */
export function buildSessionContext(sessionId: string): SessionContext {
  ensureMigration();
  const allMessages = getSessionMessages(sessionId);
  const totalMessages = allMessages.length;
  const session = getSession(sessionId);

  const totalTokens = allMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // Under threshold → send everything verbatim, no compaction
  if (totalTokens <= CHAT_COMPACTION_THRESHOLD_TOKENS) {
    return {
      summary: null,
      recentMessages: allMessages.map(({ role, content }) => ({ role, content })),
      totalMessages,
      needsCompaction: false,
    };
  }

  // Walk backwards filling the sliding window
  let slidingTokens = 0;
  let cutIndex = allMessages.length; // inclusive start of sliding window
  while (cutIndex > 0) {
    const msgTokens = estimateTokens(allMessages[cutIndex - 1].content);
    if (slidingTokens + msgTokens > CHAT_COMPACTION_WINDOW_TOKENS) break;
    cutIndex--;
    slidingTokens += msgTokens;
  }

  // Messages [0..cutIndex-1] are candidates for the summary
  // Messages [cutIndex..end] are the verbatim sliding window
  const toSummarizeCount = cutIndex;
  const recentMessages = allMessages.slice(cutIndex).map(({ role, content }) => ({ role, content }));

  // We need to (re)compact if the number of to-summarize messages has grown
  // beyond what the current summary already covers.
  const summaryCovers = session?.summary_at_count ?? 0;
  const needsCompaction = !session?.summary || toSummarizeCount > summaryCovers;

  return {
    summary: session?.summary ?? null,
    recentMessages,
    totalMessages,
    needsCompaction,
  };
}

/**
 * Get the messages to feed into the compaction prompt along with the
 * existing summary (if any) so the LLM can produce a cumulative summary.
 *
 * Returns:
 *   - existingSummary: the previous summary, or null
 *   - newMessages: all messages that are NOT in the sliding window
 *   - newCount: the value to store as summary_at_count after compaction
 */
export function getCompactionInput(sessionId: string): {
  existingSummary: string | null;
  newMessages: { role: "user" | "assistant"; content: string }[];
  newCount: number;
} {
  const allMessages = getSessionMessages(sessionId);
  const session = getSession(sessionId);

  // Find sliding window cut point
  let slidingTokens = 0;
  let cutIndex = allMessages.length;
  while (cutIndex > 0) {
    const msgTokens = estimateTokens(allMessages[cutIndex - 1].content);
    if (slidingTokens + msgTokens > CHAT_COMPACTION_WINDOW_TOKENS) break;
    cutIndex--;
    slidingTokens += msgTokens;
  }

  return {
    existingSummary: session?.summary ?? null,
    newMessages: allMessages.slice(0, cutIndex).map(({ role, content }) => ({ role, content })),
    newCount: cutIndex,
  };
}

/**
 * @deprecated Use getCompactionInput instead — it returns both the existing
 * summary and the messages to incorporate, for rolling compaction.
 */
export function getMessagesToSummarize(sessionId: string): { role: "user" | "assistant"; content: string }[] {
  return getCompactionInput(sessionId).newMessages;
}
