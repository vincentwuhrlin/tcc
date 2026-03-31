/**
 * rag — Vector search and context assembly for RAG chat.
 *
 * Loads embeddings from SQLite into memory, computes cosine similarity
 * against a query vector, and returns the top-K most relevant chunks.
 *
 * Performance: cosine similarity on 5 700 vectors × 768 dims < 15ms.
 */
import { loadEmbeddings, type StoredEmbedding } from "./db.js";
import { CHAT_MIN_SCORE } from "../config.js";

// ── Cosine similarity ───────────────────────────────────────────────

/** Cosine similarity between two vectors. Returns value in [-1, 1]. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Search result ───────────────────────────────────────────────────

export interface SearchResult {
  id: string;
  source: string;
  content: string;
  score: number;
}

// ── In-memory index ─────────────────────────────────────────────────

let _cache: StoredEmbedding[] | null = null;
let _cacheModel: string | null = null;

/** Load embeddings into memory (cached). Call once at chat startup. */
export function loadIndex(model: string): number {
  _cache = loadEmbeddings(model);
  _cacheModel = model;
  return _cache.length;
}

/** Clear the in-memory cache (e.g. after re-indexing). */
export function clearIndex(): void {
  _cache = null;
  _cacheModel = null;
}

/** Return the currently loaded model name, or null. */
export function currentModel(): string | null {
  return _cacheModel;
}

/**
 * Search for the top-K most similar chunks to a query vector.
 * The index must be loaded first via loadIndex().
 *
 * Chunks with a score below `minScore` are excluded (default: CHAT_MIN_SCORE).
 */
export function searchChunks(
  queryVector: number[],
  topK: number = 20,
  minScore: number = CHAT_MIN_SCORE,
): SearchResult[] {
  if (!_cache || _cache.length === 0) {
    throw new Error("No embeddings loaded. Call loadIndex() first.");
  }

  const scored = _cache.map((emb) => ({
    id: emb.id,
    source: emb.source,
    content: emb.content,
    score: cosineSimilarity(queryVector, emb.vector),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter((r) => r.score >= minScore)
    .slice(0, topK);
}

/**
 * Assemble RAG context from search results.
 * Returns a formatted string ready to inject into the system prompt.
 */
export function assembleContext(results: SearchResult[], maxChars: number = 80_000): string {
  const parts: string[] = [];
  let totalChars = 0;

  for (const r of results) {
    const entry = `### [${r.source}] (relevance: ${(r.score * 100).toFixed(0)}%)\n\n${r.content}`;
    if (totalChars + entry.length > maxChars) break;
    parts.push(entry);
    totalChars += entry.length;
  }

  return parts.join("\n\n---\n\n");
}
