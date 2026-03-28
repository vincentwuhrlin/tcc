/**
 * Fix source_origin paths in frontmatters — strip path, keep filename only.
 * URLs (https://) are left untouched.
 *
 * Usage: npx tsx src/scripts/fix-source-origin.ts
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR } from "../config.js";

const dirs = [join(OUTPUT_DIR, "documents"), join(OUTPUT_DIR, "videos")];
let fixed = 0;
let scanned = 0;

for (const dir of dirs) {
  if (!existsSync(dir)) continue;

  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    scanned++;
    const path = join(dir, f);
    const content = readFileSync(path, "utf-8");

    const updated = content.replace(
      /^(source_origin: )(?!https?:\/\/).*[/\\]([^/\\]+)$/m,
      "$1$2",
    );

    if (updated !== content) {
      writeFileSync(path, updated);
      fixed++;
    }
  }
}

console.log(`✅ ${fixed} files fixed (${scanned} scanned)`);
