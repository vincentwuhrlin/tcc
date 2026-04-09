/**
 * workspace:clean — Strip all dynamic user data from workspace.db before
 * sharing the workspace with a team.
 *
 * ⚠️  REQUIRES --workspace=<name> explicitly. This is a destructive operation
 * and we refuse to fall back to .env WORKSPACE to avoid accidents.
 *
 * Wipes from workspace.db:
 *   • sessions + messages         (chat history)
 *   • message_embeddings          (semantic search index)
 *   • memories                    (extracted user facts)
 *   • app_settings                (memories toggle, etc.)
 *   • token_usage                 (per-call tracking)
 *
 * With --with-qa, also wipes:
 *   • qa/ directory               (markdown files)
 *   • embeddings WHERE id LIKE 'QA__%'  (QA-derived chunks)
 *
 * Always preserves:
 *   • embeddings from the document corpus (the shared knowledge base)
 *   • All files under media/ and context/
 *
 * Usage:
 *   pnpm workspace:clean --workspace=noa                   # interactive confirm
 *   pnpm workspace:clean --workspace=noa --force           # skip confirmation
 *   pnpm workspace:clean --workspace=noa --dry-run         # preview only
 *   pnpm workspace:clean --workspace=noa --with-qa         # also wipe QA
 */
import { printHeader, WORKSPACE, WORKSPACE_NAME, WORKSPACE_FLAG_EXPLICIT } from "../config.js";
import { getDb } from "../common/db.js";
import { join } from "path";
import { existsSync, rmSync, statSync, readdirSync } from "fs";
import { createInterface } from "readline/promises";

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DRY_RUN = args.includes("--dry-run");
const WITH_QA = args.includes("--with-qa");

interface TableStats {
  name: string;
  label: string;
  count: number;
}

function fileSize(path: string): string {
  try {
    const bytes = statSync(path).size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  } catch {
    return "?";
  }
}

async function confirm(prompt: string): Promise<boolean> {
  if (FORCE) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(prompt);
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

export async function workspaceClean(): Promise<void> {
  // ── Guard: require --workspace=<name> explicitly ──────────────────
  if (!WORKSPACE_FLAG_EXPLICIT) {
    console.error("❌ --workspace=<name> is required for this command.");
    console.error();
    console.error("This is a destructive operation. You must explicitly");
    console.error("specify which workspace to clean, so you don't accidentally");
    console.error("wipe the wrong one (falling back to .env WORKSPACE is disabled).");
    console.error();
    console.error("Usage:");
    console.error("  pnpm workspace:clean --workspace=<name>");
    console.error("  pnpm workspace:clean --workspace=<name> --dry-run");
    console.error("  pnpm workspace:clean --workspace=<name> --with-qa");
    console.error("  pnpm workspace:clean --workspace=<name> --force");
    process.exit(1);
  }

  // ── Guard: workspace must exist ───────────────────────────────────
  if (!existsSync(WORKSPACE)) {
    console.error(`❌ Workspace not found: ${WORKSPACE}`);
    console.error(`   (Resolved from --workspace=${WORKSPACE_NAME})`);
    process.exit(1);
  }

  printHeader();

  const db = getDb();

  console.log(`🧹 Clean workspace: ${WORKSPACE_NAME}`);
  console.log(`   Path: ${WORKSPACE}`);
  console.log();

  // ── Count rows in dynamic tables ───────────────────────────────────
  const dynamicTables: TableStats[] = [
    { name: "sessions",           label: "Chat sessions",          count: 0 },
    { name: "messages",           label: "Chat messages",          count: 0 },
    { name: "message_embeddings", label: "Message search index",   count: 0 },
    { name: "memories",           label: "Extracted memories",     count: 0 },
    { name: "app_settings",       label: "App settings",           count: 0 },
    { name: "token_usage",        label: "Token usage history",    count: 0 },
  ];

  for (const t of dynamicTables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get() as { c: number };
      t.count = row.c;
    } catch {
      t.count = -1; // Table doesn't exist
    }
  }

  // ── QA stats ──────────────────────────────────────────────────────
  const qaDir = join(WORKSPACE, "qa");
  let qaFileCount = 0;
  if (existsSync(qaDir)) {
    try {
      qaFileCount = readdirSync(qaDir).filter((f) => f.endsWith(".md")).length;
    } catch {
      qaFileCount = 0;
    }
  }

  let qaEmbeddingCount = 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) as c FROM embeddings WHERE id LIKE 'QA__%'`).get() as { c: number };
    qaEmbeddingCount = row.c;
  } catch {
    qaEmbeddingCount = 0;
  }

  // ── Corpus stats (preserved) ──────────────────────────────────────
  let corpusCount = 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) as c FROM embeddings WHERE id NOT LIKE 'QA__%'`).get() as { c: number };
    corpusCount = row.c;
  } catch {
    corpusCount = 0;
  }

  // ── Print plan ────────────────────────────────────────────────────
  let hasWork = false;

  console.log("📊 Current state");
  console.log();
  console.log("  Will DELETE:");
  for (const t of dynamicTables) {
    if (t.count < 0) continue;
    const icon = t.count > 0 ? "✗" : "·";
    const countStr = String(t.count).padStart(8);
    console.log(`    ${icon} ${t.label.padEnd(26)} ${countStr} rows`);
    if (t.count > 0) hasWork = true;
  }

  if (WITH_QA) {
    console.log();
    console.log("  Will DELETE (--with-qa):");
    const qaFileIcon = qaFileCount > 0 ? "✗" : "·";
    const qaEmbIcon = qaEmbeddingCount > 0 ? "✗" : "·";
    console.log(`    ${qaFileIcon} ${"QA markdown files".padEnd(26)} ${String(qaFileCount).padStart(8)} files`);
    console.log(`    ${qaEmbIcon} ${"QA embeddings".padEnd(26)} ${String(qaEmbeddingCount).padStart(8)} rows`);
    if (qaFileCount > 0 || qaEmbeddingCount > 0) hasWork = true;
  }

  console.log();
  console.log("  Will KEEP:");
  console.log(`    ✓ ${"Document corpus".padEnd(26)} ${String(corpusCount).padStart(8)} chunks`);
  if (!WITH_QA && qaEmbeddingCount > 0) {
    console.log(`    ✓ ${"QA embeddings".padEnd(26)} ${String(qaEmbeddingCount).padStart(8)} chunks (pass --with-qa to wipe)`);
  }
  if (!WITH_QA && qaFileCount > 0) {
    console.log(`    ✓ ${"QA markdown files".padEnd(26)} ${String(qaFileCount).padStart(8)} files (pass --with-qa to wipe)`);
  }
  console.log();

  // DB file size
  const dbPath = join(WORKSPACE, "workspace.db");
  if (existsSync(dbPath)) {
    console.log(`  💾 workspace.db: ${fileSize(dbPath)}`);
    console.log();
  }

  if (!hasWork) {
    console.log("✨ Nothing to clean — workspace is already clean.");
    return;
  }

  if (DRY_RUN) {
    console.log("🔍 --dry-run mode: no changes made.");
    return;
  }

  // ── Confirm ───────────────────────────────────────────────────────
  const ok = await confirm(`⚠️  This will permanently wipe data from '${WORKSPACE_NAME}'. Continue? [y/N] `);
  if (!ok) {
    console.log("❌ Aborted.");
    return;
  }

  console.log();
  console.log("🧹 Cleaning...");

  // ── Wipe in a single transaction ──────────────────────────────────
  const tx = db.transaction(() => {
    for (const t of dynamicTables) {
      if (t.count < 0) continue;
      db.prepare(`DELETE FROM ${t.name}`).run();
      if (t.count > 0) console.log(`  ✓ ${t.label} (${t.count} rows)`);
    }
    if (WITH_QA && qaEmbeddingCount > 0) {
      db.prepare(`DELETE FROM embeddings WHERE id LIKE 'QA__%'`).run();
      console.log(`  ✓ QA embeddings (${qaEmbeddingCount} rows)`);
    }
  });
  tx();

  // ── Reclaim disk space (cannot be inside transaction) ────────────
  db.exec("VACUUM");
  console.log("  ✓ VACUUM (reclaimed space)");

  // ── Delete QA files ───────────────────────────────────────────────
  if (WITH_QA && existsSync(qaDir)) {
    try {
      rmSync(qaDir, { recursive: true, force: true });
      console.log(`  ✓ QA directory (${qaFileCount} files removed)`);
    } catch (err) {
      console.error(`  ⚠️  Failed to delete qa/: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Report ────────────────────────────────────────────────────────
  console.log();
  if (existsSync(dbPath)) {
    console.log(`  💾 workspace.db: ${fileSize(dbPath)} (after clean + vacuum)`);
  }
  console.log();
  console.log(`✅ Workspace '${WORKSPACE_NAME}' cleaned. Ready to zip and share.`);
  console.log();
  console.log("💡 Next steps:");
  console.log(`   pnpm workspace:zip --workspace=${WORKSPACE_NAME}`);
}
