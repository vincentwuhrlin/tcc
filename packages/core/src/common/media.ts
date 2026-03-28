/**
 * Shared utilities for media processing commands.
 * Scanning, frontmatter, content preparation, index generation.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  OUTPUT_DIR, MEDIA_FILE_MODE,
  MEDIA_SUMMARY_HEAD, MEDIA_SUMMARY_MID, MEDIA_SUMMARY_TAIL, PLAN_FILE,
} from "../config.js";

// ── Types ────────────────────────────────────────────────────────────

export interface MdFile {
  path: string;
  name: string;
  dir: string;
}

export interface TagResult {
  title: string;
  source_type: string;
  components: string[];
  project_phases: number[];
  categories: string[];
  tags: string[];
  quality: string;
  language: string;
  summary: string;
  key_facts: string[];
}

// ── ID mapping (for discovery reports) ──────────────────────────────

export const idToPath = new Map<string, { dir: string; name: string }>();

export function sanitizeCustomId(path: string): string {
  const cleaned = path.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (cleaned.length <= 64) return cleaned || "unknown";
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  const hex = Math.abs(hash).toString(36).slice(0, 8);
  return `${hex}_${cleaned.slice(-(64 - hex.length - 1))}`;
}

// ── Scanning ────────────────────────────────────────────────────────

export function scanMarkdownFiles(): MdFile[] {
  const files: MdFile[] = [];
  for (const sub of ["documents", "documents/splits", "videos"]) {
    const dir = join(OUTPUT_DIR, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      files.push({ path: join(dir, f), name: f, dir: sub });
    }
  }
  return files;
}

// ── Frontmatter ─────────────────────────────────────────────────────

export function hasClassificationFrontmatter(content: string): boolean {
  if (!content.startsWith("---\n")) return false;
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return false;
  const fm = content.slice(0, endIdx);
  return fm.includes("categories:") || fm.includes("suggested_category:");
}

export function stripFrontmatter(raw: string): { body: string; existingFm: string } {
  if (!raw.startsWith("---\n")) return { body: raw, existingFm: "" };
  const endIdx = raw.indexOf("\n---\n", 4);
  if (endIdx === -1) return { body: raw, existingFm: "" };
  return { body: raw.slice(endIdx + 5), existingFm: raw.slice(4, endIdx) };
}

export function buildFrontmatter(meta: TagResult, sourceFile: string, dir: string, existingFm: string = ""): string {
  const yamlTags = meta.tags.map((t) => `  - ${t}`).join("\n");
  const yamlCats = (meta.categories ?? []).map((c) => `  - ${c}`).join("\n");
  const yamlComponents = (meta.components ?? []).map((c) => `  - ${c}`).join("\n");
  const yamlPhases = (meta.project_phases ?? []).map((p) => `  - ${p}`).join("\n");
  const yamlFacts = (meta.key_facts ?? []).map((f) => `  - ${JSON.stringify(f)}`).join("\n");
  const escapedTitle = (meta.title ?? "").replace(/"/g, '\\"');
  const escapedSummary = (meta.summary ?? "").replace(/"/g, '\\"');
  const extraFields = existingFm ? "\n" + existingFm : "";
  return [
    "---", `title: "${escapedTitle}"`, `source_type: ${meta.source_type}`, `source_dir: ${dir}`,
    `components:`, yamlComponents, `project_phases:`, yamlPhases,
    `quality: ${meta.quality}`, `language: ${meta.language}`,
    `categories:`, yamlCats, `tags:`, yamlTags,
    `summary: "${escapedSummary}"`, `key_facts:`, yamlFacts,
    `tagged_at: "${new Date().toISOString()}"`,
    extraFields ? extraFields : null, "---", "",
  ].filter((l) => l !== null).join("\n");
}

// ── Content preparation ─────────────────────────────────────────────

export function prepareContent(raw: string): string {
  if (MEDIA_FILE_MODE === "full") return raw;
  const budget = MEDIA_SUMMARY_HEAD + MEDIA_SUMMARY_MID + MEDIA_SUMMARY_TAIL;
  if (raw.length <= budget + 300) return raw;
  const head = raw.slice(0, MEDIA_SUMMARY_HEAD);
  const midStart = Math.floor((raw.length - MEDIA_SUMMARY_MID) / 2);
  const mid = raw.slice(midStart, midStart + MEDIA_SUMMARY_MID);
  const tail = raw.slice(-MEDIA_SUMMARY_TAIL);
  const gap1 = midStart - MEDIA_SUMMARY_HEAD;
  const gap2 = raw.length - MEDIA_SUMMARY_TAIL - (midStart + MEDIA_SUMMARY_MID);
  return [head, `\n\n[... ~${Math.round(gap1 / 4)} tokens skipped ...]\n\n`, mid, `\n\n[... ~${Math.round(gap2 / 4)} tokens skipped ...]\n\n`, tail].join("");
}

// ── JSON response parsing ───────────────────────────────────────────

export function parseJsonResponse(text: string): TagResult | null {
  try {
    return JSON.parse(text.replace(/^```json?\n?/m, "").replace(/\n?```$/m, "").trim());
  } catch { return null; }
}

// ── Plan loading ────────────────────────────────────────────────────

export function loadPlan(): string {
  if (!existsSync(PLAN_FILE)) {
    console.error(`❌ Plan file not found: ${PLAN_FILE}`);
    console.error("   Create PLAN.md or set PLAN_FILE in .env");
    process.exit(1);
  }
  return readFileSync(PLAN_FILE, "utf-8");
}

// ── Index generation ────────────────────────────────────────────────

export function generateIndex(files: MdFile[]): string {
  const entries: { meta: TagResult; name: string; dir: string }[] = [];
  for (const f of files) {
    const content = readFileSync(f.path, "utf-8");
    if (!hasClassificationFrontmatter(content)) continue;
    const endIdx = content.indexOf("\n---\n", 4);
    if (endIdx === -1) continue;
    const yaml = content.substring(4, endIdx);
    const meta: Record<string, unknown> = {};
    let currentKey = "", currentArray: string[] = [];
    for (const line of yaml.split("\n")) {
      const kvMatch = line.match(/^(\w[\w_]*):(.*)$/);
      const arrayItemMatch = line.match(/^\s+- (.+)$/);
      if (kvMatch) {
        if (currentKey && currentArray.length > 0) { meta[currentKey] = currentArray; currentArray = []; }
        currentKey = kvMatch[1];
        const val = kvMatch[2].trim();
        if (val !== "") { meta[currentKey] = val.replace(/^"(.*)"$/, "$1"); currentKey = ""; }
      } else if (arrayItemMatch) {
        currentArray.push(arrayItemMatch[1].replace(/^"(.*)"$/, "$1"));
      }
    }
    if (currentKey && currentArray.length > 0) meta[currentKey] = currentArray;
    entries.push({ meta: meta as unknown as TagResult, name: f.name, dir: f.dir });
  }

  const byCategory = new Map<string, typeof entries>();
  for (const e of entries) {
    const cats = Array.isArray(e.meta.categories) ? e.meta.categories : [];
    if (cats.length === 0) { const arr = byCategory.get("uncategorized") ?? []; arr.push(e); byCategory.set("uncategorized", arr); }
    for (const cat of cats) { const arr = byCategory.get(cat) ?? []; arr.push(e); byCategory.set(cat, arr); }
  }

  const lines: string[] = ["# Knowledge Base Index", "", `> Auto-generated on ${new Date().toISOString()}`, `> ${entries.length} documents indexed`, "", "## By Category", ""];
  for (const cat of [...byCategory.keys()].sort()) {
    const catEntries = byCategory.get(cat)!;
    lines.push(`### ${cat}`, "");
    for (const e of catEntries) {
      const quality = typeof e.meta.quality === "string" ? e.meta.quality : "?";
      const icon = quality === "high" ? "🟢" : quality === "medium" ? "🟡" : "🔴";
      const title = typeof e.meta.title === "string" ? e.meta.title : e.name;
      lines.push(`- ${icon} **${title}** — \`${e.dir}/${e.name}\``);
      if (typeof e.meta.summary === "string") lines.push(`  ${e.meta.summary}`);
    }
    lines.push("");
  }

  const qc = { high: 0, medium: 0, low: 0 };
  for (const e of entries) { const q = e.meta.quality as keyof typeof qc; if (q in qc) qc[q]++; }
  lines.push("## Stats", "", "| Quality | Count |", "|---------|-------|",
    `| 🟢 High | ${qc.high} |`, `| 🟡 Medium | ${qc.medium} |`, `| 🔴 Low | ${qc.low} |`,
    `| **Total** | **${entries.length}** |`, "");
  return lines.join("\n");
}
