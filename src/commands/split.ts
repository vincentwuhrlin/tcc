/**
 * Split large markdown documents into chunks using LLM to determine optimal split points.
 * Replaces the old regex-based approach with intelligent structure analysis.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR, MEDIA_SPLIT_THRESHOLD, MEDIA_SPLIT_MAX_CHUNK } from "../config.js";
import { llmCall, printApiConfig } from "../common/llm.js";
import { loadContextFile, interpolate } from "../common/prompts.js";

// ── Types ────────────────────────────────────────────────────────────

interface Heading {
  index: number;
  line: number;
  level: number;       // 1 = #, 2 = ##, etc.
  raw: string;         // original line
  title: string;       // cleaned title
  charsToNext: number; // chars from this heading to the next (or end)
}

interface ChunkPlan {
  title: string;
  section: string;
  start_heading_index: number;
  end_heading_index: number;
  breadcrumb: string;
}

interface SplitChunk {
  filename: string;
  title: string;
  breadcrumb: string;
  content: string;
  chars: number;
}

// ── Heading extraction (simple, no complex regex) ────────────────────

function extractHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Markdown headings: # Title, ## Title, ### Title
    const mdMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (mdMatch) {
      headings.push({
        index: headings.length,
        line: i,
        level: mdMatch[1].length,
        raw: line,
        title: cleanTitle(mdMatch[2]),
        charsToNext: 0, // computed below
      });
      continue;
    }

    // Bold numbered lines: **2.1 Title** or **A.3 Title**
    const boldMatch = line.match(/^\*\*([A-Z\d][\d.]*)\s+(.+?)\*\*\s*$/);
    if (boldMatch) {
      const depth = boldMatch[1].split(".").filter(Boolean).length;
      headings.push({
        index: headings.length,
        line: i,
        level: Math.min(depth, 4),
        raw: line,
        title: cleanTitle(`${boldMatch[1]} ${boldMatch[2]}`),
        charsToNext: 0,
      });
    }
  }

  // Compute chars between headings
  const fullText = lines.join("\n");
  const lineOffsets = computeLineOffsets(lines);

  for (let i = 0; i < headings.length; i++) {
    const startOffset = lineOffsets[headings[i].line];
    const endOffset = i + 1 < headings.length
      ? lineOffsets[headings[i + 1].line]
      : fullText.length;
    headings[i].charsToNext = endOffset - startOffset;
  }

  return headings;
}

function computeLineOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1; // +1 for \n
  }
  return offsets;
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")     // strip HTML tags
    .replace(/\*\*/g, "")        // strip bold
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // strip links, keep text
    .replace(/\s+/g, " ")
    .trim();
}

// ── Source header extraction ─────────────────────────────────────────

function extractSourceHeader(content: string): string {
  const headerLines: string[] = [];
  for (const line of content.split("\n")) {
    if (/^> (Source|Pages|Size|Duration|Language):/.test(line)) {
      headerLines.push(line);
    } else if (headerLines.length > 0) break;
  }
  return headerLines.length > 0 ? headerLines.join("\n") : "";
}

// ── LLM-based split planning ────────────────────────────────────────

function formatHeadingsForLLM(headings: Heading[]): string {
  return headings.map((h) => {
    const indent = "  ".repeat(h.level - 1);
    const tokensK = Math.round(h.charsToNext / 4000);
    return `  [${h.index}] line ${h.line}: ${indent}${"#".repeat(h.level)} ${h.title} (~${tokensK}k tokens, ${h.charsToNext} chars)`;
  }).join("\n");
}

async function planSplit(filename: string, headings: Heading[], totalChars: number): Promise<ChunkPlan[]> {
  const maxChars = MEDIA_SPLIT_MAX_CHUNK;
  const maxTokens = Math.round(maxChars / 4);

  const raw = loadContextFile("split/prompt.md");
  const { system, userTemplate } = (() => {
    const sep = "---USER---";
    const idx = raw.indexOf(sep);
    if (idx === -1) return { system: raw, userTemplate: "{{CONTENT}}" };
    return {
      system: raw.slice(0, idx).trim(),
      userTemplate: raw.slice(idx + sep.length).trim(),
    };
  })();

  const vars: Record<string, string> = {
    MAX_TOKENS: String(maxTokens),
    MAX_CHARS: String(maxChars),
    FILENAME: filename,
    TOTAL_CHARS: String(totalChars),
    TOTAL_TOKENS: String(Math.round(totalChars / 4)),
    HEADINGS: formatHeadingsForLLM(headings),
  };

  const systemPrompt = interpolate(system, vars);
  const userMessage = interpolate(userTemplate, vars);

  const response = await llmCall(systemPrompt, userMessage, 4096);

  try {
    const cleaned = response.replace(/^```json?\n?/m, "").replace(/\n?```$/m, "").trim();
    return JSON.parse(cleaned);
  } catch {
    console.log(`   ⚠️  Failed to parse LLM split plan`);
    return [];
  }
}

// ── Apply split plan ────────────────────────────────────────────────

function applyPlan(
  lines: string[], headings: Heading[], plan: ChunkPlan[],
  originalName: string, sourceHeader: string,
): SplitChunk[] {
  const baseName = originalName.replace(/\.md$/, "");
  const chunks: SplitChunk[] = [];

  for (const p of plan) {
    const startHeading = headings[p.start_heading_index];
    const endHeading = headings[p.end_heading_index];
    if (!startHeading || !endHeading) continue;

    const startLine = startHeading.line;
    const endLine = p.end_heading_index + 1 < headings.length
      ? headings[p.end_heading_index + 1].line
      : lines.length;

    const chunkLines = lines.slice(startLine, endLine);

    const safeTitle = p.title
      .replace(/[^a-zA-Z0-9\s-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 60)
      .replace(/_+$/, "");

    const safeSection = p.section.replace(/[^a-zA-Z0-9.]/g, "_");

    const content = [
      `---`,
      `parent_document: "${originalName}"`,
      `section: "${p.section}"`,
      `section_title: "${p.title.replace(/"/g, '\\"')}"`,
      `---`,
      "",
      sourceHeader ? sourceHeader + "\n" : "",
      `> Context: ${p.breadcrumb}`,
      "",
      ...chunkLines,
    ].filter(Boolean).join("\n");

    chunks.push({
      filename: `${baseName}__s${safeSection}_${safeTitle}.md`,
      title: p.title,
      breadcrumb: p.breadcrumb,
      content,
      chars: content.length,
    });
  }

  return chunks;
}

// ── Preamble handling ───────────────────────────────────────────────

function extractPreamble(lines: string[], firstHeadingLine: number, originalName: string, sourceHeader: string): SplitChunk | null {
  if (firstHeadingLine <= 2) return null; // no meaningful preamble

  const preambleLines = lines.slice(0, firstHeadingLine);
  const preambleText = preambleLines.join("\n").trim();
  if (preambleText.length < 500) return null; // too small

  const baseName = originalName.replace(/\.md$/, "");
  const content = [
    `---`,
    `parent_document: "${originalName}"`,
    `section: "0"`,
    `section_title: "Preamble"`,
    `---`,
    "",
    sourceHeader ? sourceHeader + "\n" : "",
    `> Context: Preamble (content before first heading)`,
    "",
    ...preambleLines,
  ].filter(Boolean).join("\n");

  return {
    filename: `${baseName}__s0_preamble.md`,
    title: "Preamble",
    breadcrumb: "Preamble",
    content,
    chars: content.length,
  };
}

// ── Main ────────────────────────────────────────────────────────────

export async function split(): Promise<void> {
  const args = process.argv.slice(3);
  const dryRun = args.includes("--dry-run");

  const docsDir = join(OUTPUT_DIR, "documents");
  const splitsDir = join(OUTPUT_DIR, "documents", "splits");
  const origDir = join(OUTPUT_DIR, "documents", "originals");

  if (!existsSync(docsDir)) {
    console.log("⚠️  No documents directory found");
    return;
  }

  const files = readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      name: f,
      path: join(docsDir, f),
      size: readFileSync(join(docsDir, f), "utf-8").length,
    }))
    .sort((a, b) => b.size - a.size);

  const toSplit = files.filter((f) => f.size > MEDIA_SPLIT_THRESHOLD);
  const small = files.filter((f) => f.size <= MEDIA_SPLIT_THRESHOLD);

  console.log(`📄 ${files.length} documents scanned`);
  console.log(`   Threshold: >${Math.round(MEDIA_SPLIT_THRESHOLD / 4000)}k tokens (${MEDIA_SPLIT_THRESHOLD} chars)`);
  console.log(`   Max chunk: ~${Math.round(MEDIA_SPLIT_MAX_CHUNK / 4000)}k tokens (${MEDIA_SPLIT_MAX_CHUNK} chars)`);
  console.log(`   ${toSplit.length} large → will split (LLM-assisted)`);
  console.log(`   ${small.length} small → kept as-is`);
  printApiConfig();
  console.log();

  if (toSplit.length === 0) {
    console.log("✅ No documents need splitting.");
    return;
  }

  let totalSplits = 0;
  let splitDocs = 0;
  let skippedDocs = 0;

  for (const file of toSplit) {
    const content = readFileSync(file.path, "utf-8");
    const lines = content.split("\n");
    const tokensK = Math.round(content.length / 4000);
    const sourceHeader = extractSourceHeader(content);

    console.log(`📂 ${file.name} (~${tokensK}k tokens)`);

    // Extract headings
    const headings = extractHeadings(lines);
    if (headings.length < 2) {
      console.log(`   ⏭️  Only ${headings.length} heading(s) found — skipping`);
      skippedDocs++;
      continue;
    }

    console.log(`   📋 ${headings.length} headings found, asking LLM for split plan...`);

    // Ask LLM for split plan
    const plan = await planSplit(file.name, headings, content.length);
    if (plan.length === 0) {
      console.log(`   ⏭️  LLM returned no split plan — skipping`);
      skippedDocs++;
      continue;
    }

    // Apply plan
    const chunks = applyPlan(lines, headings, plan, file.name, sourceHeader);

    // Add preamble if significant content before first heading
    const preamble = extractPreamble(lines, headings[0].line, file.name, sourceHeader);
    if (preamble) chunks.unshift(preamble);

    const maxChunkK = Math.round(Math.max(...chunks.map((c) => c.chars)) / 4000);
    const avgChunkK = Math.round(chunks.reduce((s, c) => s + c.chars, 0) / chunks.length / 4000);

    console.log(`   → ${chunks.length} chunks (avg ~${avgChunkK}k, max ~${maxChunkK}k tokens)`);
    for (const c of chunks) {
      const cK = Math.round(c.chars / 4000);
      const bar = "█".repeat(Math.min(Math.round(cK / 5), 20));
      const warn = cK > Math.round(MEDIA_SPLIT_MAX_CHUNK / 4000) ? " ⚠️" : "";
      console.log(`     ${bar} ${c.title} (~${cK}k)${warn}`);
    }
    console.log();

    if (!dryRun) {
      mkdirSync(splitsDir, { recursive: true });
      mkdirSync(origDir, { recursive: true });

      for (const c of chunks) {
        writeFileSync(join(splitsDir, c.filename), c.content);
      }

      renameSync(file.path, join(origDir, file.name));
      splitDocs++;
      totalSplits += chunks.length;
    } else {
      splitDocs++;
      totalSplits += chunks.length;
    }
  }

  console.log("═══════════════════════════════════════════════════");

  if (dryRun) {
    console.log(`🏜️  Dry run — no files written`);
    console.log(`   Would split: ${splitDocs} docs → ${totalSplits} chunks`);
    console.log(`   Would skip: ${skippedDocs} (no headings / no plan)`);
    console.log(`   Would keep: ${small.length} small docs as-is`);
  } else {
    console.log(`✅ Split: ${splitDocs} docs → ${totalSplits} chunks`);
    console.log(`   Skipped: ${skippedDocs}`);
    console.log(`   Kept: ${small.length} small docs as-is`);
    console.log();
    console.log("   📁 output/documents/          ← small docs (unchanged)");
    console.log("   📁 output/documents/splits/   ← split chunks (new)");
    console.log("   📁 output/documents/originals/ ← big docs (backup)");
  }

  console.log();
  console.log("Next: npm run media:stats    → verify new token counts");
  console.log("      npm run media:discover → discover on all chunks");
}
