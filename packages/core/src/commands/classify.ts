/**
 * Classify — Assign PLAN.md categories to sources AND chunks.
 *
 * Phase 1: Classify sources (frontmatter → categories)
 * Phase 2: Classify chunks (path + full body → chunk_categories + inherited categories)
 *
 * Pipeline: discover → synthesize → split → classify
 *
 * Flags:
 *   --force   Re-classify files that already have categories
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import {
  OUTPUT_DIR, PLAN_FILE, MEDIA_CLASSIFY_MAX_TOKENS,
  CONTEXT_DIR, printHeader,
} from "../config.js";
import { loadDomain } from "../common/prompts.js";
import { llmCall } from "../common/llm.js";
import { scanMarkdownFiles, parseJsonResponse, loadPlan } from "../common/media.js";

// ── Frontmatter helpers ──────────────────────────────────────────────

function hasField(content: string, field: string): boolean {
  if (!content.startsWith("---\n")) return false;
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return false;
  return content.slice(0, endIdx).includes(`${field}:`);
}

function extractFrontmatterText(content: string): { fmText: string; body: string } | null {
  if (!content.startsWith("---\n")) return null;
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return null;
  return {
    fmText: content.slice(4, endIdx),
    body: content.slice(endIdx + 5),
  };
}

function parseFrontmatter(content: string): Record<string, any> | null {
  if (!content.startsWith("---\n")) return null;
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return null;

  const fmText = content.slice(4, endIdx);
  const result: Record<string, any> = {};

  let currentKey: string | null = null;
  let currentList: (string | number)[] | null = null;

  for (const line of fmText.split("\n")) {
    const listItem = line.match(/^\s+-\s+(.+)/);
    if (listItem && currentKey) {
      if (!currentList) currentList = [];
      let val: string | number = listItem[1].replace(/^"(.*)"$/, "$1");
      if (/^\d+$/.test(val as string)) val = parseInt(val as string, 10);
      currentList.push(val);
      continue;
    }

    if (currentKey && currentList) {
      result[currentKey] = currentList;
      currentList = null;
      currentKey = null;
    }

    const kv = line.match(/^(\w[\w_]*?):\s*(.*)/);
    if (kv) {
      const key = kv[1];
      let value = kv[2].replace(/^"(.*)"$/, "$1").trim();
      if (value === "" || value === "[]") {
        currentKey = key;
        currentList = [];
      } else {
        result[key] = value;
        currentKey = null;
      }
    }
  }

  if (currentKey && currentList) {
    result[currentKey] = currentList;
  }

  return result;
}

/**
 * Build a condensed summary from source frontmatter for classification.
 */
function frontmatterForClassification(fmText: string, filename: string): string {
  const lines = [`File: ${filename}`];
  for (const line of fmText.split("\n")) {
    if (line.startsWith("discovered_at:")) continue;
    if (line.startsWith("classified_at:")) continue;
    if (line.startsWith("categories:")) continue;
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Build chunk input for classification: path + section + full body.
 */
function chunkForClassification(fmText: string, body: string): string {
  const lines: string[] = [];

  // Extract path and section from frontmatter
  for (const line of fmText.split("\n")) {
    if (line.startsWith("path:")) lines.push(line);
    if (line.startsWith("section:")) lines.push(line);
    if (line.startsWith("title:")) lines.push(line);
  }

  lines.push("");
  lines.push(body.trim());
  return lines.join("\n");
}

/**
 * Inject fields into existing frontmatter without touching other fields.
 * Inserts before `discovered_at:` or at the end.
 */
function injectFields(
  fmText: string,
  fields: { name: string; values: string[] }[],
): string {
  const lines = fmText.split("\n");
  const filtered: string[] = [];
  let skipList = false;

  // Remove existing fields if present (for --force)
  const fieldNames = new Set(fields.map((f) => f.name).concat(["classified_at"]));

  for (const line of lines) {
    const fieldMatch = line.match(/^(\w[\w_]*?):/);
    if (fieldMatch && fieldNames.has(fieldMatch[1])) {
      skipList = true;
      continue;
    }
    if (skipList && line.match(/^\s+-\s/)) continue;
    skipList = false;
    filtered.push(line);
  }

  // Build YAML for new fields
  const newLines: string[] = [];
  for (const field of fields) {
    if (field.values.length > 0) {
      newLines.push(`${field.name}:`);
      for (const v of field.values) {
        newLines.push(`  - ${v}`);
      }
    } else {
      newLines.push(`${field.name}: []`);
    }
  }
  newLines.push(`classified_at: "${new Date().toISOString()}"`);

  // Insert before discovered_at, or at the end
  const discoverIdx = filtered.findIndex((l) => l.startsWith("discovered_at:"));
  if (discoverIdx >= 0) {
    filtered.splice(discoverIdx, 0, ...newLines);
  } else {
    filtered.push(...newLines);
  }

  return filtered.join("\n");
}

// ── Prompt loading ───────────────────────────────────────────────────

function loadClassifyPrompt(filename: string, plan: string): { system: string; userTemplate: string } {
  const path = join(CONTEXT_DIR, "classify", filename);
  if (!existsSync(path)) {
    console.error(`❌ Prompt not found: ${path}`);
    process.exit(1);
  }

  const raw = readFileSync(path, "utf-8");
  const domain = loadDomain();
  const interpolated = raw
    .replace(/\{\{DOMAIN\}\}/g, domain)
    .replace(/\{\{PLAN\}\}/g, plan);

  const separator = "---USER---";
  const idx = interpolated.indexOf(separator);

  if (idx === -1) {
    return { system: interpolated.trim(), userTemplate: "{{CONTENT}}" };
  }

  return {
    system: interpolated.slice(0, idx).trim(),
    userTemplate: interpolated.slice(idx + separator.length).trim(),
  };
}

// ── Progress indicator ───────────────────────────────────────────────

function startProgress(): NodeJS.Timeout {
  const start = Date.now();
  return setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r   ⏳ ${elapsed}s elapsed...`);
  }, 5000);
}

function stopProgress(timer: NodeJS.Timeout): void {
  clearInterval(timer);
  process.stdout.write("\r" + " ".repeat(40) + "\r");
}

// ── INDEX.md generation ──────────────────────────────────────────────

function generateIndex(files: ReturnType<typeof scanMarkdownFiles>): string {
  const plan = loadPlan();
  const lines: string[] = [
    "# INDEX — Knowledge Base",
    "",
    `> Auto-generated on ${new Date().toISOString()}`,
    "",
  ];

  const byCategory = new Map<string, { file: string; title: string; quality: string }[]>();
  const uncategorized: { file: string; title: string; quality: string }[] = [];

  for (const f of files) {
    const content = readFileSync(f.path, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm) continue;

    const title = (fm.title as string) ?? f.name;
    const quality = (fm.quality as string) ?? "?";
    const categories = Array.isArray(fm.categories) ? fm.categories : [];

    if (categories.length === 0) {
      uncategorized.push({ file: f.name, title, quality });
    } else {
      for (const cat of categories) {
        if (!byCategory.has(cat as string)) byCategory.set(cat as string, []);
        byCategory.get(cat as string)!.push({ file: f.name, title, quality });
      }
    }
  }

  // Extract category headers from PLAN.md
  const catHeaders = new Map<string, string>();
  for (const line of plan.split("\n")) {
    const headerMatch = line.match(/^##\s+([A-Z])\.\s+(.+)/);
    if (headerMatch) catHeaders.set(headerMatch[1], headerMatch[2]);
    const subMatch = line.match(/^-\s+([A-Z]\.\d+)\s+(.+?)(?:\s*\(|$)/);
    if (subMatch) catHeaders.set(subMatch[1], subMatch[2]);
  }

  const sortedCats = [...byCategory.keys()].sort();
  for (const cat of sortedCats) {
    const header = catHeaders.get(cat) ?? cat;
    const docs = byCategory.get(cat)!;
    lines.push(`## ${cat} — ${header}`, "");
    for (const d of docs) {
      const icon = d.quality === "high" ? "🟢" : d.quality === "medium" ? "🟡" : "🔴";
      lines.push(`- ${icon} **${d.title}** — \`${d.file}\``);
    }
    lines.push("");
  }

  if (uncategorized.length > 0) {
    lines.push("## Uncategorized", "");
    for (const d of uncategorized) {
      lines.push(`- ${d.title} — \`${d.file}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Scan chunk files ─────────────────────────────────────────────────

interface ChunkFile {
  path: string;
  name: string;
  sourceOrigin: string;
}

function scanChunkFiles(): ChunkFile[] {
  const chunks: ChunkFile[] = [];

  for (const sub of ["documents", "videos"]) {
    const chunksDir = join(OUTPUT_DIR, sub, "chunks");
    if (!existsSync(chunksDir)) continue;

    for (const f of readdirSync(chunksDir).filter((f) => f.endsWith(".md")).sort()) {
      const path = join(chunksDir, f);
      const content = readFileSync(path, "utf-8");
      const fm = parseFrontmatter(content);
      const sourceOrigin = fm?.source_origin ?? f;
      chunks.push({ path, name: f, sourceOrigin });
    }
  }

  return chunks;
}

// ── Main ──────────────────────────────────────────────────────────────

export async function classify(): Promise<void> {
  printHeader();

  const args = process.argv.slice(3);
  const force = args.includes("--force");

  const plan = loadPlan();

  // ── Phase 1: Classify sources ───────────────────────────────────────

  console.log("📚 Phase 1: Classifying sources...");

  const sourcePrompt = loadClassifyPrompt("prompt.md", plan);
  const allFiles = scanMarkdownFiles();
  const discovered = allFiles.filter((f) =>
    hasField(readFileSync(f.path, "utf-8"), "discovered_at"),
  );

  const toClassify = force
    ? discovered
    : discovered.filter((f) => !hasField(readFileSync(f.path, "utf-8"), "categories"));

  const skippedSources = discovered.length - toClassify.length;
  console.log(`   ${discovered.length} discovered, ${skippedSources} already classified, ${toClassify.length} to process`);

  let sourceApplied = 0;
  let sourceErrors = 0;

  // Build source_origin → categories map (for chunk inheritance)
  const parentCategories = new Map<string, string[]>();

  // First, collect already-classified sources into the map
  for (const f of discovered) {
    const content = readFileSync(f.path, "utf-8");
    const fm = parseFrontmatter(content);
    if (fm?.categories && Array.isArray(fm.categories)) {
      const origin = fm.source_origin ?? f.name;
      parentCategories.set(origin, fm.categories as string[]);
    }
  }

  // Classify remaining sources
  for (let i = 0; i < toClassify.length; i++) {
    const f = toClassify[i];
    const raw = readFileSync(f.path, "utf-8");
    const parsed = extractFrontmatterText(raw);
    if (!parsed) { sourceErrors++; continue; }

    const { fmText, body } = parsed;
    const classifyInput = frontmatterForClassification(fmText, f.name);
    const userMessage = sourcePrompt.userTemplate.replace("{{CONTENT}}", classifyInput);

    process.stdout.write(`   [${i + 1}/${toClassify.length}] ${f.name.slice(0, 50)}...`);

    try {
      const response = await llmCall(sourcePrompt.system, userMessage, MEDIA_CLASSIFY_MAX_TOKENS);
      const result = parseJsonResponse(response);

      if (result && Array.isArray(result.categories)) {
        const newFm = injectFields(fmText, [
          { name: "categories", values: result.categories },
        ]);
        writeFileSync(f.path, `---\n${newFm}\n---\n${body}`);
        console.log(` ✅ [${result.categories.join(", ")}]`);

        // Update parent map
        const fm = parseFrontmatter(`---\n${newFm}\n---\n`);
        const origin = fm?.source_origin ?? f.name;
        parentCategories.set(origin, result.categories);

        sourceApplied++;
      } else {
        console.log(` ⚠️  invalid JSON`);
        sourceErrors++;
      }
    } catch (err) {
      console.log(` ❌ ${err instanceof Error ? err.message.slice(0, 80) : err}`);
      sourceErrors++;
    }
  }

  console.log(`   ✅ Sources: ${sourceApplied} classified | ${skippedSources} skipped | ${sourceErrors} errors`);
  console.log();

  // ── Phase 2: Classify chunks ────────────────────────────────────────

  const allChunks = scanChunkFiles();
  if (allChunks.length === 0) {
    console.log("⚠️  No chunks found. Run media:split first if you want chunk classification.");
    generateAndWriteIndex(allFiles);
    return;
  }

  console.log(`📦 Phase 2: Classifying chunks...`);

  const chunkPrompt = loadClassifyPrompt("prompt-chunk.md", plan);
  const toClassifyChunks = force
    ? allChunks
    : allChunks.filter((c) => !hasField(readFileSync(c.path, "utf-8"), "chunk_categories"));

  const skippedChunks = allChunks.length - toClassifyChunks.length;
  console.log(`   ${allChunks.length} chunks total, ${skippedChunks} already classified, ${toClassifyChunks.length} to process`);

  let chunkApplied = 0;
  let chunkErrors = 0;

  for (let i = 0; i < toClassifyChunks.length; i++) {
    const c = toClassifyChunks[i];
    const raw = readFileSync(c.path, "utf-8");
    const parsed = extractFrontmatterText(raw);
    if (!parsed) { chunkErrors++; continue; }

    const { fmText, body } = parsed;
    const classifyInput = chunkForClassification(fmText, body);
    const userMessage = chunkPrompt.userTemplate.replace("{{CONTENT}}", classifyInput);

    // Progress every 50 chunks
    if (i % 50 === 0 || i === toClassifyChunks.length - 1) {
      process.stdout.write(`\r   [${i + 1}/${toClassifyChunks.length}] ${c.name.slice(0, 40)}...`);
    }

    try {
      const response = await llmCall(chunkPrompt.system, userMessage, MEDIA_CLASSIFY_MAX_TOKENS);
      const result = parseJsonResponse(response);

      if (result && Array.isArray(result.chunk_categories)) {
        // Get parent categories
        const inherited = parentCategories.get(c.sourceOrigin) ?? [];

        const newFm = injectFields(fmText, [
          { name: "categories", values: inherited },
          { name: "chunk_categories", values: result.chunk_categories },
        ]);
        writeFileSync(c.path, `---\n${newFm}\n---\n${body}`);
        chunkApplied++;
      } else {
        chunkErrors++;
      }
    } catch (err) {
      chunkErrors++;
    }
  }

  console.log(`\r   ✅ Chunks: ${chunkApplied} classified | ${skippedChunks} skipped | ${chunkErrors} errors` + " ".repeat(20));
  console.log();

  generateAndWriteIndex(allFiles);
}

function generateAndWriteIndex(allFiles: ReturnType<typeof scanMarkdownFiles>): void {
  console.log("📋 Generating INDEX.md...");
  const index = generateIndex(allFiles);
  const indexPath = join(OUTPUT_DIR, "INDEX.md");
  writeFileSync(indexPath, index);
  console.log(`   ${indexPath}`);
  console.log();
  console.log("Next: npm run media:classify:check → audit classification");
  console.log("      npm run media:embed → build vector index");
}

// ── classify:check — audit classification coverage ───────────────────

export async function classifyCheck(): Promise<void> {
  printHeader();

  const plan = loadPlan();

  // Extract category labels from PLAN.md
  const planCats = new Map<string, string>();
  for (const line of plan.split("\n")) {
    const headerMatch = line.match(/^##\s+([A-Z])\.\s+(.+)/);
    if (headerMatch) planCats.set(headerMatch[1], headerMatch[2]);
    const subMatch = line.match(/^-\s+([A-Z]\.\d+)\s+(.+?)(?:\s*\(|$)/);
    if (subMatch) planCats.set(subMatch[1], subMatch[2].trim());
  }

  // ── Sources ─────────────────────────────────────────────────────────

  console.log("══════════════════════════════════════════════════");
  console.log("📚 SOURCES");
  console.log("══════════════════════════════════════════════════");

  const allFiles = scanMarkdownFiles();
  let totalSources = 0;
  let sourcesClassified = 0;
  let sourcesEmpty = 0;
  const sourcesMissing: string[] = [];
  const sourceCatCount = new Map<string, number>();

  for (const f of allFiles) {
    totalSources++;
    const content = readFileSync(f.path, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm) { sourcesMissing.push(f.name); continue; }

    const cats = Array.isArray(fm.categories) ? fm.categories as string[] : [];
    if (cats.length > 0) {
      sourcesClassified++;
      for (const c of cats) sourceCatCount.set(c, (sourceCatCount.get(c) ?? 0) + 1);
    } else if (fm.categories !== undefined) {
      sourcesEmpty++;
    } else {
      sourcesMissing.push(f.name);
    }
  }

  console.log(`   Total: ${totalSources}`);
  console.log(`   ✅ Classified: ${sourcesClassified}`);
  if (sourcesEmpty > 0) console.log(`   ⚠️  Empty categories: ${sourcesEmpty}`);
  if (sourcesMissing.length > 0) {
    console.log(`   ❌ Missing categories: ${sourcesMissing.length}`);
    for (const f of sourcesMissing.slice(0, 5)) console.log(`      - ${f}`);
    if (sourcesMissing.length > 5) console.log(`      ... and ${sourcesMissing.length - 5} more`);
  }

  // ── Chunks ──────────────────────────────────────────────────────────

  console.log();
  console.log("══════════════════════════════════════════════════");
  console.log("📦 CHUNKS");
  console.log("══════════════════════════════════════════════════");

  const allChunks = scanChunkFiles();
  let chunksWithInherited = 0;
  let chunksWithOwn = 0;
  let chunksEmptyOwn = 0;
  let chunksMissingOwn = 0;
  const chunkCatCount = new Map<string, number>();

  for (const c of allChunks) {
    const content = readFileSync(c.path, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm) continue;

    const inherited = Array.isArray(fm.categories) ? fm.categories as string[] : [];
    if (inherited.length > 0) chunksWithInherited++;

    const own = Array.isArray(fm.chunk_categories) ? fm.chunk_categories as string[] : [];
    if (own.length > 0) {
      chunksWithOwn++;
      for (const cat of own) chunkCatCount.set(cat, (chunkCatCount.get(cat) ?? 0) + 1);
    } else if (fm.chunk_categories !== undefined) {
      chunksEmptyOwn++;
    } else {
      chunksMissingOwn++;
    }
  }

  console.log(`   Total: ${allChunks.length}`);
  console.log(`   ✅ With inherited categories: ${chunksWithInherited}`);
  console.log(`   ✅ With chunk_categories: ${chunksWithOwn}`);
  if (chunksEmptyOwn > 0) console.log(`   ⚠️  Empty chunk_categories: ${chunksEmptyOwn}`);
  if (chunksMissingOwn > 0) console.log(`   ❌ Missing chunk_categories: ${chunksMissingOwn}`);

  // ── Distribution ────────────────────────────────────────────────────

  console.log();
  console.log("══════════════════════════════════════════════════");
  console.log("📊 CATEGORY DISTRIBUTION");
  console.log("══════════════════════════════════════════════════");

  // Group by main category letter
  const mainLetters = new Set<string>();
  for (const cat of [...sourceCatCount.keys(), ...chunkCatCount.keys(), ...planCats.keys()]) {
    mainLetters.add(cat.split(".")[0]);
  }

  const orphans: string[] = [];

  for (const letter of [...mainLetters].sort()) {
    const label = planCats.get(letter) ?? "???";
    console.log(`\n   ${letter}. ${label}`);

    // Find sub-categories for this letter
    const subs = [...planCats.keys()].filter((k) => k.startsWith(`${letter}.`)).sort();
    let totalSrc = 0;
    let totalChk = 0;

    for (const sub of subs) {
      const sc = sourceCatCount.get(sub) ?? 0;
      const cc = chunkCatCount.get(sub) ?? 0;
      totalSrc += sc;
      totalChk += cc;
      const subLabel = planCats.get(sub) ?? "";
      const bar = "█".repeat(Math.min(Math.ceil(cc / 10), 30));
      const flag = sc === 0 && cc === 0 ? " ⚠️  orphan" : "";
      console.log(`      ${sub} ${subLabel} — ${sc} src / ${cc} chk ${bar}${flag}`);
      if (sc === 0 && cc === 0) orphans.push(`${sub} ${subLabel}`);
    }

    console.log(`      ── total: ${totalSrc} src / ${totalChk} chk`);
  }

  if (orphans.length > 0) {
    console.log();
    console.log("══════════════════════════════════════════════════");
    console.log(`⚠️  ORPHAN CATEGORIES: ${orphans.length} (in PLAN.md but nothing assigned)`);
    console.log("══════════════════════════════════════════════════");
    for (const o of orphans) console.log(`   - ${o}`);
  }

  console.log();
}
