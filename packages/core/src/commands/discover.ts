/**
 * Discover — Analyze all source documents and videos, inject YAML frontmatter.
 *
 * For each source file:
 *   1. Parse > headers (Source, Pages, Duration, Language)
 *   2. Detect language (franc-min fallback)
 *   3. Send content to LLM for topic discovery
 *      - Small files (<MEDIA_DISCOVER_MAX_CHARS): full content
 *      - Large files: split by top-level TOC sections, one call per section, merge results
 *   4. Inject YAML frontmatter (absorbs > headers + LLM results)
 *   5. Generate DISCOVERY.md from all frontmatters (aggregation, no LLM)
 *
 * Flags:
 *   --force   Re-discover files that already have frontmatter
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  OUTPUT_DIR, MEDIA_API_MODE,
  MEDIA_DISCOVER_MAX_CHARS, MEDIA_DISCOVER_SECTION_MAX_CHARS, MEDIA_DISCOVER_MAX_TOKENS,
  printHeader,
} from "../config.js";
import { buildDiscoverPrompt, fillUserMessage, loadDomain } from "../common/prompts.js";
import { llmCall, isQuotaError, logQuotaStop, type BatchRequest } from "../common/llm.js";
import { scanMarkdownFiles, parseJsonResponse } from "../common/media.js";
import { parseToc } from "../common/toc-parser.js";
import { franc } from "franc-min";

// ── Types ─────────────────────────────────────────────────────────────

interface SourceMeta {
  sourceFile: string;
  sourceType: "documents" | "videos";
  sourceOrigin?: string;
  pages?: number;
  size?: string;
  duration?: string;
  language?: string;
}

/** Discover result is a free-form JSON object — fields come from the prompt, not the code. */
type DiscoverResult = Record<string, any>;

/** Fields with special merge/display logic. Everything else is auto-handled. */
const KNOWN_SCALARS = ["title", "source_type", "quality", "language", "suggested_category", "summary"];
const QUALITY_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };

interface DiscoverSection {
  name: string;
  content: string;
  chars: number;
}

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

// ── Labeled fields (generic labels from domain.md) ───────────────────
//
// Parses comments in domain.md like:
//   <!-- LABELED_FIELD: evaluation_step: Technical Assessment, Scalability, IT-on-OT -->
//
// Returns: { "evaluation_step": ["", "Technical Assessment", "Scalability", "IT-on-OT"] }
// Index 0 is unused (labels are 1-based).

function loadLabeledFields(): Record<string, string[]> {
  let domain: string;
  try {
    domain = loadDomain();
  } catch {
    return {};
  }

  const result: Record<string, string[]> = {};

  // New format: <!-- LABELED_FIELD: field_name: Label 1, Label 2, Label 3 -->
  const labeledRe = /<!--\s*LABELED_FIELD:\s*(\w+):\s*(.+?)\s*-->/g;
  let match: RegExpExecArray | null;
  while ((match = labeledRe.exec(domain)) !== null) {
    const field = match[1];
    const labels = match[2].split(",").map((s) => s.trim());
    result[field] = ["", ...labels]; // 1-based
  }

  return result;
}

// ── Source header parsing ────────────────────────────────────────────

function parseSourceHeaders(content: string, filename: string, dir: string): {
  meta: SourceMeta;
  body: string;
} {
  const meta: SourceMeta = {
    sourceFile: filename,
    sourceType: dir.startsWith("video") ? "videos" : "documents",
  };

  let body: string;

  // Case 1: File already has YAML frontmatter (re-discover with --force)
  if (content.startsWith("---\n")) {
    const endIdx = content.indexOf("\n---\n", 4);
    if (endIdx !== -1) {
      const fmText = content.slice(4, endIdx);
      body = content.slice(endIdx + 5).trim();

      // Extract source metadata from existing frontmatter
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

      // Strip any remaining > headers from body (leftover from first discover)
      const bodyLines = body.split("\n");
      const headerLines = new Set<number>();
      for (let i = 0; i < Math.min(bodyLines.length, 20); i++) {
        if (/^> (Source|Pages|Size|Duration|Language):/.test(bodyLines[i])) headerLines.add(i);
      }
      if (headerLines.size > 0) {
        body = bodyLines.filter((line, i) => {
          if (headerLines.has(i)) return false;
          if (line.trim() === "" && (headerLines.has(i + 1) || headerLines.has(i - 1))) return false;
          return true;
        }).join("\n").trim();
      }
    } else {
      body = content;
    }
  }
  // Case 2: Raw file with > headers (first discover)
  // Headers can appear after a # Title line (common in videos)
  else {
    const lines = content.split("\n");
    const headerLines = new Set<number>();

    // Scan first 20 lines for > headers (they might be after # Title)
    for (let i = 0; i < Math.min(lines.length, 20); i++) {
      const line = lines[i];
      if (/^> (Source|Pages|Size|Duration|Language):/.test(line)) {
        headerLines.add(i);
        const sourceMatch = line.match(/^> Source:\s*(.+)/);
        if (sourceMatch) meta.sourceOrigin = sourceMatch[1].trim();
        const pagesMatch = line.match(/^> Pages:\s*(\d+)/);
        if (pagesMatch) meta.pages = parseInt(pagesMatch[1], 10);
        const sizeMatch = line.match(/^> Size:\s*(.+)/);
        if (sizeMatch) meta.size = sizeMatch[1].trim();
        const durMatch = line.match(/^> Duration:\s*(.+)/);
        if (durMatch) meta.duration = durMatch[1].trim();
        const langMatch = line.match(/^> Language:\s*(.+)/);
        if (langMatch) meta.language = langMatch[1].trim();
      }
    }

    // Remove header lines and blank lines immediately around them
    if (headerLines.size > 0) {
      const filtered = lines.filter((line, i) => {
        if (headerLines.has(i)) return false;
        // Remove blank line right before first header or right after last header
        if (line.trim() === "" && (headerLines.has(i + 1) || headerLines.has(i - 1))) return false;
        return true;
      });
      body = filtered.join("\n").trim();
    } else {
      body = content.trim();
    }
  }

  // Detect language if not found
  if (!meta.language) {
    meta.language = detectLanguage(body);
  }

  return { meta, body };
}

// ── Smart content preparation ────────────────────────────────────────

async function prepareDiscoverSections(
  body: string,
  filename: string,
): Promise<DiscoverSection[]> {
  const bodyChars = body.length;

  // Small enough → send everything
  if (bodyChars <= MEDIA_DISCOVER_MAX_CHARS) {
    return [{ name: filename, content: body, chars: bodyChars }];
  }

  // Big doc → use TOC to split by top-level sections
  console.log(`\n      📐 Large doc (${Math.round(bodyChars / 4000)}k tokens) — splitting by TOC sections`);

  const tocResult = await parseToc(body, { maxDepth: 99, llmFallback: false });
  const headings = tocResult.headings;

  if (headings.length < 2) {
    console.log(`      ⚠️  No TOC structure — using truncated content`);
    return [{ name: filename, content: body.slice(0, MEDIA_DISCOVER_MAX_CHARS), chars: MEDIA_DISCOVER_MAX_CHARS }];
  }

  const lines = body.split("\n");
  const topHeadings = headings.filter((h) => h.depth === 1);
  const sectionHeadings = topHeadings.length >= 2 ? topHeadings : headings.filter((h) => h.depth <= 2);

  const sections: DiscoverSection[] = [];

  for (let i = 0; i < sectionHeadings.length; i++) {
    const heading = sectionHeadings[i];
    const startLine = heading.line;
    const endLine = i + 1 < sectionHeadings.length ? sectionHeadings[i + 1].line : lines.length;
    const sectionContent = lines.slice(startLine, endLine).join("\n").trim();
    const chars = sectionContent.length;

    if (chars < 200) continue;

    if (chars > MEDIA_DISCOVER_SECTION_MAX_CHARS) {
      // Section too big → split by sub-headings
      const subHeadings = headings.filter(
        (h) => h.line >= startLine && h.line < endLine && h.depth > heading.depth,
      );

      if (subHeadings.length >= 2) {
        for (let si = 0; si < subHeadings.length; si++) {
          const subStart = subHeadings[si].line;
          const subEnd = si + 1 < subHeadings.length ? subHeadings[si + 1].line : endLine;
          const subContent = lines.slice(subStart, subEnd).join("\n").trim();
          if (subContent.length < 200) continue;

          sections.push({
            name: `${heading.text} / ${subHeadings[si].text}`,
            content: subContent.slice(0, MEDIA_DISCOVER_SECTION_MAX_CHARS),
            chars: Math.min(subContent.length, MEDIA_DISCOVER_SECTION_MAX_CHARS),
          });
        }
      } else {
        sections.push({
          name: heading.text,
          content: sectionContent.slice(0, MEDIA_DISCOVER_SECTION_MAX_CHARS),
          chars: MEDIA_DISCOVER_SECTION_MAX_CHARS,
        });
      }
    } else {
      sections.push({ name: heading.text, content: sectionContent, chars });
    }
  }

  console.log(`      → ${sections.length} sections`);
  return sections;
}

// ── Merge section results ────────────────────────────────────────────

function mergeDiscoverResults(results: DiscoverResult[], filename: string): DiscoverResult {
  if (results.length === 1) return results[0];

  const merged: DiscoverResult = {};

  // Collect all keys across all results
  const allKeys = [...new Set(results.flatMap((r) => Object.keys(r)))];

  for (const key of allKeys) {
    const values = results.map((r) => r[key]).filter((v) => v !== undefined && v !== null);
    if (values.length === 0) continue;

    const first = values[0];

    if (key === "title") {
      // Use first non-empty title, fallback to filename
      merged[key] = values.find((v) => typeof v === "string" && v.length > 0) || filename.replace(/\.md$/, "");
    } else if (key === "quality") {
      // Best quality wins
      merged[key] = values.reduce(
        (best: string, v: string) => (QUALITY_ORDER[v] ?? 0) > (QUALITY_ORDER[best] ?? 0) ? v : best,
        "low",
      );
    } else if (key === "summary") {
      // Concatenate first 3 summaries, truncate
      merged[key] = values.filter((v) => typeof v === "string" && v).slice(0, 3).join(" ").slice(0, 600);
    } else if (key === "suggested_category") {
      // Most common category
      const counts = new Map<string, number>();
      for (const v of values) {
        if (typeof v === "string" && v) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      merged[key] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    } else if (key === "source_type" || key === "language") {
      // First non-empty value
      merged[key] = values.find((v) => typeof v === "string" && v) ?? first;
    } else if (Array.isArray(first)) {
      // Arrays → union + deduplicate, limit to 15
      const flat = values.flatMap((v) => Array.isArray(v) ? v : [v]);
      merged[key] = [...new Set(flat)].slice(0, 15);
    } else {
      // Other scalars → first value
      merged[key] = first;
    }
  }

  return merged;
}

// ── Frontmatter ──────────────────────────────────────────────────────

function hasDiscoverFrontmatter(content: string): boolean {
  if (!content.startsWith("---\n")) return false;
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return false;
  return content.slice(0, endIdx).includes("discovered_at:");
}

function yamlStr(s: string): string {
  if (/[:"'\n\r\t#{}[\],&*?|><!%@`]/.test(s) || s.trim() !== s) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function yamlList(items: (string | number)[]): string {
  if (items.length === 0) return "[]";
  return "\n" + items.map((t) => `  - ${typeof t === "string" ? yamlStr(t) : t}`).join("\n");
}

function buildDiscoverFrontmatter(meta: SourceMeta, result: DiscoverResult): string {
  const lines: string[] = ["---"];

  // Source metadata (always present, fixed order)
  if (result.title) lines.push(`title: ${yamlStr(result.title)}`);
  if (result.source_type) lines.push(`source_type: ${result.source_type}`);

  // source_origin: where does this content come from?
  // - YouTube/video URL → keep full URL
  // - HTTPS link to a file (foo.pdf) → extract filename
  // - Local path (..\media\pdfs\foo.pdf) → extract filename
  // - Nothing → use the .md filename
  let origin: string;
  if (meta.sourceOrigin) {
    const filename = meta.sourceOrigin.replace(/^.*[/\\]/, "").replace(/[?#].*$/, "");
    const hasFileExt = /\.\w{2,5}$/.test(filename);
    if (hasFileExt) {
      origin = filename; // local path or URL to a file → just the filename
    } else if (/^https?:\/\//.test(meta.sourceOrigin)) {
      origin = meta.sourceOrigin; // video URL (no file extension) → keep full URL
    } else {
      origin = filename || meta.sourceFile; // fallback
    }
  } else {
    origin = meta.sourceFile;
  }
  lines.push(`source_origin: ${yamlStr(origin)}`);
  if (meta.pages) lines.push(`source_pages: ${meta.pages}`);
  if (meta.duration) lines.push(`source_duration: ${yamlStr(meta.duration)}`);
  lines.push(`source_language: ${result.language || meta.language || "en"}`);

  // LLM result fields (dynamic — writes whatever the prompt returned)
  const skipKeys = new Set(["title", "source_type", "language"]);
  for (const [key, value] of Object.entries(result)) {
    if (skipKeys.has(key)) continue; // already handled above
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      lines.push(`${key}: ${yamlList(value)}`);
    } else if (typeof value === "string") {
      lines.push(`${key}: ${yamlStr(value)}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push(`discovered_at: "${new Date().toISOString()}"`);
  lines.push("---");
  return lines.join("\n");
}

// ── DISCOVERY.md generation (from frontmatters, no LLM) ──────────────

function generateDiscoveryReport(): void {
  const allFiles = scanMarkdownFiles();
  const labeledFields = loadLabeledFields();

  // Collect stats for all array fields
  const arrayStats = new Map<string, Map<string, number>>();
  const categoryCount = new Map<string, number>();
  let totalDiscovered = 0;

  const docLines: string[] = [];

  for (const f of allFiles) {
    const content = readFileSync(f.path, "utf-8");
    if (!hasDiscoverFrontmatter(content)) continue;

    totalDiscovered++;
    const fm = parseFrontmatter(content);
    if (!fm) continue;

    const icon = fm.quality === "high" ? "🟢" : fm.quality === "medium" ? "🟡" : "🔴";
    const label = `${f.dir}/${f.name}`;

    docLines.push(`### ${icon} ${fm.title ?? label}`);
    docLines.push(`\`${label}\``);
    docLines.push("");
    if (fm.summary) docLines.push(`**Summary:** ${fm.summary}`);

    // Display all array and scalar fields dynamically
    const skipDisplay = new Set(["title", "summary", "source_origin",
      "source_pages", "source_duration", "source_language", "quality", "discovered_at"]);

    for (const [key, value] of Object.entries(fm)) {
      if (skipDisplay.has(key)) continue;

      if (Array.isArray(value) && value.length > 0) {
        const displayKey = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        if (key === "tags") {
          docLines.push(`**${displayKey}:** ${value.map((t: string) => `\`${t}\``).join(" ")}`);
        } else if (labeledFields[key] && value.every((v: any) => typeof v === "number")) {
          const labels = labeledFields[key];
          docLines.push(`**${displayKey}:** ${value.map((p: number) => `${p} (${labels[p] ?? "?"})`).join(", ")}`);
        } else {
          docLines.push(`**${displayKey}:** ${value.join(", ")}`);
        }

        // Aggregate stats for this array field
        if (!arrayStats.has(key)) arrayStats.set(key, new Map());
        const counts = arrayStats.get(key)!;
        for (const v of value) {
          const sv = String(v);
          counts.set(sv, (counts.get(sv) ?? 0) + 1);
        }
      } else if (typeof value === "string" && value && !skipDisplay.has(key)) {
        const displayKey = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        docLines.push(`**${displayKey}:** ${value}`);

        if (key === "suggested_category") {
          categoryCount.set(value, (categoryCount.get(value) ?? 0) + 1);
        }
      }
    }

    docLines.push("");
  }

  // Build report
  const lines: string[] = [
    "# Discovery Report",
    "",
    `> ${totalDiscovered} documents analyzed on ${new Date().toISOString()}`,
    "",
    "## Per Document",
    "",
    ...docLines,
    "---",
    "",
  ];

  // Array field coverage sections (components, connectors, standards, etc.)
  for (const [field, counts] of [...arrayStats.entries()].sort()) {
    if (field === "tags" || field === "topics" || field === "key_facts") continue; // shown separately
    const displayName = field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    lines.push(`## ${displayName} Coverage`, "");
    for (const [val, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${val}**: ${count} docs (${Math.round((count / totalDiscovered) * 100)}%)`);
    }
    lines.push("");
  }

  // Suggested categories
  if (categoryCount.size > 0) {
    lines.push("## Suggested Categories (for PLAN.md)", "");
    for (const [cat, count] of [...categoryCount.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${cat}** (${count} doc${count > 1 ? "s" : ""})`);
    }
    lines.push("");
  }

  // Top topics
  const topicCounts = arrayStats.get("topics");
  if (topicCounts && topicCounts.size > 0) {
    lines.push("## Top Topics", "");
    for (const [topic, count] of [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      lines.push(`- ${topic} (${count})`);
    }
    lines.push("");
  }

  // Tag cloud
  const tagCounts = arrayStats.get("tags");
  if (tagCounts && tagCounts.size > 0) {
    lines.push("## Tag Cloud", "");
    lines.push([...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t, c]) => `\`${t}\`×${c}`).join("  "));
    lines.push("");
  }

  const discoveryPath = join(OUTPUT_DIR, "DISCOVERY.md");
  writeFileSync(discoveryPath, lines.join("\n"));
  console.log(`📋 Discovery report: ${discoveryPath}`);
}

// ── Frontmatter parser (lightweight YAML) ────────────────────────────

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

// ── Main ──────────────────────────────────────────────────────────────

export async function discover(): Promise<void> {
  printHeader();

  const args = process.argv.slice(3);
  const force = args.includes("--force");

  const { system, userTemplate } = buildDiscoverPrompt();
  const allFiles = scanMarkdownFiles();
  if (allFiles.length === 0) {
    console.log("⚠️  No .md files found");
    return;
  }

  const toProcess = force
    ? allFiles
    : allFiles.filter((f) => !hasDiscoverFrontmatter(readFileSync(f.path, "utf-8")));

  const skipped = allFiles.length - toProcess.length;

  console.log(`📚 ${allFiles.length} files total, ${skipped} already discovered, ${toProcess.length} to process`);
  if (force && skipped > 0) console.log(`   --force: re-processing all files`);
  console.log();

  if (toProcess.length === 0) {
    console.log("✅ All files already discovered!");
    generateDiscoveryReport();
    return;
  }

  let applied = 0;
  let errors = 0;
  let llmCalls = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const f = toProcess[i];
    const raw = readFileSync(f.path, "utf-8");
    const { meta, body } = parseSourceHeaders(raw, f.name, f.dir);

    const tokensK = Math.round(body.length / 4000);
    process.stdout.write(`   [${i + 1}/${toProcess.length}] ${f.dir}/${f.name} (~${tokensK}k tok)`);

    try {
      const sections = await prepareDiscoverSections(body, f.name);
      const sectionResults: DiscoverResult[] = [];

      for (let si = 0; si < sections.length; si++) {
        const section = sections[si];
        if (sections.length > 1) {
          process.stdout.write(`\n      🔍 [${si + 1}/${sections.length}: ${section.name.slice(0, 30)}]...`);
        }

        const userMessage = fillUserMessage(userTemplate, section.content);
        const { text: response } = await llmCall(system, userMessage, MEDIA_DISCOVER_MAX_TOKENS, undefined, { sessionId: null, kind: "discover" });
        const parsed = parseJsonResponse(response) as DiscoverResult | null;
        llmCalls++;

        if (parsed) {
          sectionResults.push(parsed);
        } else {
          console.log(` ⚠️  invalid JSON`);
        }
      }

      if (sectionResults.length === 0) {
        console.log(` ❌ no valid results`);
        errors++;
        continue;
      }

      const result = mergeDiscoverResults(sectionResults, f.name);
      if (meta.language) result.language = meta.language;

      const frontmatter = buildDiscoverFrontmatter(meta, result);
      writeFileSync(f.path, frontmatter + "\n\n" + body);

      const icon = result.quality === "high" ? "🟢" : result.quality === "medium" ? "🟡" : "🔴";
      const sectionInfo = sections.length > 1 ? ` (${sections.length} sections)` : "";
      console.log(` ${icon} ${result.title?.slice(0, 55) ?? "?"}${sectionInfo}`);
      applied++;

    } catch (err) {
      console.log(` ❌ ${err instanceof Error ? err.message.slice(0, 80) : err}`);
      errors++;
      if (isQuotaError(err)) { logQuotaStop("discovery", applied); break; }
    }
  }

  console.log();
  console.log(`✅ Discovered: ${applied} | Skipped: ${skipped} | Errors: ${errors} | LLM calls: ${llmCalls}`);
  console.log();

  generateDiscoveryReport();

  console.log();
  console.log("Next steps:");
  console.log("   1. Review DISCOVERY.md");
  console.log("   2. npm run media:synthesize → PLAN.md");
  console.log("   3. Tweak PLAN.md if needed");
  console.log("   4. npm run media:classify → add categories");
  console.log("   5. npm run media:split → chunks with full frontmatter");
}
