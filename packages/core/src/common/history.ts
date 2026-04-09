/**
 * Semantic history search — embeds chat messages and provides cosine search.
 *
 * Architecture mirrors rag.ts but for messages instead of document chunks:
 *   - In-memory index loaded at startup via loadMessageIndex()
 *   - Per-message embedding stored in DB (message_embeddings table)
 *   - searchMessages() does cosine similarity over the in-memory vectors
 *   - embedAndStoreMessage() embeds + persists a single message (called after addMessage)
 *
 * Messages shorter than MIN_CHARS are skipped (too short to embed meaningfully).
 */
import { cosineSimilarity } from "./rag.js";
import {
  loadAllMessageEmbeddings,
  upsertMessageEmbedding,
  getMessagesWithSession,
  type MessageEmbeddingRow,
  type MessageWithSession,
} from "./db.js";
import { getChatEmbedEngine } from "./embed/index.js";

// ── Config ──────────────────────────────────────────────────────────

/** Skip embedding messages shorter than this — too noisy to be useful. */
const MIN_CHARS = 30;

// ── In-memory index ─────────────────────────────────────────────────

interface IndexedMessage {
  messageId: number;
  vector: number[];
}

let _index: IndexedMessage[] | null = null;
let _indexModel: string | null = null;

/** Load all message embeddings for the given model into memory. */
export function loadMessageIndex(model: string): number {
  const rows = loadAllMessageEmbeddings(model);
  _index = rows.map((r: MessageEmbeddingRow) => ({
    messageId: r.messageId,
    vector: r.vector,
  }));
  _indexModel = model;
  return _index.length;
}

/** Clear the in-memory index (called on workspace switch). */
export function clearMessageIndex(): void {
  _index = null;
  _indexModel = null;
}

/** Number of messages currently indexed in memory. */
export function messageIndexSize(): number {
  return _index?.length ?? 0;
}

/** Append a single embedding to the in-memory index (after a new message is embedded). */
export function addToMessageIndex(messageId: number, vector: number[]): void {
  if (!_index) _index = [];
  // Replace if already exists (re-embed case)
  const existing = _index.findIndex((m) => m.messageId === messageId);
  if (existing >= 0) {
    _index[existing] = { messageId, vector };
  } else {
    _index.push({ messageId, vector });
  }
}

// ── Search ──────────────────────────────────────────────────────────

export interface HistorySearchResult {
  messageId: number;
  sessionId: string;
  sessionTitle: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  score: number;
}

/**
 * Search the in-memory message index by cosine similarity.
 * Hydrates the top results with session metadata in a single DB query.
 */
export function searchMessages(
  queryVector: number[],
  limit: number = 20,
  minScore: number = 0.3,
): HistorySearchResult[] {
  if (!_index || _index.length === 0) return [];

  // Score every message
  const scored = _index.map((m) => ({
    messageId: m.messageId,
    score: cosineSimilarity(queryVector, m.vector),
  }));

  // Filter + sort + cap
  const top = scored
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (top.length === 0) return [];

  // Hydrate with session info
  const ids = top.map((t) => t.messageId);
  const messages = getMessagesWithSession(ids);
  const byId = new Map(messages.map((m: MessageWithSession) => [m.id, m]));

  return top
    .map((t) => {
      const msg = byId.get(t.messageId);
      if (!msg) return null;
      return {
        messageId: msg.id,
        sessionId: msg.sessionId,
        sessionTitle: msg.sessionTitle,
        role: msg.role,
        content: msg.content,
        createdAt: msg.createdAt,
        score: t.score,
      };
    })
    .filter((r): r is HistorySearchResult => r !== null);
}

// ── Embed and store ─────────────────────────────────────────────────

/**
 * Embed a single message and persist it (DB + in-memory index).
 * Skips short messages. Fire-and-forget friendly — catches its own errors.
 */
export async function embedAndStoreMessage(messageId: number, content: string): Promise<boolean> {
  if (!content || content.length < MIN_CHARS) return false;

  try {
    const engine = await getChatEmbedEngine();
    const info = engine.info();
    const vector = await engine.embedQuery(content);
    upsertMessageEmbedding(messageId, vector, info.model);
    addToMessageIndex(messageId, vector);
    return true;
  } catch (err) {
    console.error(`⚠️  embedAndStoreMessage(${messageId}) failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// ── Backfill ────────────────────────────────────────────────────────

/**
 * Backfill embeddings for all existing messages that don't yet have one.
 * Useful when enabling history search on an existing workspace with prior conversations.
 * Returns the number of messages embedded.
 */
export async function backfillMessageEmbeddings(
  model: string,
  getAllMessages: () => { id: number; content: string }[],
): Promise<{ embedded: number; skipped: number }> {
  // Load existing embeddings to know what to skip
  const existing = new Set(loadAllMessageEmbeddings(model).map((r) => r.messageId));
  const all = getAllMessages();

  let embedded = 0;
  let skipped = 0;
  const t0 = Date.now();

  for (const msg of all) {
    if (existing.has(msg.id)) {
      skipped++;
      continue;
    }
    if (!msg.content || msg.content.length < MIN_CHARS) {
      skipped++;
      continue;
    }
    const ok = await embedAndStoreMessage(msg.id, msg.content);
    if (ok) embedded++;
    else skipped++;
  }

  console.log(`  🧠 History backfill: ${embedded} embedded, ${skipped} skipped in ${Date.now() - t0}ms`);
  return { embedded, skipped };
}
