/**
 * embed — Generate embeddings for all chunks and store in SQLite.
 *
 * Scans OUTPUT_DIR/{documents,videos}/chunks/*.md, strips frontmatter,
 * embeds the body text via the configured RAG_ENGINE, and upserts
 * the vector into workspace.db.
 *
 * Features:
 *   - Skips already-embedded chunks (idempotent, resumable)
 *   - Validates that existing embeddings match current engine
 *   - Progress reporting with ETA
 *
 * Flags:
 *   --force    Re-embed all chunks (ignore existing)
 *   --dry-run  Count chunks without embedding
 *   --limit=N  Only embed the first N chunks (for testing)
 *
 * Usage:
 *   npm run media:embed
 *   npm run media:embed -- --force
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, relative } from "path";
import { OUTPUT_DIR, printHeader, RAG_BATCH_SIZE, RAG_BATCH_CONCURRENCY, RAG_API_BASE_URL } from "../config.js";
import { getEmbedEngine } from "../common/embed/index.js";
import { upsertEmbedding, getEmbeddingIds, countEmbeddings, getDbStats } from "../common/db.js";
import { stripFrontmatter } from "../common/media.js";
import { isQuotaError, logQuotaStop } from "../common/llm.js";

// ── Types ────────────────────────────────────────────────────────────

interface ChunkFile {
  id: string;       // relative path as ID (e.g. "documents/chunks/file__chunk_01.md")
  path: string;     // absolute path
  source: string;   // source_origin from frontmatter
}

// ── Chunk scanning ──────────────────────────────────────────────────

function scanChunks(): ChunkFile[] {
  const chunks: ChunkFile[] = [];

  for (const sub of ["documents", "videos"]) {
    const chunksDir = join(OUTPUT_DIR, sub, "chunks");
    if (!existsSync(chunksDir)) continue;

    for (const f of readdirSync(chunksDir).filter((f) => f.endsWith(".md")).sort()) {
      const absPath = join(chunksDir, f);
      const id = `${sub}/chunks/${f}`;

      // Extract source_origin from frontmatter
      const raw = readFileSync(absPath, "utf-8");
      const sourceMatch = raw.match(/^source_origin:\s*"?(.+?)"?\s*$/m);
      const source = sourceMatch?.[1] ?? f;

      chunks.push({ id, path: absPath, source });
    }
  }

  return chunks;
}

// ── Embed command ───────────────────────────────────────────────────

export async function embed(): Promise<void> {
  printHeader();

  const force = process.argv.includes("--force");
  const dryRun = process.argv.includes("--dry-run");
  const limitFlag = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
  const limit = limitFlag ? parseInt(limitFlag, 10) : 0;

  // 1. Init engine
  const engine = await getEmbedEngine();
  const { engine: engineName, model, dimensions, mode } = engine.info();

  console.log(`🔮 media:embed — Embedding chunks`);
  console.log(`   Engine:     ${engineName}`);
  console.log(`   Model:      ${model} (${dimensions}d)`);
  if (mode === "api") {
    console.log(`   API URL:    ${RAG_API_BASE_URL}`);
    console.log(`   Concurrency: ${RAG_BATCH_CONCURRENCY} parallel requests`);
  }
  console.log(`   Batch size: ${RAG_BATCH_SIZE}`);
  console.log();

  // 2. Scan chunks
  const allChunks = scanChunks();
  if (allChunks.length === 0) {
    console.log("⚠️  No chunks found. Run media:split first.");
    return;
  }
  console.log(`📦 ${allChunks.length} chunks found`);

  // 3. Determine what to embed
  let toEmbed: ChunkFile[];
  if (force) {
    toEmbed = allChunks;
    console.log(`   --force: re-embedding all ${allChunks.length} chunks`);
  } else {
    const existingIds = getEmbeddingIds(model);
    toEmbed = allChunks.filter((c) => !existingIds.has(c.id));
    const skipped = allChunks.length - toEmbed.length;
    if (skipped > 0) console.log(`   ⏭️  ${skipped} already embedded, ${toEmbed.length} remaining`);
  }

  if (toEmbed.length === 0) {
    console.log("✅ All chunks already embedded. Use --force to re-embed.");
    printStats();
    return;
  }

  // Apply limit if set
  if (limit > 0 && toEmbed.length > limit) {
    console.log(`   🔢 --limit=${limit}: processing first ${limit} of ${toEmbed.length}`);
    toEmbed = toEmbed.slice(0, limit);
  }

  if (dryRun) {
    console.log(`\n🔍 Dry run: would embed ${toEmbed.length} chunks. Exiting.`);
    return;
  }

  // 4. Embed in batches
  console.log(`\n🚀 Embedding ${toEmbed.length} chunks...\n`);

  const startTime = Date.now();
  let done = 0;
  let errors = 0;

  for (let i = 0; i < toEmbed.length; i += RAG_BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + RAG_BATCH_SIZE);

    // Read and strip frontmatter for each chunk in the batch
    const texts = batch.map((c) => {
      const raw = readFileSync(c.path, "utf-8");
      const { body } = stripFrontmatter(raw);
      return body.trim();
    });

    try {
      const vectors = await engine.embedChunks(texts);

      // Store each result
      for (let j = 0; j < batch.length; j++) {
        upsertEmbedding(batch[j].id, batch[j].source, texts[j], vectors[j], model, dimensions);
      }

      done += batch.length;
    } catch (err) {
      // Log error but continue with next batch
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n   ❌ Batch error at ${batch[0].id}: ${msg.slice(0, 120)}`);
      errors += batch.length;
      done += batch.length;
      if (isQuotaError(err)) { logQuotaStop("embedding", done - errors); break; }
    }

    // Progress
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = done / elapsed;
    const eta = rate > 0 ? Math.round((toEmbed.length - done) / rate) : 0;
    const pct = Math.round((done / toEmbed.length) * 100);
    process.stdout.write(`\r   ⏳ ${done}/${toEmbed.length} (${pct}%) | ${rate.toFixed(1)}/s | ETA: ${formatTime(eta)}`);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n✅ Done in ${totalTime}s — ${done - errors} embedded, ${errors} errors`);

  printStats();
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m${sec}s`;
}

function printStats(): void {
  const stats = getDbStats();
  console.log();
  console.log("📊 Database stats:");
  console.log(`   Embeddings: ${stats.embeddings}`);
  console.log(`   Models:     ${stats.models.join(", ") || "none"}`);
  console.log(`   Sessions:   ${stats.sessions}`);
  console.log(`   Messages:   ${stats.messages}`);
}
