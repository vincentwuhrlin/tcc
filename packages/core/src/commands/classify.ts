/**
 * Classify — Assign PLAN.md categories to each source.
 *
 * Reads existing frontmatter (from discover), sends it to LLM with PLAN.md,
 * and injects `categories` + `classified_at` into the existing frontmatter.
 * Does NOT rewrite or replace other frontmatter fields.
 *
 * Optimization: sends the frontmatter (title, tags, summary, components...)
 * instead of the full body — ~500 tokens/source instead of ~20k.
 *
 * Flags:
 *   --force   Re-classify files that already have categories
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR, PLAN_FILE, MEDIA_CLASSIFY_MAX_TOKENS, printHeader } from "../config.js";
import { buildClassifyPrompt, fillUserMessage } from "../common/prompts.js";
import { llmCall } from "../common/llm.js";
import { scanMarkdownFiles, parseJsonResponse, loadPlan } from "../common/media.js";

// ── Frontmatter helpers ──────────────────────────────────────────────

function hasCategories(content: string): boolean {
  if (!content.startsWith("---\n")) return false;
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return false;
  return content.slice(0, endIdx).includes("categories:");
}

function hasDiscoverFrontmatter(content: string): boolean {
  if (!content.startsWith("---\n")) return false;
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return false;
  return content.slice(0, endIdx).includes("discovered_at:");
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

/**
 * Build a condensed summary from frontmatter for the LLM.
 * Much cheaper than sending the full body (~500 tokens vs ~20k).
 */
function frontmatterForClassification(fmText: string, filename: string): string {
  const lines = [`File: ${filename}`];

  for (const line of fmText.split("\n")) {
    // Include key fields for classification, skip noise
    if (line.startsWith("discovered_at:")) continue;
    if (line.startsWith("classified_at:")) continue;
    if (line.startsWith("categories:")) continue;
    lines.push(line);
  }

  return lines.join("\n");
}

/**
 * Inject categories into existing frontmatter.
 * Inserts before `discovered_at:` if present, otherwise at the end.
 */
function injectCategories(fmText: string, categories: string[]): string {
  // Remove existing categories if present (for --force re-classify)
  const lines = fmText.split("\n");
  const filtered: string[] = [];
  let skipList = false;

  for (const line of lines) {
    if (line.startsWith("categories:") || line.startsWith("classified_at:")) {
      skipList = true;
      continue;
    }
    if (skipList && line.match(/^\s+-\s/)) continue; // skip list items
    skipList = false;
    filtered.push(line);
  }

  // Build categories YAML
  const catYaml = categories.length > 0
    ? "categories:\n" + categories.map((c) => `  - ${c}`).join("\n")
    : "categories: []";

  // Insert before discovered_at, or at the end
  const discoverIdx = filtered.findIndex((l) => l.startsWith("discovered_at:"));
  if (discoverIdx >= 0) {
    filtered.splice(discoverIdx, 0, catYaml, `classified_at: "${new Date().toISOString()}"`);
  } else {
    filtered.push(catYaml, `classified_at: "${new Date().toISOString()}"`);
  }

  return filtered.join("\n");
}

// ── INDEX.md generation ──────────────────────────────────────────────

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

function generateIndex(files: ReturnType<typeof scanMarkdownFiles>): string {
  const plan = loadPlan();
  const lines: string[] = [
    "# INDEX — Knowledge Base",
    "",
    `> Auto-generated on ${new Date().toISOString()}`,
    "",
  ];

  // Group files by category
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

  // Write index grouped by category
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

// ── Main ──────────────────────────────────────────────────────────────

export async function classify(): Promise<void> {
  printHeader();

  const args = process.argv.slice(3);
  const force = args.includes("--force");

  const plan = loadPlan();
  const { system, userTemplate } = buildClassifyPrompt(plan);
  const allFiles = scanMarkdownFiles();
  if (allFiles.length === 0) {
    console.log("⚠️  No .md files found");
    return;
  }

  // Only classify files that have been discovered
  const discovered = allFiles.filter((f) => hasDiscoverFrontmatter(readFileSync(f.path, "utf-8")));
  const toProcess = force
    ? discovered
    : discovered.filter((f) => !hasCategories(readFileSync(f.path, "utf-8")));

  const skipped = discovered.length - toProcess.length;
  const notDiscovered = allFiles.length - discovered.length;

  console.log(`📚 ${allFiles.length} files total, ${discovered.length} discovered, ${skipped} already classified, ${toProcess.length} to process`);
  if (notDiscovered > 0) console.log(`   ⚠️  ${notDiscovered} files not yet discovered — run media:discover first`);
  if (force && skipped > 0) console.log(`   --force: re-classifying all discovered files`);
  console.log(`📋 Plan: ${PLAN_FILE}`);
  console.log();

  if (toProcess.length === 0) {
    console.log("✅ All files already classified!");
    generateAndWriteIndex(allFiles);
    return;
  }

  let applied = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const f = toProcess[i];
    const raw = readFileSync(f.path, "utf-8");
    const parsed = extractFrontmatterText(raw);

    if (!parsed) {
      console.log(`   [${i + 1}/${toProcess.length}] ${f.name} ⚠️  no frontmatter`);
      errors++;
      continue;
    }

    const { fmText, body } = parsed;

    // Send frontmatter summary (not full body) — much cheaper
    const classifyInput = frontmatterForClassification(fmText, f.name);
    const userMessage = fillUserMessage(userTemplate, classifyInput);

    process.stdout.write(`   [${i + 1}/${toProcess.length}] ${f.name}...`);

    try {
      const response = await llmCall(system, userMessage, MEDIA_CLASSIFY_MAX_TOKENS);
      const result = parseJsonResponse(response);

      if (result && Array.isArray(result.categories)) {
        const newFm = injectCategories(fmText, result.categories);
        writeFileSync(f.path, `---\n${newFm}\n---\n${body}`);
        console.log(` ✅ [${result.categories.join(", ")}]`);
        applied++;
      } else {
        console.log(` ⚠️  invalid JSON or missing categories`);
        errors++;
      }
    } catch (err) {
      console.log(` ❌ ${err instanceof Error ? err.message.slice(0, 80) : err}`);
      errors++;
    }
  }

  console.log();
  console.log(`✅ Classified: ${applied} | Skipped: ${skipped} | Errors: ${errors}`);

  generateAndWriteIndex(allFiles);
}

function generateAndWriteIndex(allFiles: ReturnType<typeof scanMarkdownFiles>): void {
  console.log("📋 Generating INDEX.md...");
  const index = generateIndex(allFiles);
  const indexPath = join(OUTPUT_DIR, "INDEX.md");
  writeFileSync(indexPath, index);
  console.log(`   ${indexPath}`);
}
