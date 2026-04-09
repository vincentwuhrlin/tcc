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
import { readdirSync, existsSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";

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
  _chunkToCategories = null;
  _categoryToChunks = null;
}

/** Return the currently loaded model name, or null. */
export function currentModel(): string | null {
  return _cacheModel;
}

// ── Category index ───────────────────────────────────────────────────
// Maps chunk IDs ↔ categories for Focus mode.
// Built at startup by scanning chunk frontmatters on disk.

let _chunkToCategories: Map<string, string[]> | null = null;
let _categoryToChunks: Map<string, Set<string>> | null = null;

/**
 * Build category index from chunk frontmatters on disk.
 * Scans all .md files in documents/chunks/ and videos/chunks/ for YAML
 * frontmatter with `chunk_categories` or `categories` fields.
 *
 * @param outputDir — absolute path to media/output/ in the workspace
 *                   (chunks live in {outputDir}/documents/chunks/ and
 *                   {outputDir}/videos/chunks/)
 */
export function buildCategoryIndex(outputDir: string): { categories: number; chunks: number } {
  _chunkToCategories = new Map();
  _categoryToChunks = new Map();

  if (!existsSync(outputDir)) {
    return { categories: 0, chunks: 0 };
  }

  // Scan both documents/chunks and videos/chunks
  for (const sub of ["documents", "videos"]) {
    const chunksDir = join(outputDir, sub, "chunks");
    if (!existsSync(chunksDir)) continue;

    const files = readdirSync(chunksDir).filter((f) => f.endsWith(".md"));

    for (const file of files) {
      try {
        // Read only first 2KB — frontmatter is always at the top
        const fd = openSync(join(chunksDir, file), "r");
        const buf = Buffer.alloc(2048);
        const bytesRead = readSync(fd, buf, 0, 2048, 0);
        closeSync(fd);
        const head = buf.toString("utf-8", 0, bytesRead);

        const fmMatch = head.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        // Parse categories from YAML frontmatter
        const cats: string[] = [];
        let inCats = false;
        for (const line of fmMatch[1].split("\n")) {
          if (/^(chunk_categories|categories):/.test(line)) {
            inCats = true;
            continue;
          }
          if (inCats && /^\s+-\s/.test(line)) {
            const val = line.replace(/^\s+-\s*"?/, "").replace(/"?\s*$/, "").trim();
            if (val) cats.push(val);
          } else if (inCats && /^\w/.test(line)) {
            inCats = false;
          }
        }

        if (cats.length === 0) continue;

        // Chunk ID matches the format used by embed.ts: "{sub}/chunks/{filename}"
        const chunkId = `${sub}/chunks/${file}`;
        _chunkToCategories.set(chunkId, cats);

        for (const cat of cats) {
          if (!_categoryToChunks.has(cat)) {
            _categoryToChunks.set(cat, new Set());
          }
          _categoryToChunks.get(cat)!.add(chunkId);
        }
      } catch { /* skip unreadable files */ }
    }
  }

  return { categories: _categoryToChunks.size, chunks: _chunkToCategories.size };
}

/**
 * Get all embeddings for the given category codes.
 * Returns chunks sorted by source name for consistent ordering.
 */
export function getChunksByCategories(categoryCodes: string[]): SearchResult[] {
  if (!_cache || !_categoryToChunks) return [];

  // Collect all chunk IDs matching any of the requested categories
  const matchingIds = new Set<string>();
  for (const code of categoryCodes) {
    // Match exact code and all sub-categories (e.g. "B" matches "B.1", "B.2", etc.)
    for (const [cat, ids] of _categoryToChunks) {
      if (cat === code || cat.startsWith(code + ".") || cat.charAt(0) === code) {
        for (const id of ids) matchingIds.add(id);
      }
    }
  }

  // Find matching embeddings
  const results: SearchResult[] = [];
  for (const emb of _cache) {
    if (matchingIds.has(emb.id)) {
      results.push({
        id: emb.id,
        source: emb.source,
        content: emb.content,
        score: 1.0, // Not from similarity search — score = 1 means "full category match"
      });
    }
  }

  results.sort((a, b) => a.source.localeCompare(b.source));
  return results;
}

/**
 * Extract unique main categories (letter-level) from search results.
 * Uses the category index to look up each chunk's categories.
 * Returns sorted array of unique main category codes with their full names.
 */
export function extractCategoriesFromResults(
  results: SearchResult[],
  planHeaders: string,
): { code: string; name: string; chunkCount: number }[] {
  if (!_chunkToCategories || !_categoryToChunks) return [];

  // Collect all categories from the result chunks
  const mainCatCounts = new Map<string, number>();
  for (const r of results) {
    const cats = _chunkToCategories.get(r.id);
    if (!cats) continue;
    for (const cat of cats) {
      // Extract main category letter: "B.1" → "B", "C.5" → "C"
      const main = cat.charAt(0);
      mainCatCounts.set(main, (mainCatCounts.get(main) ?? 0) + 1);
    }
  }

  // Build lookup from plan headers: "A. Platform Overview..." → { code: "A", name: "Platform Overview..." }
  const planLookup = new Map<string, string>();
  for (const line of planHeaders.split("\n")) {
    const m = line.trim().match(/^([A-Z])[\.\s]+(.+)/);
    if (m) planLookup.set(m[1], m[2].trim());
  }

  // Build result
  const cats = [...mainCatCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, chunkCount]) => ({
      code,
      name: planLookup.get(code) ?? code,
      chunkCount: _categoryToChunks
        ? [...(_categoryToChunks.entries())]
            .filter(([cat]) => cat.charAt(0) === code)
            .reduce((sum, [, ids]) => sum + ids.size, 0)
        : chunkCount,
    }));

  return cats;
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
