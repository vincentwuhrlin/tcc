/**
 * Split — Chunk all documents and videos for RAG indexation.
 *
 * Documents: TOC parser (3-level) → section-per-chunk
 * Videos:    LLM segmentation → topic-per-chunk
 *
 * Output: chunks/ subdirectory with YAML frontmatter.
 * Originals are never touched.
 *
 * Flags:
 *   --dry-run   Preview without writing
 *   --no-llm    Skip LLM (video segmentation + TOC level 3)
 *   --docs      Process documents only
 *   --videos    Process videos only
 */
import {
  readFileSync, writeFileSync, existsSync, readdirSync,
  mkdirSync, rmSync,
} from "fs";
import { join } from "path";
import {
  OUTPUT_DIR, MEDIA_SPLIT_MAX_CHUNK, printHeader,
} from "../config.js";
import { parseToc } from "../common/toc-parser.js";
import type { ExtractedHeading } from "../common/toc-parser.js";
import { llmCall } from "../common/llm.js";
import { franc } from "franc-min";

// ── Language detection ────────────────────────────────────────────────

const ISO3_TO_ISO1: Record<string, string> = {
  eng: "en", deu: "de", fra: "fr", spa: "es", por: "pt",
  ita: "it", nld: "nl", pol: "pl", rus: "ru", zho: "zh",
  jpn: "ja", kor: "ko", tur: "tr", ara: "ar", hin: "hi",
};

function detectLanguage(text: string): string | undefined {
  const sample = text.slice(0, 2000);
  const iso3 = franc(sample);
  if (iso3 === "und") return undefined;
  return ISO3_TO_ISO1[iso3] || iso3;
}

// ── Types ────────────────────────────────────────────────────────────

interface SourceMeta {
  sourceOrigin: string;    // PDF filename, YouTube URL, or .md filename
  sourceType: "documents" | "videos";
  pages?: number;
  duration?: string;
  language?: string;
}

interface Chunk {
  filename: string;
  body: string;          // content without frontmatter
  chars: number;
  meta: ChunkMeta;
}

/** Assemble final content = frontmatter + body. Call only after chunk_total is set. */
function assembleChunk(chunk: Chunk): string {
  return buildFrontmatter(chunk.meta) + "\n\n" + chunk.body;
}

/** Set chunk_total on all chunks and return assembled content map. */
function finalizeChunks(chunks: Chunk[]): void {
  for (const chunk of chunks) {
    chunk.meta.chunk_total = chunks.length;
  }
}

interface ChunkMeta {
  source_origin: string;
  source_type: string;
  source_pages?: number;
  source_duration?: string;
  source_language?: string;
  chunk_index: number;
  chunk_total: number;       // filled after all chunks are built
  section?: string;
  path?: string;
  title?: string;
  summary?: string;
  chars: number;
  tokens_approx: number;
}

// ── Source parsing ───────────────────────────────────────────────────
//
// Reads YAML frontmatter injected by discover.
// Discover must run before split.

function parseSource(content: string, filename: string, sourceType: "documents" | "videos"): {
  meta: SourceMeta;
  body: string;
} {
  const meta: SourceMeta = { sourceOrigin: filename, sourceType };

  if (!content.startsWith("---\n")) {
    console.error(`   ❌ No frontmatter found in ${filename} — run media:discover first`);
    return { meta, body: content.trim() };
  }

  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) {
    console.error(`   ❌ Malformed frontmatter in ${filename}`);
    return { meta, body: content.trim() };
  }

  const fmText = content.slice(4, endIdx);
  const body = content.slice(endIdx + 5).trim();

  for (const line of fmText.split("\n")) {
    const originMatch = line.match(/^source_origin:\s*"?(.+?)"?\s*$/);
    if (originMatch) meta.sourceOrigin = originMatch[1];
    const pagesMatch = line.match(/^source_pages:\s*(\d+)/);
    if (pagesMatch) meta.pages = parseInt(pagesMatch[1], 10);
    const durMatch = line.match(/^source_duration:\s*"?(.+?)"?\s*$/);
    if (durMatch) meta.duration = durMatch[1];
    const langMatch = line.match(/^source_language:\s*(.+)/);
    if (langMatch) meta.language = langMatch[1].trim();
  }

  if (!meta.language) {
    meta.language = detectLanguage(body);
  }

  return { meta, body };
}

// ── YAML frontmatter generation ─────────────────────────────────────

function buildFrontmatter(meta: ChunkMeta): string {
  const lines: string[] = ["---"];

  lines.push(`source_origin: ${yamlStr(meta.source_origin)}`);
  lines.push(`source_type: ${meta.source_type}`);
  if (meta.source_pages) lines.push(`source_pages: ${meta.source_pages}`);
  if (meta.source_duration) lines.push(`source_duration: ${yamlStr(meta.source_duration)}`);
  if (meta.source_language) lines.push(`source_language: ${meta.source_language}`);
  lines.push(`chunk_index: ${meta.chunk_index}`);
  lines.push(`chunk_total: ${meta.chunk_total}`);
  if (meta.section) lines.push(`section: ${yamlStr(meta.section)}`);
  if (meta.path) lines.push(`path: ${yamlStr(meta.path)}`);
  if (meta.title) lines.push(`title: ${yamlStr(meta.title)}`);
  if (meta.summary) lines.push(`summary: ${yamlStr(meta.summary)}`);
  lines.push(`chars: ${meta.chars}`);
  lines.push(`tokens_approx: ${meta.tokens_approx}`);

  lines.push("---");
  return lines.join("\n");
}

function yamlStr(s: string): string {
  if (/[:"'\n\r\t#{}[\],&*?|><!%@`]/.test(s) || s.trim() !== s) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

// ── Chunk naming ────────────────────────────────────────────────────

function chunkBaseName(originalName: string): string {
  return originalName
    .replace(/\.md$/, "")
    .replace(/[^a-zA-Z0-9\s_-]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 60)
    .replace(/_+$/, "");
}

function chunkFileName(baseName: string, index: number): string {
  return `${baseName}__${String(index).padStart(3, "0")}.md`;
}

// ── Section helpers ─────────────────────────────────────────────────

interface Section {
  heading: ExtractedHeading;
  startLine: number;
  endLine: number;
  chars: number;
}

function buildSections(headings: ExtractedHeading[], lines: string[]): Section[] {
  if (headings.length === 0) return [];
  const sections: Section[] = [];

  for (let i = 0; i < headings.length; i++) {
    const startLine = headings[i].line;
    const endLine = i + 1 < headings.length ? headings[i + 1].line : lines.length;
    const chars = lines.slice(startLine, endLine).join("\n").length;
    sections.push({ heading: headings[i], startLine, endLine, chars });
  }

  return sections;
}

/**
 * Split an oversized section at paragraph boundaries.
 */
function splitOversizedSection(
  lines: string[], startLine: number, endLine: number, maxChars: number,
): { startLine: number; endLine: number }[] {
  const segments: { startLine: number; endLine: number }[] = [];
  let segStart = startLine;
  let chars = 0;
  let lastBlank = startLine;

  for (let i = startLine; i < endLine; i++) {
    chars += lines[i].length + 1;
    if (lines[i].trim() === "") lastBlank = i;

    if (chars >= maxChars && i > segStart) {
      const cut = lastBlank > segStart ? lastBlank : i;
      segments.push({ startLine: segStart, endLine: cut + 1 });
      segStart = cut + 1;
      chars = 0;
      lastBlank = segStart;
    }
  }

  if (segStart < endLine) {
    segments.push({ startLine: segStart, endLine });
  }

  return segments;
}

// ── Document chunking ───────────────────────────────────────────────

async function chunkDocument(
  content: string,
  filename: string,
  noLlm: boolean,
): Promise<{ chunks: Chunk[]; method: string; headingCount: number }> {
  const { meta: source, body } = parseSource(content, filename, "documents");
  const lines = body.split("\n");
  const baseName = chunkBaseName(filename);

  // Parse TOC structure from body (without frontmatter)
  const tocResult = await parseToc(body, {
    maxDepth: 99,
    llmFallback: !noLlm,
  });

  // Build path map for breadcrumbs
  const tocPathMap = new Map<string, string>();
  for (const entry of tocResult.entries) {
    tocPathMap.set(entry.section, entry.path);
  }

  const headings = tocResult.headings;
  const method = tocResult.method || "none";

  // No structure found → single chunk or split if oversized
  if (headings.length < 2) {
    const bodyStart = 0;
    const bodyContent = lines.slice(bodyStart).join("\n").trim();
    const chars = bodyContent.length;

    if (chars > MEDIA_SPLIT_MAX_CHUNK) {
      // Oversized single file → split at paragraph boundaries
      const subSegments = splitOversizedSection(lines, bodyStart, lines.length, MEDIA_SPLIT_MAX_CHUNK);
      const chunks: Chunk[] = [];

      for (let si = 0; si < subSegments.length; si++) {
        const seg = subSegments[si];
        const segContent = lines.slice(seg.startLine, seg.endLine).join("\n").trim();
        if (segContent.length < 50) continue;
        const segChars = segContent.length;
        const partLabel = subSegments.length > 1 ? ` (part ${si + 1}/${subSegments.length})` : "";

        const meta: ChunkMeta = {
          source_origin: source.sourceOrigin,
          source_type: "documents",
          source_pages: source.pages,
          source_language: source.language,
          chunk_index: chunks.length + 1,
          chunk_total: 0,
          path: `Chunk${partLabel}`,
          chars: segChars,
          tokens_approx: Math.round(segChars / 4),
        };
        chunks.push({ filename: chunkFileName(baseName, chunks.length + 1), body: segContent, chars: segChars, meta });
      }

      finalizeChunks(chunks);
      return { chunks, method: method || "none (split by size)", headingCount: headings.length };
    }

    const meta: ChunkMeta = {
      source_origin: source.sourceOrigin,
      source_type: "documents",
      source_pages: source.pages,
      source_language: source.language,
      chunk_index: 1,
      chunk_total: 1,
      chars,
      tokens_approx: Math.round(chars / 4),
    };

    return {
      chunks: [{
        filename: chunkFileName(baseName, 1),
        body: bodyContent,
        chars,
        meta,
      }],
      method: method || "single (no structure)",
      headingCount: headings.length,
    };
  }

  // Build sections from headings
  const sections = buildSections(headings, lines);
  const chunks: Chunk[] = [];
  let chunkIndex = 1;

  // Preamble: content before first heading (legal info, disclaimers, TOC)
  const firstHeadingLine = headings[0].line;
  const bodyStart = 0;
  if (firstHeadingLine > bodyStart) {
    const preambleContent = lines.slice(bodyStart, firstHeadingLine).join("\n").trim();
    if (preambleContent.length > 200) {
      if (preambleContent.length > MEDIA_SPLIT_MAX_CHUNK) {
        // Oversized preamble → split at paragraph boundaries
        const subSegments = splitOversizedSection(lines, bodyStart, firstHeadingLine, MEDIA_SPLIT_MAX_CHUNK);
        for (let si = 0; si < subSegments.length; si++) {
          const seg = subSegments[si];
          const segContent = lines.slice(seg.startLine, seg.endLine).join("\n").trim();
          if (segContent.length < 50) continue;
          const chars = segContent.length;
          const partLabel = subSegments.length > 1 ? ` (part ${si + 1}/${subSegments.length})` : "";
          const meta: ChunkMeta = {
            source_origin: source.sourceOrigin,
            source_type: "documents",
            source_pages: source.pages,
            source_language: source.language,
            chunk_index: chunkIndex,
            chunk_total: 0,
            section: "0",
            path: `Preamble${partLabel}`,
            chars,
            tokens_approx: Math.round(chars / 4),
          };
          chunks.push({ filename: chunkFileName(baseName, chunkIndex), body: segContent, chars, meta });
          chunkIndex++;
        }
      } else {
        const chars = preambleContent.length;
        const meta: ChunkMeta = {
          source_origin: source.sourceOrigin,
          source_type: "documents",
          source_pages: source.pages,
          source_language: source.language,
          chunk_index: chunkIndex,
          chunk_total: 0,
          section: "0",
          path: "Preamble",
          chars,
          tokens_approx: Math.round(chars / 4),
        };
        chunks.push({ filename: chunkFileName(baseName, chunkIndex), body: preambleContent, chars, meta });
        chunkIndex++;
      }
    }
  }

  // Process each section
  for (const section of sections) {
    const sectionContent = lines.slice(section.startLine, section.endLine).join("\n").trim();
    if (sectionContent.length < 50) continue; // skip empty sections

    const path = tocPathMap.get(section.heading.numbering) || section.heading.text;

    if (section.chars > MEDIA_SPLIT_MAX_CHUNK) {
      // Oversized section → split at paragraph boundaries
      const subSegments = splitOversizedSection(
        lines, section.startLine, section.endLine, MEDIA_SPLIT_MAX_CHUNK,
      );

      for (let si = 0; si < subSegments.length; si++) {
        const seg = subSegments[si];
        const segContent = lines.slice(seg.startLine, seg.endLine).join("\n").trim();
        const chars = segContent.length;
        const partLabel = subSegments.length > 1 ? ` (part ${si + 1}/${subSegments.length})` : "";

        const meta: ChunkMeta = {
          source_origin: source.sourceOrigin,
          source_type: "documents",
          source_pages: source.pages,
          source_language: source.language,
          chunk_index: chunkIndex,
          chunk_total: 0,
          section: section.heading.numbering || undefined,
          path: path + partLabel,
          chars,
          tokens_approx: Math.round(chars / 4),
        };
        chunks.push({
          filename: chunkFileName(baseName, chunkIndex),
          body: segContent,
          chars,
          meta,
        });
        chunkIndex++;
      }
    } else {
      // Normal section → single chunk
      const chars = sectionContent.length;
      const meta: ChunkMeta = {
        source_origin: source.sourceOrigin,
        source_type: "documents",
        source_pages: source.pages,
        source_language: source.language,
        chunk_index: chunkIndex,
        chunk_total: 0,
        section: section.heading.numbering || undefined,
        path,
        chars,
        tokens_approx: Math.round(chars / 4),
      };
      chunks.push({
        filename: chunkFileName(baseName, chunkIndex),
        body: sectionContent,
        chars,
        meta,
      });
      chunkIndex++;
    }
  }

  finalizeChunks(chunks);

  return { chunks, method, headingCount: headings.length };
}

// ── Video chunking (LLM segmentation) ───────────────────────────────

const VIDEO_SEGMENT_PROMPT = `You are a transcript analyst. Analyze this meeting/video transcript and identify distinct topic segments.

For each segment, provide:
- line: the line number where the segment starts (1-based)
- title: a short descriptive title (max 60 chars)
- summary: one sentence summary

Rules:
- Identify 5-20 segments depending on transcript length
- A segment should cover at least 2-3 minutes of content
- Look for topic transitions: "let me show you...", "next topic...", "moving on...", questions that shift direction
- Merge small talk / filler ("okay", "yes", "thank you") into the adjacent topic segment
- The first segment always starts at line 1
- Respond ONLY with a JSON array, no markdown fences, no preamble

[{"line":1,"title":"Introductions","summary":"Participants introduce themselves and their roles"}]`;

interface VideoSegment {
  line: number;
  title: string;
  summary: string;
}

async function segmentVideo(content: string): Promise<VideoSegment[]> {
  const response = await llmCall(VIDEO_SEGMENT_PROMPT, content, 4096);
  const cleaned = response.replace(/```json|```/g, "").trim();

  try {
    const segments = JSON.parse(cleaned) as VideoSegment[];
    return segments
      .filter((s) => s.line && s.title)
      .sort((a, b) => a.line - b.line);
  } catch (err) {
    console.log(`   ⚠️  Failed to parse LLM segments: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

async function chunkVideo(
  content: string,
  filename: string,
): Promise<{ chunks: Chunk[]; segmentCount: number }> {
  const { meta: source, body } = parseSource(content, filename, "videos");
  const lines = body.split("\n");
  const baseName = chunkBaseName(filename);

  // LLM segmentation on body (without frontmatter)
  const segments = await segmentVideo(body);

  if (segments.length < 2) {
    // LLM segmentation failed or transcript too short → single chunk
    const bodyStart = 0;
    const bodyContent = lines.slice(bodyStart).join("\n").trim();
    const chars = bodyContent.length;

    const meta: ChunkMeta = {
      source_origin: source.sourceOrigin,
      source_type: "videos",
      source_duration: source.duration,
      source_language: source.language,
      chunk_index: 1,
      chunk_total: 1,
      title: filename.replace(/\.md$/, "").replace(/_/g, " "),
      chars,
      tokens_approx: Math.round(chars / 4),
    };

    return {
      chunks: [{
        filename: chunkFileName(baseName, 1),
        body: bodyContent,
        chars,
        meta,
      }],
      segmentCount: 0,
    };
  }

  // Build chunks from segments — re-split oversized segments at paragraph boundaries
  const chunks: Chunk[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const startLine = Math.max(0, seg.line - 1); // convert to 0-based
    const endLine = i + 1 < segments.length
      ? Math.max(0, segments[i + 1].line - 1)
      : lines.length;

    const segContent = lines.slice(startLine, endLine).join("\n").trim();
    if (segContent.length < 50) continue;

    if (segContent.length > MEDIA_SPLIT_MAX_CHUNK) {
      // Oversized video segment → split at paragraph boundaries
      const subSegments = splitOversizedSection(lines, startLine, endLine, MEDIA_SPLIT_MAX_CHUNK);

      for (let si = 0; si < subSegments.length; si++) {
        const sub = subSegments[si];
        const subContent = lines.slice(sub.startLine, sub.endLine).join("\n").trim();
        if (subContent.length < 50) continue;
        const chars = subContent.length;
        const partLabel = subSegments.length > 1 ? ` (part ${si + 1}/${subSegments.length})` : "";

        const meta: ChunkMeta = {
          source_origin: source.sourceOrigin,
          source_type: "videos",
          source_duration: source.duration,
          source_language: source.language,
          chunk_index: chunks.length + 1,
          chunk_total: 0,
          title: `${seg.title}${partLabel}`,
          summary: seg.summary,
          chars,
          tokens_approx: Math.round(chars / 4),
        };
        chunks.push({ filename: chunkFileName(baseName, chunks.length + 1), body: subContent, chars, meta });
      }
    } else {
      const chars = segContent.length;

      const meta: ChunkMeta = {
        source_origin: source.sourceOrigin,
        source_type: "videos",
        source_duration: source.duration,
        source_language: source.language,
        chunk_index: chunks.length + 1,
        chunk_total: 0,
        title: seg.title,
        summary: seg.summary,
        chars,
        tokens_approx: Math.round(chars / 4),
      };

      chunks.push({
        filename: chunkFileName(baseName, chunks.length + 1),
        body: segContent,
        chars,
        meta,
      });
    }
  }

  finalizeChunks(chunks);

  return { chunks, segmentCount: segments.length };
}

// ── Display helpers ─────────────────────────────────────────────────

function printChunks(chunks: Chunk[], indent: string = "     "): void {
  const maxTokens = Math.round(MEDIA_SPLIT_MAX_CHUNK / 4);
  for (const c of chunks) {
    const tokens = Math.round(c.chars / 4);
    const barLen = Math.min(Math.round((tokens / maxTokens) * 10), 20);
    const bar = "█".repeat(Math.max(barLen, 1));
    const label = c.meta.path || c.meta.title || `Chunk ${c.meta.chunk_index}`;
    const warn = c.chars > MEDIA_SPLIT_MAX_CHUNK ? " ⚠️" : "";
    console.log(`${indent}${bar} ${label} (~${tokens} tok)${warn}`);
  }
}

// ── Main: split ─────────────────────────────────────────────────────

export async function split(): Promise<void> {
  printHeader();
  const args = process.argv.slice(3);
  const dryRun = args.includes("--dry-run");
  const noLlm = args.includes("--no-llm");
  const docsOnly = args.includes("--docs");
  const videosOnly = args.includes("--videos");
  const processDocs = !videosOnly;
  const processVideos = !docsOnly && !noLlm;

  const docsDir = join(OUTPUT_DIR, "documents");
  const videosDir = join(OUTPUT_DIR, "videos");
  const docsChunksDir = join(docsDir, "chunks");
  const videosChunksDir = join(videosDir, "chunks");

  console.log(`   Max chunk: ~${Math.round(MEDIA_SPLIT_MAX_CHUNK / 4)} tokens (${MEDIA_SPLIT_MAX_CHUNK} chars)`);
  console.log(`   LLM fallback: ${noLlm ? "disabled (--no-llm)" : "enabled"}`);
  console.log(`   Process: ${processDocs && processVideos ? "documents + videos" : processDocs ? "documents only" : "videos only"}`);
  console.log();

  let totalChunks = 0;
  let totalSources = 0;

  // ── Documents ────────────────────────────────────────────────────
  if (processDocs && existsSync(docsDir)) {
    const docFiles = readdirSync(docsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        name: f,
        path: join(docsDir, f),
        content: readFileSync(join(docsDir, f), "utf-8"),
      }))
      .sort((a, b) => b.content.length - a.content.length);

    if (docFiles.length > 0) {
      console.log(`📄 Documents: ${docFiles.length} files`);
      console.log();

      if (!dryRun) mkdirSync(docsChunksDir, { recursive: true });

      for (const file of docFiles) {
        const tokensK = Math.round(file.content.length / 4000);
        const { chunks, method, headingCount } = await chunkDocument(file.content, file.name, noLlm);

        console.log(`   📂 ${file.name} (~${tokensK}k tokens)`);
        console.log(`      ${headingCount} headings via ${method} → ${chunks.length} chunks`);
        printChunks(chunks, "      ");
        console.log();

        if (!dryRun) {
          for (const c of chunks) {
            writeFileSync(join(docsChunksDir, c.filename), assembleChunk(c));
          }
        }

        totalChunks += chunks.length;
        totalSources++;
      }
    }
  }

  // ── Videos ───────────────────────────────────────────────────────
  if (processVideos && existsSync(videosDir)) {
    const videoFiles = readdirSync(videosDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        name: f,
        path: join(videosDir, f),
        content: readFileSync(join(videosDir, f), "utf-8"),
      }))
      .sort((a, b) => b.content.length - a.content.length);

    if (videoFiles.length > 0) {
      console.log(`🎥 Videos: ${videoFiles.length} files`);
      console.log();

      if (!dryRun) mkdirSync(videosChunksDir, { recursive: true });

      for (const file of videoFiles) {
        const tokensK = Math.round(file.content.length / 4000);
        console.log(`   🎬 ${file.name} (~${tokensK}k tokens)`);

        if (dryRun) {
          // In dry-run, don't call LLM — estimate segments
          const estimatedSegments = Math.max(3, Math.round(tokensK / 3));
          console.log(`      LLM segmentation → ~${estimatedSegments} segments (estimated, dry run)`);
          totalChunks += estimatedSegments;
        } else {
          const { chunks, segmentCount } = await chunkVideo(file.content, file.name);
          console.log(`      ${segmentCount} segments → ${chunks.length} chunks`);
          printChunks(chunks, "      ");

          for (const c of chunks) {
            writeFileSync(join(videosChunksDir, c.filename), assembleChunk(c));
          }
          totalChunks += chunks.length;
        }
        console.log();
        totalSources++;
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════");

  if (dryRun) {
    console.log(`🏜️  Dry run — no files written`);
    console.log(`   ${totalSources} sources → ~${totalChunks} chunks`);
    if (processVideos) console.log(`   Video chunks are estimated (LLM not called in dry run)`);
  } else {
    console.log(`✅ ${totalSources} sources → ${totalChunks} chunks`);
    if (processDocs) console.log(`   📁 ${docsChunksDir}`);
    if (processVideos) console.log(`   📁 ${videosChunksDir}`);
  }

  console.log();
  console.log("Next: npm run media:split:check → audit chunks");
}

// ── split:check — audit chunks ──────────────────────────────────────

export async function splitCheck(): Promise<void> {
  printHeader();

  for (const sub of ["documents", "videos"]) {
    const chunksDir = join(OUTPUT_DIR, sub, "chunks");
    if (!existsSync(chunksDir)) continue;

    const files = readdirSync(chunksDir).filter((f) => f.endsWith(".md")).sort();
    if (files.length === 0) continue;

    const emoji = sub === "documents" ? "📄" : "🎥";
    console.log(`${emoji} ${sub}/chunks/ — ${files.length} chunks\n`);

    // Group by source
    const bySource = new Map<string, { file: string; meta: Record<string, string>; chars: number }[]>();

    for (const f of files) {
      const content = readFileSync(join(chunksDir, f), "utf-8");
      const meta: Record<string, string> = {};

      // Parse frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        for (const line of fmMatch[1].split("\n")) {
          const m = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
          if (m) meta[m[1]] = m[2];
        }
      }

      const source = meta.source_origin || meta.source_file || "(unknown)";
      if (!bySource.has(source)) bySource.set(source, []);
      bySource.get(source)!.push({ file: f, meta, chars: content.length });
    }

    for (const [source, chunks] of bySource) {
      const totalTokens = Math.round(chunks.reduce((s, c) => s + c.chars, 0) / 4);
      console.log(`   📂 ${source} (${chunks.length} chunks, ~${totalTokens} tokens total)`);

      for (const c of chunks) {
        const tokens = Math.round(c.chars / 4);
        const label = c.meta.path || c.meta.title || c.file;
        const warn = c.chars > MEDIA_SPLIT_MAX_CHUNK ? " ⚠️" : "";
        console.log(`      ${String(tokens).padStart(5)} tok │ ${label}${warn}`);
      }
      console.log();
    }
  }
}

// ── split:undo — delete all chunks ──────────────────────────────────

export async function splitUndo(): Promise<void> {
  printHeader();

  let deleted = 0;
  for (const sub of ["documents", "videos"]) {
    const chunksDir = join(OUTPUT_DIR, sub, "chunks");
    if (existsSync(chunksDir)) {
      const files = readdirSync(chunksDir).filter((f) => f.endsWith(".md"));
      deleted += files.length;
      rmSync(chunksDir, { recursive: true });
      console.log(`   🗑️  ${sub}/chunks/ — ${files.length} chunks deleted`);
    }
  }

  // Also clean up legacy splits/ and originals/ if they exist
  for (const legacy of ["documents/splits", "documents/originals"]) {
    const dir = join(OUTPUT_DIR, legacy);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      deleted += files.length;
      rmSync(dir, { recursive: true });
      console.log(`   🗑️  ${legacy}/ — ${files.length} legacy files deleted`);
    }
  }

  console.log();
  console.log(`✅ ${deleted} files deleted. Originals are untouched.`);
}
