#!/usr/bin/env node

// ── Transcript commands ──────────────────────────────────────────────
import { setup } from "./commands/setup.js";
import { transcript } from "./commands/transcript.js";
import { documents } from "./commands/documents.js";
import { videos } from "./commands/videos.js";

// ── GPU commands ─────────────────────────────────────────────────────
import { create } from "./commands/create.js";
import { status } from "./commands/status.js";
import { ssh } from "./commands/ssh.js";
import { start } from "./commands/start.js";
import { stop } from "./commands/stop.js";
import { terminate } from "./commands/terminate.js";

// ── Media commands ───────────────────────────────────────────────────
import { stats } from "./commands/stats.js";
import { split, splitCheck, splitUndo } from "./commands/split.js";
import { discover } from "./commands/discover.js";
import { synthesize } from "./commands/synthesize.js";
import { classify, classifyCheck } from "./commands/classify.js";
import { embed } from "./commands/embed.js";
import { embedGpu } from "./commands/embed-gpu.js";
import { embedImport } from "./commands/embed-import.js";
import { embedBench } from "./commands/embed-bench.js";
import { embedStats } from "./commands/embed-stats.js";

// ── Projects commands ────────────────────────────────────────────────
import { exportProjects } from "./commands/export.js";

// ── Interactive ─────────────────────────────────────────────────────
import { chat } from "./commands/chat.js";

// ── Utilities ───────────────────────────────────────────────────────
import { uptimizeStats } from "./commands/uptimize-stats.js";

// ── Workspace management ────────────────────────────────────────────
import { workspaceClean } from "./commands/workspace-clean.js";
import { workspaceZip } from "./commands/workspace-zip.js";

// ── Command registry ────────────────────────────────────────────────
const commands: Record<string, () => Promise<void>> = {
  // transcript:*
  setup,
  transcript,
  documents,
  videos,

  // gpu:*
  create,
  status,
  ssh,
  start,
  stop,
  terminate,

  // media:*
  stats,
  split,
  "split:check": splitCheck,
  "split:undo": splitUndo,
  discover,
  synthesize,
  classify,
  "classify:check": classifyCheck,
  embed,
  "embed:gpu": embedGpu,
  "embed:import": embedImport,
  "embed:bench": embedBench,
  "embed:stats": embedStats,

  // projects:*
  export: exportProjects,

  // interactive
  chat,

  // utilities
  "uptimize:stats": uptimizeStats,

  // workspace management
  "workspace:clean": workspaceClean,
  "workspace:zip": workspaceZip,
};

const cmd = process.argv[2];

if (!cmd || !commands[cmd]) {
  console.log("tcc — Transcript, Classify, Chat!");
  console.log();
  console.log("  Transcription (local tools):");
  console.log("    npm run transcript:setup        Install runpodctl, yt-dlp, ffmpeg");
  console.log("    npm run transcript              Transcribe all (documents + videos)");
  console.log("    npm run transcript:documents    PDFs → Markdown");
  console.log("    npm run transcript:videos       Videos → Markdown");
  console.log();
  console.log("  GPU pod (RunPod):");
  console.log("    npm run gpu:create              Create GPU pod");
  console.log("    npm run gpu:status              Check pod status");
  console.log("    npm run gpu:ssh                 Connect to pod");
  console.log("    npm run gpu:ssh -- pull         Pull files from pod");
  console.log("    npm run gpu:start               Resume stopped pod");
  console.log("    npm run gpu:stop                Stop pod (pause billing)");
  console.log("    npm run gpu:terminate           Destroy pod → $0");
  console.log();
  console.log("  Media processing:");
  console.log("    npm run media:stats             Show KB stats (pages, duration, tokens)");
  console.log("    npm run media:split             Split large .md into chapters");
  console.log("    npm run media:split:dry         Preview splits without writing");
  console.log("    npm run media:split:check       Audit breadcrumbs of split documents");
  console.log("    npm run media:split:undo        Restore originals, delete splits");
  console.log();
  console.log("  Media tagging (Claude API — configure in .env):");
  console.log("    npm run media:discover          1. Discover → DISCOVERY.md");
  console.log("    npm run media:synthesize        2. Synthesize → SUMMARY.md + PLAN.md");
  console.log("    npm run media:classify          3. Classify → frontmatter + INDEX.md");
  console.log("    npm run media:classify:check    Audit classification coverage");
  console.log();
  console.log("  RAG (embedding + vector search):");
  console.log("    npm run media:embed             4. Embed chunks → workspace.db");
  console.log("    npm run media:embed:dry         Preview without embedding");
  console.log("    npm run media:embed:force       Re-embed all chunks");
  console.log("    npm run media:embed:gpu         Embed on RunPod GPU (end-to-end)");
  console.log("    npm run media:embed:gpu:dry     Preview GPU embed plan");
  console.log("    npm run media:embed:import      Import embeddings from another db");
  console.log("    npm run media:embed:bench       Benchmark embedding engines (retrieval quality)");
  console.log("    npm run media:embed:bench:dry   Preview benchmark plan");
  console.log("    npm run media:embed:stats       Show embedding stats per model");
  console.log();
  console.log("  Bundle (export to Claude Projects or local use):");
  console.log("    npm run bundle       Export tagged docs → project folders");
  console.log("    npm run bundle:dry   Preview export, no files written");
  console.log();
  console.log("  Interactive:");
  console.log("    npm run chat                   Chat with your knowledge base");
  console.log();
  console.log("  Utilities:");
  console.log("    npm run uptimize:stats         Check UPTIMIZE API spend and status");
  console.log();
  console.log("  Workspace management (require --workspace=<n>):");
  console.log("    npm run workspace:clean -- --workspace=<n>         Strip dynamic data before sharing");
  console.log("    npm run workspace:clean:dry -- --workspace=<n>     Preview what would be deleted");
  console.log("    npm run workspace:clean:with-qa -- --workspace=<n> Also wipe QA files + embeddings");
  console.log("    npm run workspace:zip -- --workspace=<n>           Zip workspace for sharing (slim)");
  console.log("    npm run workspace:zip:full -- --workspace=<n>      Zip including raw media");
  console.log("    npm run workspace:zip:dry -- --workspace=<n>       Preview files without writing");
  console.log();
  console.log("  All commands accept --workspace=<path> to override WORKSPACE from .env");
  console.log();
  process.exit(0);
}

try {
  await commands[cmd]();
} catch (err) {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
}
