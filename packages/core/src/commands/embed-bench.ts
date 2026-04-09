/**
 * embed-bench — Benchmark embedding engines for RAG retrieval quality.
 *
 * Three phases:
 *   1. GENERATE — Sample chunks → Claude generates search queries → bench_queries.json
 *   2. EVALUATE — For each engine: embed query → search → measure recall/MRR/latency
 *   3. REPORT  → BENCH.md + BENCH.xlsx (5 sheets with full per-query results)
 *
 * Flags:
 *   --generate          Force regenerate queries (even if bench_queries.json exists)
 *   --count=N           Number of standard queries (default 500)
 *   --no-hard           Disable hard queries
 *   --hard-count=N      Hard queries to generate (default 100)
 *   --hard-clusters=N   Similar-chunk clusters to find (default 30)
 *   --engines=a,b       Engines to benchmark (default: all with embeddings in DB)
 *   --top-k=5,10,20     K values for recall/precision (default: 5,10,20)
 *   --dry-run           Show plan without running
 *
 * Usage:
 *   npm run media:embed:bench
 *   npm run media:embed:bench -- --engines=nomic-uptimize,jina-local
 *   npm run media:embed:bench -- --generate --count=800 --hard-count=200
 *   npm run media:embed:bench -- --no-hard
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import ExcelJS from "exceljs";
import {
  WORKSPACE, OUTPUT_DIR, printHeader,
  type EmbedEngineType,
} from "../config.js";
import { llmCall, isQuotaError, logQuotaStop } from "../common/llm.js";
import { getDb, loadEmbeddings, type StoredEmbedding } from "../common/db.js";
import { cosineSimilarity } from "../common/rag.js";
import type { EmbedEngine } from "../common/embed/types.js";

// ── Constants ────────────────────────────────────────────────────────

const BENCH_QUERIES_FILE = join(WORKSPACE, "bench_queries.json");
const BENCH_MD_FILE = join(WORKSPACE, "BENCH.md");
const BENCH_XLSX_FILE = join(WORKSPACE, "BENCH.xlsx");

const DEFAULT_K_VALUES = [5, 10, 20];

const CHUNKS_PER_LLM_CALL = 5;
const QUERIES_PER_CHUNK = 3;
const CONTENT_MAX_CHARS = 2500;
const HARD_SIMILARITY_THRESHOLD = 0.82;
const HARD_CLUSTER_SIZE = 4;

// ── Types ────────────────────────────────────────────────────────────

type QueryDifficulty = "standard" | "hard";

interface BenchQuery {
  id: string;
  query: string;
  expected_chunk_id: string;
  source: string;
  difficulty: QueryDifficulty;
}

interface BenchQueriesFile {
  generated_at: string;
  count: number;
  standard_count: number;
  hard_count: number;
  queries: BenchQuery[];
}

/** One row per (query × engine) — the raw data for the Results sheet */
interface QueryResult {
  query_id: string;
  query: string;
  expected_chunk_id: string;
  source: string;
  difficulty: QueryDifficulty;
  engine: string;
  rank: number | null;
  top1_chunk_id: string;
  top1_score: number;
  expected_score: number | null;
  latency_ms: number;
  hit_at_5: boolean;
  hit_at_10: boolean;
  hit_at_20: boolean;
}

interface EngineMetrics {
  engine: string;
  model: string;
  dimensions: number;
  mode: string;
  embeddings_count: number;
  recall: Record<number, number>;
  mrr: Record<number, number>;
  recall_standard: Record<number, number>;
  mrr_standard: Record<number, number>;
  recall_hard: Record<number, number>;
  mrr_hard: Record<number, number>;
  avg_query_ms: number;
  p50_ms: number;
  p95_ms: number;
  total_time_s: number;
}

interface BenchmarkResult {
  metrics: EngineMetrics[];
  queryResults: QueryResult[];
}

// ── CLI parsing ──────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(3);
  return {
    forceGenerate: args.includes("--generate"),
    dryRun: args.includes("--dry-run"),
    enableHard: !args.includes("--no-hard"),
    count: parseInt(args.find((a) => a.startsWith("--count="))?.split("=")[1] ?? "500", 10),
    hardCount: parseInt(args.find((a) => a.startsWith("--hard-count="))?.split("=")[1] ?? "100", 10),
    hardClusters: parseInt(args.find((a) => a.startsWith("--hard-clusters="))?.split("=")[1] ?? "30", 10),
    engines: args.find((a) => a.startsWith("--engines="))?.split("=")[1]
      ?.split(/[,\s]+/).map((e) => e.trim()).filter(Boolean) as EmbedEngineType[] | undefined ?? null,
    topK: args.find((a) => a.startsWith("--top-k="))?.split("=")[1]
      ?.split(/[,\s]+/).map((k) => parseInt(k.trim(), 10)).filter(Boolean) ?? DEFAULT_K_VALUES,
  };
}

// ── Engine factory (bypasses singleton) ──────────────────────────────

async function createEngine(name: EmbedEngineType, dtype?: string): Promise<EmbedEngine> {
  switch (name) {
    case "nomic-uptimize": {
      const { UptimizeNomicEngine } = await import("../common/embed/provider-nomic-uptimize.js");
      return new UptimizeNomicEngine();
    }
    case "nomic-local": {
      const { LocalNomicEngine } = await import("../common/embed/provider-nomic-local.js");
      return new LocalNomicEngine(dtype);
    }
    case "jina-local": {
      const { LocalJinaEngine } = await import("../common/embed/provider-jina-local.js");
      return new LocalJinaEngine(dtype);
    }
    default:
      throw new Error(`Unknown engine: ${name}`);
  }
}

// ── Detect available engines from DB ─────────────────────────────────

/** Model prefix → engine type mapping. Handles both old and new model names. */
const MODEL_PREFIXES: { prefix: string; engine: EmbedEngineType }[] = [
  { prefix: "nomic-embed-text-v1.5", engine: "nomic-local" },   // must be before v1
  { prefix: "nomic-embed-text-v1",   engine: "nomic-uptimize" },
  { prefix: "jina-embeddings-v3",    engine: "jina-local" },
];

interface DetectedEngine {
  engine: EmbedEngineType;
  model: string;
  dtype: string | null;  // null for API engines (no dtype)
  count: number;
}

function detectEngines(): DetectedEngine[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT model, COUNT(*) as cnt FROM embeddings GROUP BY model",
  ).all() as { model: string; cnt: number }[];

  const results: DetectedEngine[] = [];

  for (const row of rows) {
    const match = MODEL_PREFIXES.find((p) => row.model.startsWith(p.prefix));
    if (!match) continue;

    // Extract dtype suffix: "nomic-embed-text-v1.5-fp16" → "fp16"
    const suffix = row.model.slice(match.prefix.length);
    const dtype = suffix.startsWith("-") ? suffix.slice(1) : null;

    results.push({
      engine: match.engine,
      model: row.model,
      dtype,
      count: row.cnt,
    });
  }

  return results;
}

// ── Helpers ──────────────────────────────────────────────────────────

function shuffleAndPick<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function truncateContent(content: string): string {
  return content.length <= CONTENT_MAX_CHARS
    ? content
    : content.slice(0, CONTENT_MAX_CHARS) + "\n[…truncated…]";
}

/**
 * Extract JSON from an LLM response that may contain preamble text.
 * Handles: markdown fences, "Looking at..." preamble, "[ID: ..." false starts,
 * trailing text after JSON, etc.
 *
 * Strategy: find all { and [ positions, try JSON.parse from each until one works.
 */
function extractJson(raw: string): string {
  // Strip markdown fences first
  const text = raw.replace(/```json\s*|```\s*/g, "").trim();

  // Collect all potential JSON start positions
  const candidates: { pos: number; endChar: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") candidates.push({ pos: i, endChar: "}" });
    else if (text[i] === "[") candidates.push({ pos: i, endChar: "]" });
  }

  if (candidates.length === 0) {
    throw new Error(`No JSON found in LLM response: ${text.slice(0, 100)}...`);
  }

  // Try each candidate: slice from start to last matching bracket, try to parse
  for (const { pos, endChar } of candidates) {
    const lastEnd = text.lastIndexOf(endChar);
    if (lastEnd <= pos) continue;

    const slice = text.slice(pos, lastEnd + 1);
    try {
      JSON.parse(slice);
      return slice; // Valid JSON found
    } catch {
      // Not valid JSON from this position, try next candidate
    }
  }

  throw new Error(`Could not extract valid JSON from LLM response: ${text.slice(0, 150)}...`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Phase 1a: Standard query generation ──────────────────────────────

async function generateStandardQueries(
  allEmbeddings: StoredEmbedding[], targetCount: number,
): Promise<BenchQuery[]> {
  console.log(`\n   📝 Standard queries (${QUERIES_PER_CHUNK} per chunk)`);

  const chunksNeeded = Math.ceil(targetCount / QUERIES_PER_CHUNK);
  const sampled = shuffleAndPick(allEmbeddings, Math.min(chunksNeeded, allEmbeddings.length));
  const totalBatches = Math.ceil(sampled.length / CHUNKS_PER_LLM_CALL);

  console.log(`      Sampled ${sampled.length} chunks → ~${sampled.length * QUERIES_PER_CHUNK} queries`);
  console.log(`      LLM calls: ${totalBatches} (${CHUNKS_PER_LLM_CALL} chunks/batch)`);

  const queries: BenchQuery[] = [];
  let batchIdx = 0;

  for (let i = 0; i < sampled.length; i += CHUNKS_PER_LLM_CALL) {
    const batch = sampled.slice(i, i + CHUNKS_PER_LLM_CALL);
    batchIdx++;
    process.stdout.write(`\r      ⏳ Batch ${batchIdx}/${totalBatches} (${Math.round((batchIdx / totalBatches) * 100)}%) — ${queries.length} queries`);

    try {
      queries.push(...await generateStandardBatch(batch));
    } catch (err) {
      console.error(`\n      ⚠️  Batch ${batchIdx} failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      if (isQuotaError(err)) { logQuotaStop("query generation", queries.length); break; }
    }
    if (queries.length >= targetCount) break;
  }

  const final = queries.slice(0, targetCount);
  console.log(`\n      ✅ ${final.length} standard queries`);
  return final;
}

async function generateStandardBatch(chunks: StoredEmbedding[]): Promise<BenchQuery[]> {
  const systemPrompt = `You are a benchmark query generator for a RAG system.
Given document chunks, generate realistic search queries a user would type to find the information.

Rules:
- Generate exactly ${QUERIES_PER_CHUNK} queries per chunk
- Mix styles: full questions, keyword phrases, how-to queries
- Queries must be specific enough that the chunk would be the best answer
- Same language as chunk content
- Return ONLY valid JSON, no markdown fences

Output: [{ "chunk_id": "<id>", "queries": ["q1", "q2", "q3"] }, ...]`;

  const payload = chunks.map((c) => ({
    id: c.id, source: c.source, content: truncateContent(c.content),
  }));

  const { text: response } = await llmCall(systemPrompt,
    `Generate ${QUERIES_PER_CHUNK} search queries for each of these ${chunks.length} chunks:\n\n${JSON.stringify(payload, null, 2)}`, 2048,
    undefined, { sessionId: null, kind: "embed_bench" });

  const parsed = JSON.parse(extractJson(response)) as
    { chunk_id: string; queries: string[] }[];

  const queries: BenchQuery[] = [];
  for (const entry of parsed) {
    const chunk = chunks.find((c) => c.id === entry.chunk_id);
    if (!chunk) continue;
    for (let qi = 0; qi < entry.queries.length; qi++) {
      queries.push({
        id: `${entry.chunk_id}__q${qi + 1}`,
        query: entry.queries[qi],
        expected_chunk_id: entry.chunk_id,
        source: chunk.source,
        difficulty: "standard",
      });
    }
  }
  return queries;
}

// ── Phase 1b: Hard query generation ──────────────────────────────────

interface ChunkCluster {
  target: StoredEmbedding;
  distractors: StoredEmbedding[];
  avg_similarity: number;
}

async function generateHardQueries(
  allEmbeddings: StoredEmbedding[], targetCount: number, numClusters: number,
): Promise<BenchQuery[]> {
  console.log(`\n   🔥 Hard queries (discriminating between similar chunks)`);
  console.log(`      Similarity threshold: ${HARD_SIMILARITY_THRESHOLD} | Cluster size: ${HARD_CLUSTER_SIZE}`);

  console.log(`      Finding ${numClusters} clusters...`);
  const clusters = findSimilarClusters(allEmbeddings, numClusters, HARD_CLUSTER_SIZE);

  if (clusters.length === 0) {
    console.log(`      ⚠️  No clusters found (threshold ${HARD_SIMILARITY_THRESHOLD} may be too high). Skipping.`);
    return [];
  }

  const avgSim = (clusters.reduce((s, c) => s + c.avg_similarity, 0) / clusters.length).toFixed(3);
  console.log(`      Found ${clusters.length} clusters (avg similarity: ${avgSim})`);

  const qPerCluster = Math.ceil(targetCount / clusters.length);
  const queries: BenchQuery[] = [];

  for (let ci = 0; ci < clusters.length; ci++) {
    process.stdout.write(`\r      ⏳ Cluster ${ci + 1}/${clusters.length} (${Math.round(((ci + 1) / clusters.length) * 100)}%) — ${queries.length} hard queries`);
    try {
      queries.push(...await generateHardBatch(clusters[ci], qPerCluster));
    } catch (err) {
      console.error(`\n      ⚠️  Cluster ${ci + 1} failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      if (isQuotaError(err)) { logQuotaStop("hard query generation", queries.length); break; }
    }
    if (queries.length >= targetCount) break;
  }

  const final = queries.slice(0, targetCount);
  console.log(`\n      ✅ ${final.length} hard queries`);
  return final;
}

function findSimilarClusters(
  embeddings: StoredEmbedding[], numClusters: number, clusterSize: number,
): ChunkCluster[] {
  const clusters: ChunkCluster[] = [];
  const usedIds = new Set<string>();
  const shuffled = shuffleAndPick(embeddings, embeddings.length);

  for (const target of shuffled) {
    if (clusters.length >= numClusters || usedIds.has(target.id)) continue;

    const sims: { emb: StoredEmbedding; sim: number }[] = [];
    for (const other of embeddings) {
      if (other.id === target.id || usedIds.has(other.id)) continue;
      const sim = cosineSimilarity(target.vector, other.vector);
      if (sim >= HARD_SIMILARITY_THRESHOLD) sims.push({ emb: other, sim });
    }

    if (sims.length < clusterSize - 1) continue;

    sims.sort((a, b) => b.sim - a.sim);
    const distractors = sims.slice(0, clusterSize - 1).map((s) => s.emb);
    const avgSim = sims.slice(0, clusterSize - 1).reduce((s, x) => s + x.sim, 0) / (clusterSize - 1);

    clusters.push({ target, distractors, avg_similarity: avgSim });
    usedIds.add(target.id);
    for (const d of distractors) usedIds.add(d.id);
  }

  return clusters.sort((a, b) => b.avg_similarity - a.avg_similarity);
}

async function generateHardBatch(cluster: ChunkCluster, count: number): Promise<BenchQuery[]> {
  const allChunks = [cluster.target, ...cluster.distractors];

  const systemPrompt = `You are generating HARD benchmark queries for a RAG system.
You have ${allChunks.length} chunks that are VERY similar (cosine ~${cluster.avg_similarity.toFixed(2)}).
Generate ${count} queries where ONLY the TARGET (id="${cluster.target.id}") answers correctly — NOT the distractors.
Exploit unique details: dates, numbers, names, technical specifics only in the target.
Same language as content. Return ONLY valid JSON:
{ "target_id": "${cluster.target.id}", "queries": ["q1", ...] }`;

  const payload = allChunks.map((c, i) => ({
    role: i === 0 ? "TARGET" : `DISTRACTOR_${i}`,
    id: c.id, source: c.source, content: truncateContent(c.content),
  }));

  const { text: response } = await llmCall(systemPrompt,
    `Generate ${count} discriminating queries:\n\n${JSON.stringify(payload, null, 2)}`, 1024,
    undefined, { sessionId: null, kind: "embed_bench" });

  const parsed = JSON.parse(extractJson(response)) as
    { target_id: string; queries: string[] };

  return parsed.queries.map((q, qi) => ({
    id: `hard__${cluster.target.id}__q${qi + 1}`,
    query: q,
    expected_chunk_id: cluster.target.id,
    source: cluster.target.source,
    difficulty: "hard" as const,
  }));
}

// ── Phase 2: Run benchmark ───────────────────────────────────────────

function computeMetrics(ranks: (number | null)[], kValues: number[]) {
  const recall: Record<number, number> = {};
  const mrr: Record<number, number> = {};
  for (const k of kValues) {
    let hits = 0, rrSum = 0;
    for (const rank of ranks) {
      if (rank !== null && rank <= k) { hits++; rrSum += 1 / rank; }
    }
    recall[k] = ranks.length > 0 ? hits / ranks.length : 0;
    mrr[k] = ranks.length > 0 ? rrSum / ranks.length : 0;
  }
  return { recall, mrr };
}

async function runBenchmark(
  queries: BenchQuery[], engines: DetectedEngine[], topKValues: number[],
): Promise<BenchmarkResult> {
  console.log(`\n🏁 Phase 2: Running benchmark`);

  const stdCount = queries.filter((q) => q.difficulty === "standard").length;
  const hardCount = queries.filter((q) => q.difficulty === "hard").length;
  console.log(`   Queries:  ${queries.length} (${stdCount} standard + ${hardCount} hard)`);
  console.log(`   Models:   ${engines.map((e) => e.model).join(", ")}`);
  console.log(`   Top-K:    ${topKValues.join(", ")}`);

  const maxK = Math.max(...topKValues);
  const allMetrics: EngineMetrics[] = [];
  const allResults: QueryResult[] = [];

  for (const detected of engines) {
    const label = detected.dtype ? `${detected.engine} [${detected.dtype}]` : detected.engine;
    console.log(`\n── ${label} ${"─".repeat(Math.max(1, 50 - label.length))}`);

    let engine: EmbedEngine;
    try {
      engine = await createEngine(detected.engine, detected.dtype ?? undefined);
    } catch (err) {
      console.error(`   ❌ Could not create engine: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    const info = engine.info();
    console.log(`   Model:      ${info.model} (${info.dimensions}d, ${info.mode})`);

    // Load embeddings by the model name stored in DB
    const embeddings = loadEmbeddings(detected.model);
    if (embeddings.length === 0) {
      console.error(`   ❌ No embeddings for ${detected.model}.`);
      continue;
    }
    console.log(`   Embeddings: ${embeddings.length}`);

    const ranks: { rank: number | null; difficulty: QueryDifficulty }[] = [];
    const timings: number[] = [];
    const startTotal = Date.now();
    let evalErrors = 0;
    let lastEvalError = "";

    for (let qi = 0; qi < queries.length; qi++) {
      const q = queries[qi];
      process.stdout.write(`\r   ⏳ Query ${qi + 1}/${queries.length} (${Math.round(((qi + 1) / queries.length) * 100)}%)`);

      const startQ = Date.now();
      let rank: number | null = null;
      let top1Id = "";
      let top1Score = 0;
      let expectedScore: number | null = null;

      try {
        const queryVector = await engine.embedQuery(q.query);
        const scored = embeddings.map((emb) => ({
          id: emb.id,
          score: cosineSimilarity(queryVector, emb.vector),
        }));
        scored.sort((a, b) => b.score - a.score);

        top1Id = scored[0]?.id ?? "";
        top1Score = scored[0]?.score ?? 0;

        // Find rank of expected chunk (search in ALL results, not just topK)
        const expectedIdx = scored.findIndex((r) => r.id === q.expected_chunk_id);
        if (expectedIdx >= 0) {
          rank = expectedIdx + 1;
          expectedScore = scored[expectedIdx].score;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        evalErrors++;
        if (msg !== lastEvalError || evalErrors <= 3) {
          console.error(`\n   ❌ Query embed failed: ${msg.slice(0, 120)}`);
          lastEvalError = msg;
        }
        if (isQuotaError(err)) { logQuotaStop("benchmark evaluation", qi); break; }
      }

      const latency = Date.now() - startQ;
      timings.push(latency);
      ranks.push({ rank, difficulty: q.difficulty });

      allResults.push({
        query_id: q.id,
        query: q.query,
        expected_chunk_id: q.expected_chunk_id,
        source: q.source,
        difficulty: q.difficulty,
        engine: detected.model,
        rank,
        top1_chunk_id: top1Id,
        top1_score: Math.round(top1Score * 10000) / 10000,
        expected_score: expectedScore !== null ? Math.round(expectedScore * 10000) / 10000 : null,
        latency_ms: latency,
        hit_at_5: rank !== null && rank <= 5,
        hit_at_10: rank !== null && rank <= 10,
        hit_at_20: rank !== null && rank <= 20,
      });
    }

    const totalTime = (Date.now() - startTotal) / 1000;

    if (evalErrors > 0) {
      console.log(`\n   ⚠️  ${evalErrors} embedding errors during evaluation (results may be incomplete)`);
    }

    const allRankValues = ranks.map((r) => r.rank);
    const stdRanks = ranks.filter((r) => r.difficulty === "standard").map((r) => r.rank);
    const hardRanks = ranks.filter((r) => r.difficulty === "hard").map((r) => r.rank);

    const allM = computeMetrics(allRankValues, topKValues);
    const stdM = computeMetrics(stdRanks, topKValues);
    const hardM = computeMetrics(hardRanks, topKValues);

    const sortedTimings = [...timings].sort((a, b) => a - b);
    const avgMs = timings.length > 0 ? timings.reduce((a, b) => a + b, 0) / timings.length : 0;

    console.log(`\n   ✅ Done in ${totalTime.toFixed(1)}s (avg ${avgMs.toFixed(0)}ms, p50 ${percentile(sortedTimings, 50)}ms, p95 ${percentile(sortedTimings, 95)}ms)`);

    for (const k of topKValues) {
      let line = `   Recall@${k}: ${((allM.recall[k] ?? 0) * 100).toFixed(1)}%  MRR@${k}: ${((allM.mrr[k] ?? 0) * 100).toFixed(1)}%`;
      if (hardRanks.length > 0) line += `  (hard: ${((hardM.recall[k] ?? 0) * 100).toFixed(1)}%)`;
      console.log(line);
    }

    allMetrics.push({
      engine: detected.model, model: info.model, dimensions: info.dimensions,
      mode: info.mode, embeddings_count: embeddings.length,
      recall: allM.recall, mrr: allM.mrr,
      recall_standard: stdM.recall, mrr_standard: stdM.mrr,
      recall_hard: hardM.recall, mrr_hard: hardM.mrr,
      avg_query_ms: avgMs,
      p50_ms: percentile(sortedTimings, 50),
      p95_ms: percentile(sortedTimings, 95),
      total_time_s: totalTime,
    });
  }

  return { metrics: allMetrics, queryResults: allResults };
}

// ── Phase 3a: Markdown report ────────────────────────────────────────

function computeComposite(m: EngineMetrics, maxK: number, maxMs: number, hasHard: boolean): number {
  const speed = 1 - (m.avg_query_ms / maxMs);
  return hasHard
    ? (m.recall[maxK] ?? 0) * 0.40 + (m.mrr[maxK] ?? 0) * 0.20 + (m.recall_hard[maxK] ?? 0) * 0.25 + (m.mrr_hard[maxK] ?? 0) * 0.05 + speed * 0.10
    : (m.recall[maxK] ?? 0) * 0.60 + (m.mrr[maxK] ?? 0) * 0.30 + speed * 0.10;
}

function findBest(metrics: EngineMetrics[], k: number, field: keyof EngineMetrics) {
  let best: { engine: string; score: number } | null = null;
  for (const m of metrics) {
    const score = (m[field] as Record<number, number>)?.[k] ?? 0;
    if (!best || score > best.score) best = { engine: m.engine, score };
  }
  return best;
}

function generateMarkdownReport(
  metrics: EngineMetrics[], queries: BenchQuery[], topKValues: number[],
): string {
  const now = new Date().toISOString().split("T")[0];
  const stdCount = queries.filter((q) => q.difficulty === "standard").length;
  const hCount = queries.filter((q) => q.difficulty === "hard").length;
  const hasHard = hCount > 0;
  const maxK = topKValues[topKValues.length - 1];
  const maxMs = Math.max(...metrics.map((m) => m.avg_query_ms), 1);
  const L: string[] = [];

  L.push(`# Embedding Benchmark Report`, ``,
    `**Generated:** ${now}`,
    `**Queries:** ${queries.length} total (${stdCount} standard + ${hCount} hard)`,
    `**Engines:** ${metrics.length}`,
    `**K values:** ${topKValues.join(", ")}`, ``);

  // Summary
  L.push(`## Summary`, ``);
  const bestR = findBest(metrics, maxK, "recall");
  const bestM = findBest(metrics, maxK, "mrr");
  const bestS = [...metrics].sort((a, b) => a.avg_query_ms - b.avg_query_ms)[0];
  L.push(`| Criterion | Winner | Score |`, `|-----------|--------|-------|`);
  if (bestR) L.push(`| Best Recall@${maxK} | **${bestR.engine}** | ${(bestR.score * 100).toFixed(1)}% |`);
  if (bestM) L.push(`| Best MRR@${maxK} | **${bestM.engine}** | ${(bestM.score * 100).toFixed(1)}% |`);
  if (bestS) L.push(`| Fastest | **${bestS.engine}** | ${bestS.avg_query_ms.toFixed(0)}ms (p95: ${bestS.p95_ms}ms) |`);
  if (hasHard) {
    const bh = findBest(metrics, maxK, "recall_hard");
    if (bh) L.push(`| Best Hard Recall@${maxK} | **${bh.engine}** | ${(bh.score * 100).toFixed(1)}% |`);
  }
  L.push(``);

  // Reliability
  L.push(`## Reliability Score`, ``);
  L.push(hasHard
    ? `Composite: 40% Recall@${maxK} + 20% MRR@${maxK} + 25% Hard Recall@${maxK} + 5% Hard MRR@${maxK} + 10% Speed`
    : `Composite: 60% Recall@${maxK} + 30% MRR@${maxK} + 10% Speed`, ``);

  const scored = metrics.map((m) => ({ m, c: computeComposite(m, maxK, maxMs, hasHard) }))
    .sort((a, b) => b.c - a.c);

  if (hasHard) {
    L.push(`| Rank | Engine | Reliability | Recall@${maxK} | MRR@${maxK} | Hard R@${maxK} | Avg ms | p95 ms |`);
    L.push(`|------|--------|-------------|---|---|---|---|---|`);
    scored.forEach((s, i) => L.push(`| ${i + 1} | **${s.m.engine}** | ${(s.c * 100).toFixed(1)}% | ${((s.m.recall[maxK] ?? 0) * 100).toFixed(1)}% | ${((s.m.mrr[maxK] ?? 0) * 100).toFixed(1)}% | ${((s.m.recall_hard[maxK] ?? 0) * 100).toFixed(1)}% | ${s.m.avg_query_ms.toFixed(0)} | ${s.m.p95_ms} |`));
  } else {
    L.push(`| Rank | Engine | Reliability | Recall@${maxK} | MRR@${maxK} | Avg ms | p95 ms |`);
    L.push(`|------|--------|-------------|---|---|---|---|`);
    scored.forEach((s, i) => L.push(`| ${i + 1} | **${s.m.engine}** | ${(s.c * 100).toFixed(1)}% | ${((s.m.recall[maxK] ?? 0) * 100).toFixed(1)}% | ${((s.m.mrr[maxK] ?? 0) * 100).toFixed(1)}% | ${s.m.avg_query_ms.toFixed(0)} | ${s.m.p95_ms} |`));
  }
  L.push(``);

  // Detailed per K
  L.push(`## Detailed Metrics`, ``);
  for (const k of topKValues) {
    L.push(`### K = ${k}`, ``);
    if (hasHard) {
      L.push(`| Engine | Model | Dims | Recall@${k} | MRR@${k} | Std R | Hard R | Avg ms |`);
      L.push(`|--------|-------|------|---|---|---|---|---|`);
      for (const m of metrics)
        L.push(`| ${m.engine} | ${m.model} | ${m.dimensions} | ${((m.recall[k] ?? 0) * 100).toFixed(1)}% | ${((m.mrr[k] ?? 0) * 100).toFixed(1)}% | ${((m.recall_standard[k] ?? 0) * 100).toFixed(1)}% | ${((m.recall_hard[k] ?? 0) * 100).toFixed(1)}% | ${m.avg_query_ms.toFixed(0)} |`);
    } else {
      L.push(`| Engine | Model | Dims | Recall@${k} | MRR@${k} | Avg ms |`);
      L.push(`|--------|-------|------|---|---|---|`);
      for (const m of metrics)
        L.push(`| ${m.engine} | ${m.model} | ${m.dimensions} | ${((m.recall[k] ?? 0) * 100).toFixed(1)}% | ${((m.mrr[k] ?? 0) * 100).toFixed(1)}% | ${m.avg_query_ms.toFixed(0)} |`);
    }
    L.push(``);
  }

  // Methodology
  L.push(`## Methodology`, ``);
  L.push(`1. **Standard queries (${stdCount}):** ${QUERIES_PER_CHUNK}/chunk, content up to ${CONTENT_MAX_CHARS} chars.`);
  if (hasHard) L.push(`2. **Hard queries (${hCount}):** Discriminating between similar chunks (cosine ≥ ${HARD_SIMILARITY_THRESHOLD}).`);
  L.push(`${hasHard ? "3" : "2"}. **Metrics:** Recall@K (hit rate), MRR@K (mean reciprocal rank), Reliability (weighted composite).`);
  L.push(`${hasHard ? "4" : "3"}. **Timing:** End-to-end (embed query + search). Includes p50/p95 percentiles.`, ``);

  return L.join("\n");
}

// ── Phase 3b: Excel report ───────────────────────────────────────────

async function generateXlsxReport(
  metrics: EngineMetrics[], queries: BenchQuery[],
  queryResults: QueryResult[], topKValues: number[],
): Promise<void> {
  const maxK = topKValues[topKValues.length - 1];
  const maxMs = Math.max(...metrics.map((m) => m.avg_query_ms), 1);
  const hasHard = queries.some((q) => q.difficulty === "hard");

  const wb = new ExcelJS.Workbook();
  wb.creator = "TCC Embed Bench";
  wb.created = new Date();

  // ── Styles ──
  const headerFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } };
  const bestFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF92D050" } };
  const hardFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC000" } };
  const missFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF6B6B" } };
  const headerFont: Partial<ExcelJS.Font> = { name: "Arial", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  const dataFont: Partial<ExcelJS.Font> = { name: "Arial", size: 10 };
  const titleFont: Partial<ExcelJS.Font> = { name: "Arial", size: 14, bold: true };
  const pctFmt = "0.0%";

  function addHeaderRow(ws: ExcelJS.Worksheet, headers: string[], rowNum: number) {
    const row = ws.getRow(rowNum);
    headers.forEach((h, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = h;
      cell.font = headerFont;
      cell.fill = headerFill;
      cell.alignment = { horizontal: "center" };
    });
    row.commit();
  }

  // ── Sheet 1: Summary ──
  const ws1 = wb.addWorksheet("Summary");
  ws1.getCell("A1").value = "Embedding Benchmark Report";
  ws1.getCell("A1").font = titleFont;
  ws1.getCell("A2").value = `Generated: ${new Date().toISOString().split("T")[0]}`;
  ws1.getCell("A3").value = `Queries: ${queries.length} (${queries.filter((q) => q.difficulty === "standard").length} std + ${queries.filter((q) => q.difficulty === "hard").length} hard)`;

  const h1 = ["Engine", "Model", "Dims", "Mode", "Chunks", "Reliability %"];
  for (const k of topKValues) h1.push(`Recall@${k} %`, `MRR@${k} %`);
  if (hasHard) for (const k of topKValues) h1.push(`Hard R@${k} %`);
  h1.push("Avg ms", "p50 ms", "p95 ms", "Total s");

  addHeaderRow(ws1, h1, 5);

  const sorted = [...metrics].sort((a, b) =>
    computeComposite(b, maxK, maxMs, hasHard) - computeComposite(a, maxK, maxMs, hasHard));
  const bestRel = computeComposite(sorted[0], maxK, maxMs, hasHard);

  sorted.forEach((m, ei) => {
    const r = ws1.getRow(6 + ei);
    const vals: (string | number)[] = [
      m.engine, m.model, m.dimensions, m.mode, m.embeddings_count,
      Math.round(computeComposite(m, maxK, maxMs, hasHard) * 1000) / 10,
    ];
    for (const k of topKValues) {
      vals.push(Math.round((m.recall[k] ?? 0) * 1000) / 10);
      vals.push(Math.round((m.mrr[k] ?? 0) * 1000) / 10);
    }
    if (hasHard) for (const k of topKValues) vals.push(Math.round((m.recall_hard[k] ?? 0) * 1000) / 10);
    vals.push(Math.round(m.avg_query_ms), m.p50_ms, m.p95_ms, Math.round(m.total_time_s * 10) / 10);

    vals.forEach((v, ci) => {
      const cell = r.getCell(ci + 1);
      cell.value = v;
      cell.font = dataFont;
      cell.alignment = { horizontal: "center" };
    });

    if (computeComposite(m, maxK, maxMs, hasHard) === bestRel && sorted.length > 1) {
      vals.forEach((_, ci) => { r.getCell(ci + 1).fill = bestFill; });
    }
    r.commit();
  });

  h1.forEach((_, ci) => { ws1.getColumn(ci + 1).width = Math.max(h1[ci].length + 3, 12); });

  // ── Sheet 2: Standard vs Hard ──
  if (hasHard) {
    const ws2 = wb.addWorksheet("Standard vs Hard");
    let row = 1;

    ws2.getCell(`A${row}`).value = "Standard Queries";
    ws2.getCell(`A${row}`).font = { name: "Arial", size: 12, bold: true };
    row++;
    const h2 = ["Engine"];
    for (const k of topKValues) h2.push(`Recall@${k} %`, `MRR@${k} %`);
    addHeaderRow(ws2, h2, row);
    row++;
    for (const m of sorted) {
      const r = ws2.getRow(row);
      r.getCell(1).value = m.engine; r.getCell(1).font = dataFont;
      let ci = 2;
      for (const k of topKValues) {
        r.getCell(ci).value = Math.round((m.recall_standard[k] ?? 0) * 1000) / 10; r.getCell(ci).font = dataFont; ci++;
        r.getCell(ci).value = Math.round((m.mrr_standard[k] ?? 0) * 1000) / 10; r.getCell(ci).font = dataFont; ci++;
      }
      r.commit(); row++;
    }
    row++;
    ws2.getCell(`A${row}`).value = "Hard Queries";
    ws2.getCell(`A${row}`).font = { name: "Arial", size: 12, bold: true };
    ws2.getCell(`A${row}`).fill = hardFill;
    row++;
    addHeaderRow(ws2, h2, row);
    row++;
    for (const m of sorted) {
      const r = ws2.getRow(row);
      r.getCell(1).value = m.engine; r.getCell(1).font = dataFont;
      let ci = 2;
      for (const k of topKValues) {
        r.getCell(ci).value = Math.round((m.recall_hard[k] ?? 0) * 1000) / 10; r.getCell(ci).font = dataFont; ci++;
        r.getCell(ci).value = Math.round((m.mrr_hard[k] ?? 0) * 1000) / 10; r.getCell(ci).font = dataFont; ci++;
      }
      r.commit(); row++;
    }
    h2.forEach((_, ci) => { ws2.getColumn(ci + 1).width = 18; });
  }

  // ── Sheet 3: Queries (all generated queries) ──
  const ws3 = wb.addWorksheet("Queries");
  const h3 = ["#", "Query ID", "Query", "Expected Chunk", "Source", "Difficulty"];
  addHeaderRow(ws3, h3, 1);
  queries.forEach((q, qi) => {
    const r = ws3.getRow(qi + 2);
    [qi + 1, q.id, q.query, q.expected_chunk_id, q.source, q.difficulty].forEach((v, ci) => {
      const cell = r.getCell(ci + 1);
      cell.value = v;
      cell.font = dataFont;
    });
    if (q.difficulty === "hard") r.getCell(6).fill = hardFill;
    r.commit();
  });
  ws3.getColumn(1).width = 6;
  ws3.getColumn(2).width = 40;
  ws3.getColumn(3).width = 60;
  ws3.getColumn(4).width = 40;
  ws3.getColumn(5).width = 30;
  ws3.getColumn(6).width = 12;

  // ── Sheet 4: Results (per query × engine) ──
  const ws4 = wb.addWorksheet("Results");
  const h4 = ["Query ID", "Query", "Difficulty", "Engine", "Rank", "Hit@5", "Hit@10", "Hit@20",
    "Top1 Chunk", "Top1 Score", "Expected Score", "Latency ms"];
  addHeaderRow(ws4, h4, 1);

  queryResults.forEach((qr, ri) => {
    const r = ws4.getRow(ri + 2);
    const vals: (string | number | boolean | null)[] = [
      qr.query_id, qr.query, qr.difficulty, qr.engine,
      qr.rank ?? "MISS",
      qr.hit_at_5, qr.hit_at_10, qr.hit_at_20,
      qr.top1_chunk_id, qr.top1_score, qr.expected_score ?? "N/A", qr.latency_ms,
    ];
    vals.forEach((v, ci) => {
      const cell = r.getCell(ci + 1);
      cell.value = v as any;
      cell.font = dataFont;
      cell.alignment = { horizontal: "center" };
    });

    // Highlight misses in red
    if (qr.rank === null) {
      r.getCell(5).fill = missFill;
    }
    // Highlight hard queries
    if (qr.difficulty === "hard") {
      r.getCell(3).fill = hardFill;
    }
    r.commit();
  });

  ws4.getColumn(1).width = 35;
  ws4.getColumn(2).width = 50;
  ws4.getColumn(3).width = 10;
  ws4.getColumn(4).width = 18;
  ws4.getColumn(5).width = 8;
  ws4.getColumn(6).width = 8;
  ws4.getColumn(7).width = 8;
  ws4.getColumn(8).width = 8;
  ws4.getColumn(9).width = 35;
  ws4.getColumn(10).width = 12;
  ws4.getColumn(11).width = 12;
  ws4.getColumn(12).width = 10;

  // Enable auto-filter on Results
  ws4.autoFilter = { from: "A1", to: `L${queryResults.length + 1}` };

  // ── Sheet 5: Chart Data ──
  const ws5 = wb.addWorksheet("Chart Data");
  const h5 = ["Engine"];
  for (const k of topKValues) h5.push(`Recall@${k}`, `MRR@${k}`);
  if (hasHard) for (const k of topKValues) h5.push(`Hard R@${k}`);
  h5.push("Reliability %", "Avg ms", "p50 ms", "p95 ms");
  addHeaderRow(ws5, h5, 1);

  sorted.forEach((m, ei) => {
    const r = ws5.getRow(ei + 2);
    r.getCell(1).value = m.engine;
    let ci = 2;
    for (const k of topKValues) {
      r.getCell(ci++).value = Math.round((m.recall[k] ?? 0) * 1000) / 10;
      r.getCell(ci++).value = Math.round((m.mrr[k] ?? 0) * 1000) / 10;
    }
    if (hasHard) for (const k of topKValues) {
      r.getCell(ci++).value = Math.round((m.recall_hard[k] ?? 0) * 1000) / 10;
    }
    r.getCell(ci++).value = Math.round(computeComposite(m, maxK, maxMs, hasHard) * 1000) / 10;
    r.getCell(ci++).value = Math.round(m.avg_query_ms);
    r.getCell(ci++).value = m.p50_ms;
    r.getCell(ci++).value = m.p95_ms;
    r.commit();
  });

  await wb.xlsx.writeFile(BENCH_XLSX_FILE);
}

// ── Main ─────────────────────────────────────────────────────────────

export async function embedBench(): Promise<void> {
  printHeader();

  const { forceGenerate, dryRun, count, enableHard, hardCount, hardClusters, engines: requestedEngines, topK } = parseArgs();

  console.log(`📊 media:embed:bench — Embedding Retrieval Benchmark`);
  console.log(`   Workspace: ${WORKSPACE}`);

  const available = detectEngines();
  if (available.length === 0) {
    console.error("❌ No embeddings found in workspace.db. Run media:embed first.");
    process.exit(1);
  }

  console.log(`\n   Available engines in DB:`);
  for (const a of available) console.log(`     • ${a.engine} (${a.model}) — ${a.count} embeddings`);

  const engineNames = requestedEngines
    ? requestedEngines.filter((e) => available.some((a) => a.engine === e))
    : [...new Set(available.map((a) => a.engine))];

  // Filter available models by requested engine names
  const toBench = available.filter((a) => engineNames.includes(a.engine));

  if (toBench.length === 0) {
    console.error("❌ None of the requested engines have embeddings in the DB.");
    process.exit(1);
  }

  if (requestedEngines) {
    const skipped = requestedEngines.filter((e) => !available.some((a) => a.engine === e));
    if (skipped.length > 0) console.log(`\n   ⚠️  Skipped (no embeddings): ${skipped.join(", ")}`);
  }

  const stdBatches = Math.ceil(Math.ceil(count / QUERIES_PER_CHUNK) / CHUNKS_PER_LLM_CALL);
  const totalLlm = stdBatches + (enableHard ? hardClusters : 0);

  console.log(`\n   Models to bench:  ${toBench.map((e) => e.model).join(", ")}`);
  console.log(`   Standard queries: ${count} (${QUERIES_PER_CHUNK}/chunk, ~${stdBatches} LLM calls)`);
  if (enableHard) console.log(`   Hard queries:     ${hardCount} (~${hardClusters} clusters)`);
  console.log(`   Total LLM calls:  ~${totalLlm}`);
  console.log(`   K values:         ${topK.join(", ")}`);

  if (dryRun) {
    console.log(`\n🔍 Dry run — would generate ~${count + (enableHard ? hardCount : 0)} queries and benchmark ${toBench.length} model(s).`);
    return;
  }

  // Phase 1
  let benchQueries: BenchQuery[];

  if (existsSync(BENCH_QUERIES_FILE) && !forceGenerate) {
    console.log(`\n📂 Loading existing queries from bench_queries.json`);
    const file = JSON.parse(readFileSync(BENCH_QUERIES_FILE, "utf-8")) as BenchQueriesFile;
    benchQueries = file.queries;
    const sl = benchQueries.filter((q) => q.difficulty === "standard").length;
    const hl = benchQueries.filter((q) => q.difficulty === "hard").length;
    console.log(`   Loaded ${benchQueries.length} queries (${sl} standard + ${hl} hard)`);
  } else {
    console.log(`\n🧪 Phase 1: Generating benchmark queries`);
    const refModel = available[0].model;
    console.log(`   Reference model: ${refModel} (${available[0].count} chunks)`);
    const allEmbeddings = loadEmbeddings(refModel);

    const stdQueries = await generateStandardQueries(allEmbeddings, count);
    const hardQueries = enableHard ? await generateHardQueries(allEmbeddings, hardCount, hardClusters) : [];

    benchQueries = [...stdQueries, ...hardQueries];
    writeFileSync(BENCH_QUERIES_FILE, JSON.stringify({
      generated_at: new Date().toISOString(),
      count: benchQueries.length,
      standard_count: stdQueries.length,
      hard_count: hardQueries.length,
      queries: benchQueries,
    } satisfies BenchQueriesFile, null, 2));
    console.log(`\n   💾 Saved ${benchQueries.length} queries to bench_queries.json`);
  }

  if (benchQueries.length === 0) { console.error("❌ No queries."); process.exit(1); }

  // Phase 2
  const { metrics, queryResults } = await runBenchmark(benchQueries, toBench, topK);
  if (metrics.length === 0) { console.error("❌ No results."); process.exit(1); }

  // Phase 3
  console.log(`\n📝 Generating reports...`);

  writeFileSync(BENCH_MD_FILE, generateMarkdownReport(metrics, benchQueries, topK));
  console.log(`   ✅ ${BENCH_MD_FILE}`);

  await generateXlsxReport(metrics, benchQueries, queryResults, topK);
  console.log(`   ✅ ${BENCH_XLSX_FILE} (${queryResults.length} result rows across 5 sheets)`);

  // Final
  const maxK = topK[topK.length - 1];
  const maxMs = Math.max(...metrics.map((m) => m.avg_query_ms), 1);
  const hasHard = benchQueries.some((q) => q.difficulty === "hard");

  console.log(`\n${"═".repeat(60)}`);
  console.log(`   BENCHMARK COMPLETE`);
  console.log(`${"═".repeat(60)}`);

  const ranked = metrics
    .map((m) => ({ ...m, composite: computeComposite(m, maxK, maxMs, hasHard) }))
    .sort((a, b) => b.composite - a.composite);

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
    console.log(`   ${medal} ${r.engine}: ${(r.composite * 100).toFixed(1)}% reliability`);
    let line = `      Recall@${maxK}: ${((r.recall[maxK] ?? 0) * 100).toFixed(1)}%  MRR: ${((r.mrr[maxK] ?? 0) * 100).toFixed(1)}%`;
    if (hasHard) line += `  Hard: ${((r.recall_hard[maxK] ?? 0) * 100).toFixed(1)}%`;
    console.log(`${line}  Avg: ${r.avg_query_ms.toFixed(0)}ms (p95: ${r.p95_ms}ms)`);
  }

  console.log();
}
