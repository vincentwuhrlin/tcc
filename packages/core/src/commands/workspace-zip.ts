/**
 * workspace:zip — Create a .zip archive of a workspace for sharing with a team.
 *
 * ⚠️  REQUIRES --workspace=<n> explicitly, like workspace:clean.
 *
 * By default, the archive excludes:
 *   • node_modules, .cache, .git, OS metadata
 *   • media/pdfs/           (raw PDF sources — large, regenerable)
 *   • media/videos/         (raw video sources — large, regenerable)
 *   • media/cookies/        (credentials, should never be shared)
 *   • workspace.db-journal, -wal, -shm (SQLite transient files)
 *
 * Kept by default:
 *   • workspace.db          (the RAG index + any data not cleaned)
 *   • workspace.json        (workspace metadata)
 *   • context/              (instructions.md, domain.md, PLAN.md)
 *   • media/output/         (the markdown chunks used by RAG)
 *   • qa/                   (if it exists)
 *
 * Usage:
 *   pnpm workspace:zip --workspace=noa
 *   pnpm workspace:zip --workspace=noa --output=./shared/noa-v1.zip
 *   pnpm workspace:zip --workspace=noa --full      # include raw media too
 *   pnpm workspace:zip --workspace=noa --dry-run   # list files, don't write
 *
 * Recommended flow for sharing with teammates:
 *   1. pnpm workspace:clean --workspace=noa --with-qa
 *   2. pnpm workspace:zip   --workspace=noa
 *   3. Share the resulting .zip
 */
import { printHeader, WORKSPACE, WORKSPACE_NAME, WORKSPACE_FLAG_EXPLICIT } from "../config.js";
import { join, resolve, relative, sep } from "path";
import { existsSync, statSync, createWriteStream, mkdirSync } from "fs";
import { readdir } from "fs/promises";

const args = process.argv.slice(2);
const FULL = args.includes("--full");
const DRY_RUN = args.includes("--dry-run");
const outputArg = args.find((a) => a.startsWith("--output="))?.split("=")[1];

// Dirs (relative to workspace root) that are ALWAYS excluded
const ALWAYS_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".cache",
  ".git",
  ".huggingface",
  "transformers-cache",
]);

// Files always excluded by name
const ALWAYS_EXCLUDE_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

// File patterns (suffix match) always excluded
const ALWAYS_EXCLUDE_SUFFIXES = [
  ".db-journal",
  ".db-wal",
  ".db-shm",
];

// Dirs excluded by default, kept with --full
const SLIM_EXCLUDE_DIRS = new Set([
  join("media", "pdfs"),
  join("media", "videos"),
  join("media", "cookies"),
]);

interface FileEntry {
  absolutePath: string;
  archivePath: string; // path inside the zip, forward slashes
  size: number;
}

function shouldExclude(relativePath: string, name: string, isDir: boolean): boolean {
  if (ALWAYS_EXCLUDE_FILES.has(name)) return true;
  if (isDir && ALWAYS_EXCLUDE_DIRS.has(name)) return true;
  for (const suffix of ALWAYS_EXCLUDE_SUFFIXES) {
    if (relativePath.endsWith(suffix)) return true;
  }
  if (!FULL && isDir) {
    // Check if relativePath matches any slim-excluded dir
    const normalized = relativePath.replace(/\\/g, "/");
    for (const excluded of SLIM_EXCLUDE_DIRS) {
      const normalizedExcluded = excluded.replace(/\\/g, "/");
      if (normalized === normalizedExcluded || normalized.startsWith(normalizedExcluded + "/")) {
        return true;
      }
    }
  }
  return false;
}

async function walkDir(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];

  async function walk(currentAbs: string): Promise<void> {
    const rel = relative(root, currentAbs);
    const entries = await readdir(currentAbs, { withFileTypes: true });
    for (const entry of entries) {
      const childAbs = join(currentAbs, entry.name);
      const childRel = rel ? join(rel, entry.name) : entry.name;

      if (shouldExclude(childRel, entry.name, entry.isDirectory())) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(childAbs);
      } else if (entry.isFile()) {
        try {
          const size = statSync(childAbs).size;
          // Archive path: forward slashes + workspace name prefix
          const archivePath = `${WORKSPACE_NAME}/${childRel.split(sep).join("/")}`;
          out.push({ absolutePath: childAbs, archivePath, size });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(root);
  return out;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export async function workspaceZip(): Promise<void> {
  // ── Guard: require --workspace=<n> explicitly ──────────────────
  if (!WORKSPACE_FLAG_EXPLICIT) {
    console.error("❌ --workspace=<n> is required for this command.");
    console.error();
    console.error("You must explicitly specify which workspace to zip,");
    console.error("to avoid accidentally archiving the wrong one");
    console.error("(falling back to .env WORKSPACE is disabled).");
    console.error();
    console.error("Usage:");
    console.error("  pnpm workspace:zip --workspace=<n>");
    console.error("  pnpm workspace:zip --workspace=<n> --output=./shared/foo.zip");
    console.error("  pnpm workspace:zip --workspace=<n> --full");
    console.error("  pnpm workspace:zip --workspace=<n> --dry-run");
    process.exit(1);
  }

  // ── Guard: workspace must exist ───────────────────────────────────
  if (!existsSync(WORKSPACE)) {
    console.error(`❌ Workspace not found: ${WORKSPACE}`);
    console.error(`   (Resolved from --workspace=${WORKSPACE_NAME})`);
    process.exit(1);
  }

  printHeader();

  console.log(`📦 Zip workspace: ${WORKSPACE_NAME}`);
  console.log(`   Source: ${WORKSPACE}`);

  // ── Resolve output path ───────────────────────────────────────────
  const defaultName = `${WORKSPACE_NAME}-${todayStr()}.zip`;
  const outputPath = outputArg
    ? resolve(process.cwd(), outputArg)
    : resolve(process.cwd(), defaultName);

  console.log(`   Output: ${outputPath}`);
  console.log(`   Mode:   ${FULL ? "full (including raw media)" : "slim (excluding raw media)"}`);
  console.log();

  // ── Walk the workspace ────────────────────────────────────────────
  console.log("🔍 Scanning files...");
  const t0 = Date.now();
  const files = await walkDir(WORKSPACE);
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  console.log(`   Found ${files.length} files, ${formatSize(totalSize)} uncompressed (${Date.now() - t0}ms)`);
  console.log();

  // ── Breakdown by top-level dir ────────────────────────────────────
  const byTopDir = new Map<string, { count: number; size: number }>();
  for (const f of files) {
    // archivePath format: "noa/foo/bar.md" — strip workspace name prefix
    const rel = f.archivePath.slice(WORKSPACE_NAME.length + 1);
    const topDir = rel.includes("/") ? rel.split("/")[0] : "(root)";
    const bucket = byTopDir.get(topDir) ?? { count: 0, size: 0 };
    bucket.count += 1;
    bucket.size += f.size;
    byTopDir.set(topDir, bucket);
  }

  console.log("  Breakdown:");
  const sorted = [...byTopDir.entries()].sort((a, b) => b[1].size - a[1].size);
  const maxLabel = Math.max(...sorted.map(([label]) => label.length));
  for (const [label, stats] of sorted) {
    const padded = label.padEnd(maxLabel);
    console.log(`    📁 ${padded}  ${String(stats.count).padStart(5)} files  ${formatSize(stats.size).padStart(10)}`);
  }
  console.log();

  if (files.length === 0) {
    console.log("❌ No files to archive.");
    return;
  }

  if (DRY_RUN) {
    console.log("🔍 --dry-run mode: no archive written.");
    console.log();
    console.log("  First 20 files:");
    for (const f of files.slice(0, 20)) {
      console.log(`    ${f.archivePath}`);
    }
    if (files.length > 20) {
      console.log(`    ... and ${files.length - 20} more`);
    }
    return;
  }

  // ── Ensure output dir exists ──────────────────────────────────────
  const outputDir = resolve(outputPath, "..");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // ── Create the archive ────────────────────────────────────────────
  // We import archiver dynamically to keep the command bundle small
  // and to give a clearer error message if the dep is missing.
  let archiver;
  try {
    archiver = (await import("archiver")).default;
  } catch (err) {
    console.error("❌ The 'archiver' package is not installed.");
    console.error("   Run: pnpm --filter @tcc/core add archiver");
    console.error("   Then: pnpm --filter @tcc/core add -D @types/archiver");
    process.exit(1);
  }

  console.log("📦 Writing archive...");
  const tZip = Date.now();

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const output = createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", () => {
      resolvePromise();
    });
    archive.on("warning", (err: Error & { code?: string }) => {
      if (err.code === "ENOENT") {
        console.warn(`  ⚠️  ${err.message}`);
      } else {
        rejectPromise(err);
      }
    });
    archive.on("error", rejectPromise);

    archive.pipe(output);

    for (const f of files) {
      archive.file(f.absolutePath, { name: f.archivePath });
    }

    archive.finalize();
  });

  const zipSize = statSync(outputPath).size;
  const ratio = ((zipSize / totalSize) * 100).toFixed(0);

  console.log();
  console.log(`✅ Archive created in ${((Date.now() - tZip) / 1000).toFixed(1)}s`);
  console.log(`   Path:     ${outputPath}`);
  console.log(`   Size:     ${formatSize(zipSize)} (${ratio}% of uncompressed)`);
  console.log(`   Files:    ${files.length}`);
  console.log();
  console.log("💡 Share this .zip with your teammates. They unzip into their");
  console.log(`   'workspaces/' directory and run 'pnpm run chat'.`);
}
