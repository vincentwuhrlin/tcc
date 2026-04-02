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

// ── Deep Search ──────────────────────────────────────────────────────
// Multi-pass retrieval: LLM generates sub-queries → embed each → search → deduplicate

export interface DeepSearchDebug {
  enabled: boolean;
  subQueries: string[];
  pass1Count: number;
  pass2Count: number;
  mergedCount: number;
  deduped: number;
  timings: { subQueryGenMs: number; pass2EmbedMs: number; pass2SearchMs: number; totalMs: number };
}

const SUB_QUERY_SYSTEM = `You generate search sub-queries for a RAG knowledge base about industrial automation (NAMUR Open Architecture, IEC 62443, data diodes, OPC UA, MTP).

Given a user question and a list of sources already found, generate 3-5 additional search queries that would find MISSING information. Focus on:
- Specific vendor names, product models, or standards not yet covered
- Related technical concepts the user likely needs
- Concrete implementation details, test results, or certifications

Return ONLY a JSON array of strings, no markdown, no explanation. Example:
["genua cyber-diode OPC UA interoperability", "Waterfall NOA test results", "IEC 62443 SL3 hardware certification"]`;

/**
 * Deep search: generate sub-queries via LLM, embed each, search, merge with pass 1 results.
 */
export async function deepSearch(
  originalQuery: string,
  pass1Results: SearchResult[],
  embedFn: (text: string) => Promise<number[]>,
  llmFn: (system: string, user: string, maxTokens: number) => Promise<string>,
  topK: number,
  minScore: number,
): Promise<{ results: SearchResult[]; debug: DeepSearchDebug }> {
  const t0 = Date.now();
  const debug: DeepSearchDebug = {
    enabled: true,
    subQueries: [],
    pass1Count: pass1Results.length,
    pass2Count: 0,
    mergedCount: 0,
    deduped: 0,
    timings: { subQueryGenMs: 0, pass2EmbedMs: 0, pass2SearchMs: 0, totalMs: 0 },
  };

  // Step 1: Generate sub-queries
  const existingSources = [...new Set(pass1Results.map((r) => r.source))].slice(0, 10).join(", ");
  const userPrompt = `Question: "${originalQuery}"

Sources already found (${pass1Results.length} chunks): ${existingSources}

Generate 3-5 sub-queries to find MISSING information. Return ONLY a JSON array of strings.`;

  const tq = Date.now();
  let subQueries: string[] = [];
  try {
    const raw = await llmFn(SUB_QUERY_SYSTEM, userPrompt, 512);
    const cleaned = raw.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      subQueries = parsed.filter((q: unknown) => typeof q === "string" && q.length > 5).slice(0, 5);
    }
  } catch {
    // If LLM fails to produce valid JSON, fall back to no deep search
    debug.timings.totalMs = Date.now() - t0;
    return { results: pass1Results, debug };
  }
  debug.subQueries = subQueries;
  debug.timings.subQueryGenMs = Date.now() - tq;

  if (subQueries.length === 0) {
    debug.timings.totalMs = Date.now() - t0;
    return { results: pass1Results, debug };
  }

  // Step 2: Embed and search each sub-query
  const pass1Ids = new Set(pass1Results.map((r) => r.id));
  const allNewResults: SearchResult[] = [];

  const te = Date.now();
  const subQueryVectors: number[][] = [];
  for (const sq of subQueries) {
    subQueryVectors.push(await embedFn(sq));
  }
  debug.timings.pass2EmbedMs = Date.now() - te;

  const ts = Date.now();
  for (const vec of subQueryVectors) {
    const results = searchChunks(vec, topK, minScore);
    for (const r of results) {
      if (!pass1Ids.has(r.id)) {
        allNewResults.push(r);
      }
    }
  }
  debug.timings.pass2SearchMs = Date.now() - ts;
  debug.pass2Count = allNewResults.length;

  // Step 3: Deduplicate new results (keep highest score per chunk)
  const bestByChunk = new Map<string, SearchResult>();
  for (const r of allNewResults) {
    const existing = bestByChunk.get(r.id);
    if (!existing || r.score > existing.score) {
      bestByChunk.set(r.id, r);
    }
  }

  const dedupedNew = [...bestByChunk.values()];
  debug.deduped = allNewResults.length - dedupedNew.length;

  // Step 4: Merge pass 1 + pass 2, sort by score
  const merged = [...pass1Results, ...dedupedNew];
  merged.sort((a, b) => b.score - a.score);
  debug.mergedCount = merged.length;

  debug.timings.totalMs = Date.now() - t0;
  return { results: merged, debug };
}
