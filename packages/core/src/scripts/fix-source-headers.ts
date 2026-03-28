/**
 * Fix leftover > headers in discovered files — strip > Source/Pages/Duration/Language/Size
 * lines from the body (they should be in the frontmatter only).
 *
 * Usage: npx tsx src/scripts/fix-source-headers.ts
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR } from "../config.js";

const HEADER_RE = /^> (Source|Pages|Size|Duration|Language):.*$/;

const dirs = [join(OUTPUT_DIR, "documents"), join(OUTPUT_DIR, "videos")];
let fixed = 0;
let scanned = 0;

for (const dir of dirs) {
  if (!existsSync(dir)) continue;

  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    scanned++;
    const path = join(dir, f);
    const content = readFileSync(path, "utf-8");

    // Only process files with frontmatter
    if (!content.startsWith("---\n")) continue;
    const endIdx = content.indexOf("\n---\n", 4);
    if (endIdx === -1) continue;

    const frontmatter = content.slice(0, endIdx + 5);
    const body = content.slice(endIdx + 5);

    const lines = body.split("\n");
    const headerLines = new Set<number>();

    for (let i = 0; i < Math.min(lines.length, 20); i++) {
      if (HEADER_RE.test(lines[i])) headerLines.add(i);
    }

    if (headerLines.size === 0) continue;

    const filtered = lines.filter((line, i) => {
      if (headerLines.has(i)) return false;
      // Remove blank lines immediately adjacent to headers
      if (line.trim() === "" && (headerLines.has(i + 1) || headerLines.has(i - 1))) return false;
      return true;
    });

    writeFileSync(path, frontmatter + filtered.join("\n"));
    fixed++;
  }
}

console.log(`✅ ${fixed} files fixed (${scanned} scanned)`);
