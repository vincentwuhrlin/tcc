/**
 * embed-import — Import embeddings from an external workspace.db.
 *
 * Reads all embeddings from a source database and upserts them into
 * the local workspace.db. Uses composite PK (id, model) so embeddings
 * from different models coexist without conflict.
 *
 * Use cases:
 *   - Transfer embeddings from another machine (e.g. Mac → PC)
 *   - Merge GPU pod results manually
 *   - Consolidate embeddings from multiple workspaces
 *
 * Flags:
 *   --from=<path>     Path to source database (required)
 *   --model=<name>    Only import embeddings for this model (optional)
 *   --dry-run         Show what would be imported without writing
 *
 * Usage:
 *   npm run media:embed:import -- --from=workspace-mac.db
 *   npm run media:embed:import -- --from=workspace-mac.db --model=jina-embeddings-v3
 *   npm run media:embed:import -- --from=workspace-mac.db --dry-run
 */
import { existsSync } from "fs";
import { resolve } from "path";
import Database from "better-sqlite3";
import { WORKSPACE, printHeader } from "../config.js";
import { getDb } from "../common/db.js";

export async function embedImport(): Promise<void> {
  printHeader();

  // ── Parse flags ────────────────────────────────────────────────────
  const args = process.argv.slice(3);
  const fromFlag = args.find((a) => a.startsWith("--from="))?.split("=")[1];
  const modelFilter = args.find((a) => a.startsWith("--model="))?.split("=")[1];
  const dryRun = args.includes("--dry-run");

  if (!fromFlag) {
    console.error("❌ Missing --from=<path> flag");
    console.error("   Usage: npm run media:embed:import -- --from=workspace-mac.db");
    process.exit(1);
  }

  const sourcePath = resolve(fromFlag);
  if (!existsSync(sourcePath)) {
    console.error(`❌ Source database not found: ${sourcePath}`);
    process.exit(1);
  }

  console.log("🔀 media:embed:import — Import embeddings from external database");
  console.log(`   Source:  ${sourcePath}`);
  console.log(`   Target:  ${resolve(WORKSPACE, "workspace.db")}`);
  if (modelFilter) console.log(`   Filter:  model = ${modelFilter}`);
  console.log();

  // ── Open source database (read-only) ──────────────────────────────
  const sourceDb = new Database(sourcePath, { readonly: true });

  // ── Read source embeddings ────────────────────────────────────────
  const query = modelFilter
    ? "SELECT id, source, content, vector, model, dimensions FROM embeddings WHERE model = ?"
    : "SELECT id, source, content, vector, model, dimensions FROM embeddings";

  const rows = (modelFilter
    ? sourceDb.prepare(query).all(modelFilter)
    : sourceDb.prepare(query).all()
  ) as { id: string; source: string; content: string; vector: Buffer; model: string; dimensions: number }[];

  if (rows.length === 0) {
    console.log("⚠️  No embeddings found in source database.");
    sourceDb.close();
    return;
  }

  // ── Stats ──────────────────────────────────────────────────────────
  const modelCounts = new Map<string, number>();
  for (const row of rows) {
    modelCounts.set(row.model, (modelCounts.get(row.model) ?? 0) + 1);
  }

  console.log(`📦 ${rows.length} embeddings found in source:`);
  for (const [model, count] of modelCounts) {
    console.log(`   ${model}: ${count}`);
  }
  console.log();

  // ── Dry run stop ───────────────────────────────────────────────────
  if (dryRun) {
    console.log("🔍 Dry run — no changes written.");
    sourceDb.close();
    return;
  }

  // ── Merge into local database ─────────────────────────────────────
  const localDb = getDb();

  const upsertStmt = localDb.prepare(`
    INSERT INTO embeddings (id, source, content, vector, model, dimensions)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, model) DO UPDATE SET
      source = excluded.source,
      content = excluded.content,
      vector = excluded.vector,
      dimensions = excluded.dimensions,
      created_at = datetime('now')
  `);

  const insertAll = localDb.transaction(() => {
    for (const row of rows) {
      upsertStmt.run(row.id, row.source, row.content, row.vector, row.model, row.dimensions);
    }
  });

  insertAll();

  console.log(`✅ ${rows.length} embeddings merged into workspace.db`);
  for (const [model, count] of modelCounts) {
    console.log(`   ${model}: ${count} upserted`);
  }

  // ── Verify ─────────────────────────────────────────────────────────
  const totalCount = (localDb.prepare("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number }).cnt;
  const models = (localDb.prepare("SELECT DISTINCT model FROM embeddings").all() as { model: string }[]).map((r) => r.model);
  console.log();
  console.log("📊 Local database stats:");
  console.log(`   Total embeddings: ${totalCount}`);
  console.log(`   Models: ${models.join(", ")}`);

  sourceDb.close();
}
