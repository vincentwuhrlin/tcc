/**
 * Strip empty chunk_categories from chunks so classify re-processes them.
 * Usage: tsx src/scripts/reset-empty-chunks.ts [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR, printHeader } from "../config.js";

printHeader();

const dryRun = process.argv.includes("--dry-run");

let fixed = 0;
let scanned = 0;

for (const sub of ["documents/chunks", "videos/chunks"]) {
  const dir = join(OUTPUT_DIR, sub);
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      scanned++;
      const path = join(dir, file);
      const raw = readFileSync(path, "utf-8");

      const fmEnd = raw.indexOf("\n---\n", 4);
      if (fmEnd === -1) continue;

      const fmText = raw.substring(4, fmEnd);

      // Match: "chunk_categories: []" (inline empty array)
      if (!fmText.includes("chunk_categories: []")) continue;

      const body = raw.substring(fmEnd + 5);
      const lines = fmText.split("\n");
      const idx = lines.findIndex((l) => l.startsWith("chunk_categories:"));
      if (idx === -1) continue;

      lines.splice(idx, 1);
      const newFm = lines.join("\n");
      if (!dryRun) {
        writeFileSync(path, `---\n${newFm}\n---\n${body}`);
      }
      fixed++;
      if (fixed <= 10) console.log(`   ${dryRun ? "[dry]" : "✅"} ${file}`);
    }
  } catch { /* dir doesn't exist */ }
}

if (fixed > 10) console.log(`   ... and ${fixed - 10} more`);
console.log();
console.log(`${dryRun ? "🏜️  Dry run — " : "✅ "}${fixed} chunks with empty chunk_categories reset (${scanned} scanned)`);
if (dryRun) console.log("   Re-run without --dry-run to apply");
else if (fixed > 0) console.log("   Now run: pnpm run media:classify");
