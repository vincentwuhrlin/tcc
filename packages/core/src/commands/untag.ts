/**
 * untag — Strip YAML frontmatter from all tagged .md files.
 * Useful to restart the tagging pipeline from scratch.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR, printHeader } from "../config.js";

export async function untag(): Promise<void> {
  printHeader();
  const dirs = [
    join(OUTPUT_DIR, "documents"),
    join(OUTPUT_DIR, "documents", "splits"),
    join(OUTPUT_DIR, "videos"),
  ];

  let count = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const path = join(dir, f);
      const content = readFileSync(path, "utf-8");
      if (!content.startsWith("---\n")) continue;
      const endIdx = content.indexOf("\n---\n", 4);
      if (endIdx === -1) continue;
      const body = content.slice(endIdx + 5);
      writeFileSync(path, body);
      count++;
      console.log(`  ✂️  ${f}`);
    }
  }

  console.log(`\n✅ Stripped frontmatter from ${count} file(s)`);
}
