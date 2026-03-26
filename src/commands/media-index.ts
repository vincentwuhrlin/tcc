import { writeFileSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR } from "../config.js";
import { scanMarkdownFiles, generateIndex } from "../common/media.js";

export async function mediaIndex(): Promise<void> {
  console.log("📋 Regenerating INDEX.md...");
  const index = generateIndex(scanMarkdownFiles());
  const indexPath = join(OUTPUT_DIR, "INDEX.md");
  writeFileSync(indexPath, index);
  console.log(`✅ ${indexPath}`);
}
