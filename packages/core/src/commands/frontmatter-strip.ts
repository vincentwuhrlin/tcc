/**
 * media:frontmatter:strip — Remove all YAML frontmatter from workspace .md files.
 *
 * Usage:
 *   npm run media:frontmatter:strip      Strip all frontmatter
 *   npm run media:frontmatter:strip:dry  Preview (dry run)
 *
 * Scans documents/, documents/splits/, and videos/ under media/output.
 * Preserves the body content — only the --- block is removed.
 */
import { readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { scanMarkdownFiles, stripFrontmatter } from "../common/media.js";
import { loadWorkspaceInfo, WORKSPACE, WORKSPACE_NAME } from "../config.js";

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export async function frontmatterStrip(): Promise<void> {
  const args = process.argv.slice(3);
  const dryRun = args.includes("--dry-run");

  const allFiles = scanMarkdownFiles();

  // Count files with frontmatter first
  let withFm = 0;
  let withoutFm = 0;
  const toStrip: { path: string; dir: string; name: string; body: string }[] = [];

  for (const f of allFiles) {
    const raw = readFileSync(f.path, "utf-8");
    const { body, existingFm } = stripFrontmatter(raw);

    if (!existingFm) {
      withoutFm++;
    } else {
      withFm++;
      toStrip.push({ path: f.path, dir: f.dir, name: f.name, body });
    }
  }

  if (withFm === 0) {
    console.log(`\n✅ No frontmatter found in ${allFiles.length} files — nothing to strip`);
    return;
  }

  // Dry run: list and exit
  if (dryRun) {
    for (const f of toStrip) console.log(`  📄 ${f.dir}/${f.name}`);
    console.log(`\n🔍 Dry run — ${withFm} files have frontmatter, ${withoutFm} have none (${allFiles.length} total)`);
    console.log(`   Run  npm run media:frontmatter:strip  to strip`);
    return;
  }

  // Guard: show workspace and ask confirmation
  const info = loadWorkspaceInfo();
  const label = info ? `${info.name}: ${info.title}` : WORKSPACE_NAME;
  console.log();
  console.log(`⚠️  About to strip frontmatter from ${withFm} files in:`);
  console.log(`   📂 ${label}`);
  console.log(`   ${WORKSPACE}`);
  console.log();

  const ok = await confirm("   Continue? (y/N) ");
  if (!ok) {
    console.log("\n🚫 Cancelled");
    return;
  }

  // Strip
  for (const f of toStrip) {
    writeFileSync(f.path, f.body, "utf-8");
  }

  console.log(`\n✅ Stripped frontmatter from ${withFm} files (${withoutFm} had none, ${allFiles.length} total)`);
}
