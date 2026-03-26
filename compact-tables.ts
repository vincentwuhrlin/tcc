/**
 * compact-tables.ts — Fix marker table whitespace bloat in existing .md files.
 *
 * Usage:  npx tsx compact-tables.ts
 *    or:  npm run media:fix:tables   (add to package.json scripts)
 *
 * Scans output/documents/ and output/documents/splits/ for .md files,
 * compacts excessive whitespace in table rows (| ... |).
 * Reports per-file savings and total token reduction.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR } from "./src/config.js";

function compactTableWhitespace(content: string): string {
  return content.replace(/^(\|.*\|)$/gm, (line) => {
    return line
      .split("|")
      .map((cell) => cell.replace(/  +/g, " ").trim())
      .join(" | ")
      .replace(/^\s*\| /, "| ")
      .replace(/ \|\s*$/, " |");
  });
}

function scanMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f));
}

// ── Main ──────────────────────────────────────────────────────────────

const dirs = [
  join(OUTPUT_DIR, "documents"),
  join(OUTPUT_DIR, "documents", "splits"),
  join(OUTPUT_DIR, "videos"),
];

const files = dirs.flatMap(scanMdFiles);

if (files.length === 0) {
  console.log("⚠️  No .md files found");
  process.exit(0);
}

console.log(`📄 Scanning ${files.length} files for table whitespace bloat...`);
console.log();

let totalBefore = 0;
let totalAfter = 0;
let fixed = 0;
let skipped = 0;

for (const file of files) {
  const before = readFileSync(file, "utf-8");
  const after = compactTableWhitespace(before);

  totalBefore += before.length;
  totalAfter += after.length;

  if (after.length < before.length) {
    const savedPct = Math.round((1 - after.length / before.length) * 100);
    const savedTokensK = Math.round((before.length - after.length) / 4 / 1000);
    const name = file.split(/[/\\]/).slice(-2).join("/");
    console.log(`   ✅ ${name} — ${savedPct}% smaller (~${savedTokensK}k tokens saved)`);
    writeFileSync(file, after);
    fixed++;
  } else {
    skipped++;
  }
}

const totalSavedK = Math.round((totalBefore - totalAfter) / 4 / 1000);
const totalSavedPct = totalBefore > 0 ? Math.round((1 - totalAfter / totalBefore) * 100) : 0;

console.log();
console.log(`═══════════════════════════════════════════════════`);
console.log(`📊 Fixed: ${fixed} files | Skipped: ${skipped} (no bloat)`);
console.log(`📉 Total: ${Math.round(totalBefore / 1000)}k → ${Math.round(totalAfter / 1000)}k chars (${totalSavedPct}% reduction)`);
console.log(`💰 Saved: ~${totalSavedK}k tokens across the corpus`);
console.log(`═══════════════════════════════════════════════════`);
