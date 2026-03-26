#!/usr/bin/env node
// Extract first 1000 lines of docs over a size threshold for split analysis
// Usage: npx tsx extract-heads.ts [min-tokens] [lines]
// Example: npx tsx extract-heads.ts 50000 1000

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";

const OUTPUT_DIR = process.env.RUNPOD_OUTPUT 
  ?? join(process.env.RUNPOD_MEDIA_DIR ?? "../media", "output");

const MIN_TOKENS = parseInt(process.argv[2] ?? "50000", 10);  // ~50k tokens = ~200k chars
const MAX_LINES = parseInt(process.argv[3] ?? "1000", 10);
const MIN_CHARS = MIN_TOKENS * 4;

const TMP_DIR = join(process.cwd(), "tmp", "heads");
mkdirSync(TMP_DIR, { recursive: true });

let extracted = 0;

for (const sub of ["documents", "videos"]) {
  const dir = join(OUTPUT_DIR, sub);
  if (!existsSync(dir)) continue;

  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const fullPath = join(dir, f);
    const content = readFileSync(fullPath, "utf-8");

    if (content.length < MIN_CHARS) continue;

    const lines = content.split("\n").slice(0, MAX_LINES);
    const head = lines.join("\n");
    const totalLines = content.split("\n").length;
    const tokens = Math.round(content.length / 4);

    const outName = `${sub}__${f}`;
    writeFileSync(join(TMP_DIR, outName), head);

    console.log(`📄 ${sub}/${f}  (~${Math.round(tokens / 1000)}k tokens, ${totalLines} lines → ${lines.length} extracted)`);
    extracted++;
  }
}

console.log();
console.log(`✅ ${extracted} file(s) extracted to ${TMP_DIR}`);
console.log(`   Threshold: >${Math.round(MIN_TOKENS / 1000)}k tokens | Lines: ${MAX_LINES}`);
