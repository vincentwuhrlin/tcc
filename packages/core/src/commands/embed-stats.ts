/**
 * embed:stats — Show embedding statistics per engine/model.
 *
 * Usage:
 *   pnpm run media:embed:stats
 */
import { printHeader } from "../config.js";
import { getDb } from "../common/db.js";

interface ModelRow {
  model: string;
  count: number;
  dimensions: number;
}

export async function embedStats(): Promise<void> {
  printHeader();

  const db = getDb();

  // Per-model stats
  const models = db.prepare(`
    SELECT model, COUNT(*) as count, LENGTH(vector) / 4 as dimensions
    FROM embeddings
    GROUP BY model
    ORDER BY count DESC
  `).all() as ModelRow[];

  const total = models.reduce((sum, m) => sum + m.count, 0);

  console.log("📊 Embedding Stats");
  console.log();

  if (models.length === 0) {
    console.log("   No embeddings found. Run: pnpm run media:embed");
    return;
  }

  // Find longest model name for alignment
  const maxName = Math.max(...models.map((m) => m.model.length));

  for (const m of models) {
    const pct = ((m.count / total) * 100).toFixed(1);
    const bar = "█".repeat(Math.round((m.count / total) * 30));
    const name = m.model.padEnd(maxName);
    console.log(`   ${name}  ${String(m.count).padStart(6)} chunks  ${String(m.dimensions).padStart(5)}d  ${bar} ${pct}%`);
  }

  console.log(`   ${"─".repeat(maxName + 40)}`);
  console.log(`   ${"Total".padEnd(maxName)}  ${String(total).padStart(6)} chunks  ${models.length} model${models.length > 1 ? "s" : ""}`);

  // DB file size
  const dbPath = db.pragma("database_list") as { file: string }[];
  if (dbPath.length > 0 && dbPath[0].file) {
    const { statSync } = await import("fs");
    try {
      const size = statSync(dbPath[0].file).size;
      const mb = (size / 1024 / 1024).toFixed(1);
      console.log();
      console.log(`   💾 workspace.db: ${mb} MB`);
    } catch { /* ignore */ }
  }

  console.log();
}
