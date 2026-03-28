/**
 * TOC Parser — Extract document structure from marker-generated markdown.
 *
 * Three-level strategy:
 *   Level 1: Parse the TOC table that marker generates from the PDF's own TOC
 *   Level 2: Fall back to numbered headings in the body (# **2.1 Title**)
 *   Level 3: LLM normalization — send raw TOC to Claude for parsing
 *
 * Returns ExtractedHeading[] compatible with the split pipeline.
 */

import { llmCall } from "./llm.js";

// ── Types ────────────────────────────────────────────────────────────

export interface TocEntry {
  section: string;    // "2.3.1" (no trailing dot)
  title: string;      // cleaned title
  page: number | null;
  depth: number;      // number of parts in section: "2.3.1" → 3
  path: string;       // breadcrumb: "IEM / Setup / IEM Virtual"
}

export interface ExtractedHeading {
  depth: number;
  text: string;
  numbering: string;
  line: number;
}

export interface TocParseResult {
  headings: ExtractedHeading[];
  method: string;
  quality: number;   // 0–1, percentage of real titles (not placeholders)
  entries: TocEntry[];
}

// ── Level 1: TOC table parsing ──────────────────────────────────────

const SECTION_NUM_RE = /^(\d+(?:\.\d+)*)\.?\s*$/;
const SECTION_WITH_TITLE_RE = /^(\d+(?:\.\d+)*)\.?\s+(.+)/;

/**
 * Find all lines belonging to the TOC table section.
 * Handles multi-page TOCs with blank lines between table chunks.
 */
function findTocLines(lines: string[]): string[] {
  let tocStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/\*\*/g, "").replace(/<[^>]*>/g, "").trim();
    if (/^#{1,6}\s*(table of contents|contents)\s*$/i.test(stripped)) {
      tocStart = i + 1;
      break;
    }
  }
  if (tocStart === -1) return [];

  const tableLines: string[] = [];
  for (let i = tocStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("|")) {
      tableLines.push(line);
    } else if (line === "") {
      // Look ahead: if next non-empty line is a table row, skip the blank
      let nextNonEmpty = -1;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j].trim() !== "") { nextNonEmpty = j; break; }
      }
      if (nextNonEmpty !== -1 && lines[nextNonEmpty].trim().startsWith("|")) {
        continue;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return tableLines;
}

function parseTableRow(line: string): string[] {
  const parts = line.split("|").map((s) => s.trim());
  if (parts[0] === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((c) => /^[-:]+$/.test(c));
}

/**
 * Extract TOC entries from table rows.
 * Handles: multi-column, broken columns, <br>-compacted cells.
 */
interface TableExtractResult {
  entries: TocEntry[];
  orphanCount: number;  // total orphan sections from <br> cells
}

function extractFromTable(tableLines: string[]): TableExtractResult {
  const entries: TocEntry[] = [];
  let orphanCount = 0;

  for (const line of tableLines) {
    const cells = parseTableRow(line);
    if (isSeparatorRow(cells)) continue;

    // Handle <br>-compacted cells
    if (cells.some((c) => c.includes("<br>"))) {
      const result = extractBrEntries(cells);
      entries.push(...result.entries);
      orphanCount += result.orphans;
      continue;
    }

    let sectionNum: string | null = null;
    let title: string | null = null;
    let page: number | null = null;

    for (const cell of cells) {
      const cleaned = cell.replace(/<[^>]*>/g, "").replace(/\*{1,2}/g, "").trim();
      if (!cleaned) continue;

      // Pure section number
      const numMatch = cleaned.match(SECTION_NUM_RE);
      if (numMatch && !sectionNum) {
        sectionNum = numMatch[1].replace(/\.$/, "");
        continue;
      }

      // Section number with title ("3.2.1 IEM Virtual")
      const withTitleMatch = cleaned.match(SECTION_WITH_TITLE_RE);
      if (withTitleMatch && !sectionNum) {
        sectionNum = withTitleMatch[1].replace(/\.$/, "");
        title = withTitleMatch[2].trim();
        continue;
      }

      // Pure page number (handles "42" and ".6" formats)
      if (/^\.?\d+$/.test(cleaned) && !page) {
        page = parseInt(cleaned.replace(/^\./, ""), 10);
        continue;
      }

      // Otherwise it's (part of) the title
      if (!title) {
        title = cleaned;
      } else {
        const needsNoSpace = /[a-z]$/.test(title) && /^[a-z]/.test(cleaned);
        title += (needsNoSpace ? "" : " ") + cleaned;
      }
    }

    if (sectionNum && title) {
      title = cleanTitle(title);
      if (title && !isGarbageTitle(title)) {
        entries.push({ section: sectionNum, title, page, depth: sectionNum.split(".").length });
      }
    }
  }

  return { entries, orphanCount };
}

interface BrExtractResult {
  entries: TocEntry[];
  orphans: number;   // sections found without a matching title
}

function extractBrEntries(cells: string[]): BrExtractResult {
  const entries: TocEntry[] = [];
  let sections: string[] = [];
  let titles: string[] = [];
  let pages: number[] = [];

  for (const cell of cells) {
    const cleaned = cell.replace(/\*{1,2}/g, "").trim();
    if (cleaned.includes("<br>")) {
      const parts = cleaned.split("<br>").map((s) => s.trim()).filter(Boolean);
      if (parts.every((p) => SECTION_NUM_RE.test(p) || SECTION_WITH_TITLE_RE.test(p))) {
        for (const p of parts) {
          const m = p.match(SECTION_NUM_RE);
          if (m) { sections.push(m[1].replace(/\.$/, "")); }
          else {
            const m2 = p.match(SECTION_WITH_TITLE_RE);
            if (m2) { sections.push(m2[1].replace(/\.$/, "")); titles.push(m2[2].trim()); }
          }
        }
      } else if (parts.some((p) => /^\d+$/.test(p))) {
        pages = parts.filter((p) => /^\d+$/.test(p)).map(Number);
      } else {
        titles = parts;
      }
    } else {
      const c = cleaned.replace(/<[^>]*>/g, "").trim();
      if (!c) continue;
      if (SECTION_NUM_RE.test(c)) {
        sections.push(c.replace(/\.$/, ""));
      } else if (/^\d+$/.test(c)) {
        pages.push(parseInt(c, 10));
      } else if (c.length > 1) {
        titles.push(...c.split(/\s{2,}/).filter(Boolean));
      }
    }
  }

  let orphans = 0;
  for (let i = 0; i < sections.length; i++) {
    const rawTitle = titles[i];
    if (!rawTitle) { orphans++; continue; } // skip — will be filled from body headings
    const title = cleanTitle(rawTitle);
    if (title && !isGarbageTitle(title)) {
      entries.push({
        section: sections[i],
        title,
        page: pages[i] || null,
        depth: sections[i].split(".").length,
      });
    }
  }

  return { entries, orphans };
}

// ── Title cleaning ──────────────────────────────────────────────────

function cleanTitle(raw: string): string {
  let s = raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    // Strip markdown links: [text](#url) → text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Strip orphan anchors and brackets
    .replace(/\(#[^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[.…]+$/, "")           // trailing dots
    .replace(/\s*\.\s*$/, "")        // trailing " ."
    .replace(/\s+\d{1,3}\s*$/, "")   // trailing page numbers ("Introduction 4")
    .replace(/(\D)\d{1,3}$/, "$1")   // page glued to text ("Considerations11")
    // Strip TIA Portal garbage: page_number(>10) + text + page_numbers(>10)
    .replace(/\s+\d{2,3}\s+\S+(?:\s+\S+)*\s+\d{2,3}(?:\s+\d{2,3}){2,}.*$/, "")
    .replace(/(\s+\d{2,3}){3,}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  // Truncate only if over 120 chars, and don't cut mid-word
  if (s.length > 120) {
    s = s.substring(0, 120).replace(/\s+\S*$/, "").trim();
  }

  return s;
}

function isGarbageTitle(title: string): boolean {
  return !title
    || title.length < 2
    || /^[·•.\-\s|IF]+$/.test(title)
    || /^I\s+I$/.test(title)
    || /^Section \d/.test(title)      // placeholder from <br> fallback
    || /^\d+(\s+\d+){3,}/.test(title);  // just numbers ("2 3 4 5 6 7")
}

// ── Quality assessment ──────────────────────────────────────────────

function tocQuality(entries: TocEntry[]): number {
  if (entries.length === 0) return 0;
  const placeholders = entries.filter((e) => /^Section \d/.test(e.title)).length;
  return 1 - placeholders / entries.length;
}

// ── Augment TOC with body headings ─────────────────────────────────
//
// After TOC table parsing, some sections may be missing (orphans from
// <br>-compacted cells without individual titles). We scan the body
// headings and add any numbered sections not already covered by the TOC.

function compareSections(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? -1;
    const nb = pb[i] ?? -1;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function augmentWithBodyHeadings(tocEntries: TocEntry[], lines: string[]): TocEntry[] {
  const covered = new Set(tocEntries.map((e) => e.section));
  const bodyEntries = extractFromHeadings(lines);

  let added = 0;
  for (const be of bodyEntries) {
    if (!covered.has(be.section)) {
      tocEntries.push(be);
      covered.add(be.section);
      added++;
    }
  }

  if (added > 0) {
    tocEntries.sort((a, b) => compareSections(a.section, b.section));
  }

  return tocEntries;
}

// ── Level 2: Heading fallback ───────────────────────────────────────

function extractFromHeadings(lines: string[]): TocEntry[] {
  const entries: TocEntry[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    let cleaned: string | null = null;

    if (lines[i].startsWith("#")) {
      // ATX headings: # **2.1 Title**, ## <span>2.1 Title, etc.
      cleaned = lines[i]
        .replace(/^#{1,6}\s*/, "")
        .replace(/<[^>]*>/g, "")
        .replace(/\*{1,2}/g, "")
        .trim();
    } else {
      // Bold-numbered lines that marker produces: **2.1 Title**
      const boldMatch = lines[i].match(/^\*\*([A-Z]?\d+(?:\.\d+)*)\s+(.+?)\*\*\s*$/);
      if (boldMatch) {
        cleaned = `${boldMatch[1]} ${boldMatch[2]}`;
      }
    }

    if (!cleaned) continue;

    const m = cleaned.match(/^([A-Z]?\d+(?:\.\d+)*)\.?\s+(.+)/);
    if (m) {
      const section = m[1].replace(/\.$/, "");
      const title = cleanTitle(m[2]);
      if (!seen.has(section) && !isGarbageTitle(title)) {
        if (!/^(NOTICE|WARNING|CAUTION|DANGER|NOTE)$/i.test(title)) {
          seen.add(section);
          entries.push({
            section,
            title,
            page: null,
            depth: section.split(".").length,
          });
        }
      }
    }
  }

  return entries;
}

// ── Level 3: LLM fallback ───────────────────────────────────────────

const TOC_LLM_SYSTEM = `You are a document structure parser. You receive a raw markdown Table of Contents extracted from a PDF by OCR.
Your job is to parse it into a clean JSON array of section entries.

Rules:
- Extract the section number (e.g. "2.3.1"), the title, and the page number
- Section numbers may have trailing dots ("2.3.1.") — remove them
- Page numbers may be glued to titles ("Considerations11") — separate them
- Some chapter-level entries may not have section numbers — infer them from document order (1, 2, 3...)
- Ignore separator rows (|---|---|)
- Ignore garbage: empty titles, punctuation-only, OCR noise

Respond ONLY with a JSON array, no markdown fences, no preamble:
[{"section":"1","title":"Introduction","page":6},{"section":"1.1","title":"Purpose","page":6}]`;

async function extractWithLlm(tocRawLines: string[]): Promise<TocEntry[]> {
  const tocText = tocRawLines.join("\n");
  const userMessage = `Parse this Table of Contents:\n\n${tocText}`;

  try {
    const response = await llmCall(TOC_LLM_SYSTEM, userMessage, 8192);
    const cleaned = response.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned) as Array<{ section: string; title: string; page?: number }>;

    return parsed
      .filter((e) => e.section && e.title)
      .map((e) => ({
        section: e.section.replace(/\.$/, ""),
        title: cleanTitle(e.title),
        page: e.page ?? null,
        depth: e.section.split(".").length,
      }))
      .filter((e) => !isGarbageTitle(e.title));
  } catch (err) {
    console.log(`   ⚠️  LLM TOC parsing failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ── Build breadcrumb hierarchy ──────────────────────────────────────

function buildHierarchy(entries: TocEntry[]): TocEntry[] {
  return entries.map((entry) => {
    const parts = entry.section.split(".");
    const breadcrumb: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      const parentSection = parts.slice(0, i).join(".");
      const parent = entries.find((e) => e.section === parentSection);
      if (parent) breadcrumb.push(parent.title);
    }
    breadcrumb.push(entry.title);
    return { ...entry, path: breadcrumb.join(" / ") };
  });
}

// ── Match TOC entries to body lines ─────────────────────────────────
//
// The TOC gives us WHAT sections exist. We need to find WHERE they
// start in the body to produce line numbers for the split pipeline.

function matchTocToBody(entries: TocEntry[], lines: string[]): ExtractedHeading[] {
  const headings: ExtractedHeading[] = [];

  // Track the minimum line to search from — ensures matches are in document order
  let searchFrom = 0;

  for (const entry of entries) {
    const sectionNum = entry.section;
    const escaped = sectionNum.replace(/\./g, "\\.");

    // For depth-1 sections (just "1", "2", "3"), single digits match too many
    // false positives (numbered lists, code). Require bold format + title word.
    const needsTitleCheck = entry.depth === 1;

    // Extract a title keyword for verification (first word > 3 chars)
    const titleWords = entry.title.split(/\s+/).filter((w) => w.length > 3);
    const titleKeyword = titleWords[0]?.replace(/[^a-zA-Z]/g, "") || "";

    // Match: # **2.1 Title**, ## 2.1. Title, # <span>2.1 Title, etc.
    const re = new RegExp(`^#{1,6}\\s*(?:<[^>]*>)*\\s*\\*{0,2}\\s*${escaped}\\.?\\s`);

    let foundLine = -1;

    for (let i = searchFrom; i < lines.length; i++) {
      if (re.test(lines[i])) {
        if (needsTitleCheck && titleKeyword) {
          // Verify the line also contains a word from the title
          if (!lines[i].toLowerCase().includes(titleKeyword.toLowerCase())) {
            continue; // false positive — skip, keep searching
          }
        }
        foundLine = i;
        break;
      }
    }

    // Second pass: try bold-numbered line **2.1 Title**
    if (foundLine === -1) {
      const boldRe = new RegExp(`^\\*\\*${escaped}\\.?\\s`);
      for (let i = searchFrom; i < lines.length; i++) {
        if (boldRe.test(lines[i])) {
          if (needsTitleCheck && titleKeyword) {
            if (!lines[i].toLowerCase().includes(titleKeyword.toLowerCase())) {
              continue;
            }
          }
          foundLine = i;
          break;
        }
      }
    }

    if (foundLine >= 0) {
      headings.push({
        depth: entry.depth,
        text: entry.title,
        numbering: entry.section,
        line: foundLine,
      });
      searchFrom = foundLine + 1;
    }
    // If not found, skip — the heading might be missing from the body
    // (marker sometimes drops headings or merges them)
  }

  // Monotonic scan guarantees order — just deduplicate lines as safety net
  const deduped: ExtractedHeading[] = [];
  const seenLines = new Set<number>();
  for (const h of headings) {
    if (!seenLines.has(h.line)) {
      deduped.push(h);
      seenLines.add(h.line);
    }
  }

  return deduped;
}

// ── Main: 3-level TOC parsing ───────────────────────────────────────

export interface TocParseOptions {
  maxDepth?: number;   // max section depth to include (default: from config)
  llmFallback?: boolean; // enable LLM fallback (default: true)
}

export async function parseToc(
  content: string,
  options: TocParseOptions = {},
): Promise<TocParseResult> {
  const { maxDepth = 99, llmFallback = true } = options;
  const lines = content.split("\n");

  // ── Level 1: TOC table ──────────────────────────────────────────
  const tocLines = findTocLines(lines);
  let entries: TocEntry[] = [];
  let method = "";

  if (tocLines.length > 2) {
    const { entries: tableEntries, orphanCount } = extractFromTable(tocLines);
    entries = tableEntries;

    // Augment only if <br> cells had orphan sections without titles
    if (orphanCount > 0) {
      entries = augmentWithBodyHeadings(entries, lines);
    }

    const quality = tocQuality(entries);

    if (quality >= 0.7) {
      method = `toc-table (quality: ${Math.round(quality * 100)}%)`;

      // Filter to maxDepth and build hierarchy
      entries = entries.filter((e) => e.depth <= maxDepth);
      entries = buildHierarchy(entries);

      // Match to body
      const headings = matchTocToBody(entries, lines);
      return { headings, method, quality, entries };
    }

    // TOC quality too low — try Level 2
    const headingEntries = extractFromHeadings(lines);
    if (headingEntries.length >= entries.length * 0.5) {
      entries = headingEntries;
      method = `headings-fallback (toc quality: ${Math.round(quality * 100)}%)`;
    } else {
      // Keep the low-quality TOC but try LLM if enabled
      if (llmFallback && tocLines.length > 0) {
        console.log(`   🤖 TOC quality ${Math.round(quality * 100)}% — trying LLM normalization...`);
        const llmEntries = await extractWithLlm(tocLines);
        if (llmEntries.length > entries.length * 0.5) {
          entries = llmEntries;
          method = `llm-normalized (from ${tocLines.length} raw TOC lines)`;
        } else {
          method = `toc-table (quality: ${Math.round(quality * 100)}%, kept — LLM didn't improve)`;
        }
      } else {
        method = `toc-table (quality: ${Math.round(quality * 100)}%, kept — headings worse)`;
      }
    }
  }

  // ── Level 2: Heading fallback (no TOC table) ────────────────────
  if (entries.length < 3) {
    entries = extractFromHeadings(lines);
    if (entries.length >= 3) {
      method = "headings-fallback (no toc table)";
    }
  }

  // ── Level 3: LLM on raw headings (last resort) ─────────────────
  if (entries.length < 3 && llmFallback && tocLines.length > 0) {
    console.log(`   🤖 Too few entries — trying LLM on raw TOC...`);
    entries = await extractWithLlm(tocLines);
    if (entries.length >= 3) {
      method = `llm-fallback (${entries.length} entries from LLM)`;
    }
  }

  // ── Final: filter, hierarchy, match ─────────────────────────────
  if (entries.length < 3) {
    return { headings: [], method: method || "none", quality: 0, entries: [] };
  }

  entries = entries.filter((e) => e.depth <= maxDepth);
  entries = buildHierarchy(entries);
  const quality = tocQuality(entries);
  const headings = matchTocToBody(entries, lines);

  return { headings, method, quality, entries };
}
