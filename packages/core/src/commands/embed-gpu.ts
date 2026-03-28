/**
 * embed-gpu — Run media:embed on a RunPod GPU pod (end-to-end).
 *
 * Orchestrates:
 *   1. Create GPU pod (reuses gpu:create infra)
 *   2. Upload setup-embed.sh → install Node.js + pnpm
 *   3. Upload monorepo code via tar+scp (excluding workspaces, node_modules, .git)
 *   4. Upload workspace chunks (fresh db on pod — no existing data)
 *   5. Install deps + run media:embed on pod
 *   6. Download workspace-gpu.db → merge embeddings into local workspace.db
 *   7. Terminate pod (unless --keep)
 *
 * Flags:
 *   --engine=jina-local|nomic-local   Override RAG_ENGINE (default: nomic-local)
 *   --cpu                             Use CPU pod instead of GPU (cheaper for ONNX)
 *   --cpu-flavor=cpu3c|cpu5c          CPU flavor (default: cpu5c = 5+ GHz)
 *   --cpu-vcpus=N                     Number of vCPUs (default: 4)
 *   --limit=N                         Only embed first N chunks (for testing)
 *   --keep                            Don't terminate pod after embed
 *   --force                           Re-embed all chunks (pass to media:embed)
 *   --dry-run                         Show plan without executing
 *
 * Usage:
 *   npm run media:embed:gpu
 *   npm run media:embed:gpu -- --cpu
 *   npm run media:embed:gpu -- --cpu --engine=jina-local --limit=10
 */
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { resolve, join, relative, isAbsolute } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import {
  getGpuConfig,
  GPU_RUNPOD_POD_NAME,
  WORKSPACE,
  WORKSPACES_DIR,
  WORKSPACE_NAME,
  OUTPUT_DIR,
  RAG_ENGINE,
  printHeader,
} from "../config.js";
import { createPod, getPods } from "../runpod.js";
import { getPod, ensureRunpodctl, addSSHKey, deletePod } from "../runpodctl.js";
import { validateKeyPair, sshFlags } from "../ssh.js";
import { upsertEmbedding, getDb, vectorToBuffer, bufferToVector } from "../common/db.js";

// ── Engine-specific pod state (allows parallel runs per engine) ──────

function stateFile(engine: string): string {
  return resolve(process.cwd(), `pod-embed-${engine}.json`);
}

function stateSave(engine: string, data: Record<string, unknown>): void {
  writeFileSync(stateFile(engine), JSON.stringify(data, null, 2));
}

function stateExists(engine: string): boolean {
  return existsSync(stateFile(engine));
}

function stateLoad(engine: string): { id: string; [k: string]: unknown } {
  return JSON.parse(readFileSync(stateFile(engine), "utf-8"));
}

function stateClear(engine: string): void {
  try { unlinkSync(stateFile(engine)); } catch {}
}

// ── Constants ────────────────────────────────────────────────────────

const REMOTE_PROJECT = "/root/tcc";
const REMOTE_WORKSPACE = "/root/workspace";
const REMOTE_ENV_FILE = `${REMOTE_PROJECT}/.env.gpu`;
const SETUP_SCRIPT = resolve(process.cwd(), "scripts/setup-embed.sh");

// ── Find monorepo root (same logic as config.ts) ────────────────────

function findMonorepoRoot(): string {
  let dir = resolve(process.cwd());
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

// ── Parse flags ──────────────────────────────────────────────────────

function parseFlags() {
  const args = process.argv.slice(3);
  const engineFlag = args.find((a) => a.startsWith("--engine="))?.split("=")[1];
  const engine = engineFlag ?? "nomic-local";
  const limitFlag = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
  const limit = limitFlag ? parseInt(limitFlag, 10) : 0;
  const cpu = args.includes("--cpu");
  const cpuFlavorFlag = args.find((a) => a.startsWith("--cpu-flavor="))?.split("=")[1];
  const cpuFlavor = cpuFlavorFlag ?? "cpu5c";  // cpu5c = 5+ GHz, best single-core
  const cpuVcpusFlag = args.find((a) => a.startsWith("--cpu-vcpus="))?.split("=")[1];
  const cpuVcpus = cpuVcpusFlag ? parseInt(cpuVcpusFlag, 10) : 4;

  if (!["jina-local", "nomic-local"].includes(engine)) {
    console.error(`❌ Invalid --engine=${engine}. Valid: jina-local, nomic-local`);
    process.exit(1);
  }

  return {
    engine,
    limit,
    cpu,
    cpuFlavor,
    cpuVcpus,
    keep: args.includes("--keep"),
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ssh(ip: string, port: number, cmd: string, opts?: { stdio?: "pipe" | "inherit"; timeout?: number }): string {
  const result = execSync(
    `ssh ${sshFlags()} -p ${port} root@${ip} "${cmd.replace(/"/g, '\\"')}"`,
    { stdio: opts?.stdio ?? "inherit", encoding: "utf-8", timeout: opts?.timeout ?? 600_000 },
  );
  return result ?? "";
}

function scp(ip: string, port: number, src: string, dest: string): void {
  execSync(
    `scp ${sshFlags()} -P ${port} -r "${src}" root@${ip}:${dest}`,
    { stdio: "inherit", timeout: 300_000 },
  );
}

function scpFrom(ip: string, port: number, remotePath: string, localPath: string): void {
  execSync(
    `scp ${sshFlags()} -P ${port} root@${ip}:${remotePath} "${localPath}"`,
    { stdio: "inherit", timeout: 300_000 },
  );
}

/**
 * Upload a local directory to the pod using tar + scp (cross-platform, no rsync needed).
 * Creates a tar.gz locally with excludes, scps it, extracts on pod, cleans up.
 */
function uploadDir(ip: string, port: number, localDir: string, remoteDir: string, excludes: string[]): void {
  const tarFile = join(tmpdir(), `tcc-upload-${Date.now()}.tar.gz`);
  const excludeFlags = excludes.map((e) => `--exclude=${e}`).join(" ");

  try {
    // 1. Create tar.gz locally (tar is built into Windows 10+, macOS, Linux)
    execSync(
      `tar -czf "${tarFile}" ${excludeFlags} -C "${localDir}" .`,
      { stdio: "pipe", timeout: 300_000 },
    );

    // 2. SCP tar to pod
    scp(ip, port, tarFile, "/tmp/tcc-upload.tar.gz");

    // 3. Extract on pod + cleanup remote tar
    ssh(ip, port, `mkdir -p ${remoteDir} && tar -xzf /tmp/tcc-upload.tar.gz -C ${remoteDir} && rm -f /tmp/tcc-upload.tar.gz`);

  } finally {
    // 4. Cleanup local tar
    try { unlinkSync(tarFile); } catch {}
  }
}

// ── Compute upload excludes ─────────────────────────────────────────

function computeExcludes(monorepoRoot: string): string[] {
  const excludes = [
    "node_modules",
    ".git",
    "*.log",
    "pod-info.json",
    ".env",        // we generate a custom .env.gpu
  ];

  // If WORKSPACES_DIR is inside the monorepo, exclude it
  const resolvedWsDir = resolve(WORKSPACES_DIR);
  const resolvedRoot = resolve(monorepoRoot);

  if (resolvedWsDir.startsWith(resolvedRoot)) {
    const relWs = relative(resolvedRoot, resolvedWsDir);
    if (relWs && !relWs.startsWith("..")) {
      excludes.push(relWs);
      console.log(`   📁 Excluding workspaces dir: ${relWs}/`);
    }
  }

  return excludes;
}

// ── Generate remote .env ────────────────────────────────────────────

function generateRemoteEnv(engine: string): string {
  // Read local .env, override paths and engine
  const monorepoRoot = findMonorepoRoot();
  const localEnvPath = join(monorepoRoot, ".env");
  let envContent = existsSync(localEnvPath) ? readFileSync(localEnvPath, "utf-8") : "";

  // Remove lines we'll override
  const overrideKeys = [
    "WORKSPACES_DIR",
    "WORKSPACE",
    "RAG_ENGINE",
  ];

  const lines = envContent.split("\n").filter((line) => {
    const key = line.match(/^([^#=]+)=/)?.[1]?.trim();
    return !key || !overrideKeys.includes(key);
  });

  // Add our overrides
  lines.push("");
  lines.push("# ── GPU embed overrides (auto-generated) ─────────────────────");
  lines.push(`WORKSPACES_DIR=/root`);
  lines.push(`WORKSPACE=workspace`);
  lines.push(`RAG_ENGINE=${engine}`);
  lines.push("");

  return lines.join("\n");
}

// ── Wait for SSH ────────────────────────────────────────────────────

async function waitForSSH(podId: string): Promise<{ ip: string; port: number }> {
  const maxAttempts = 40;
  process.stdout.write("⏳ Waiting for pod to be ready");

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5000);
    process.stdout.write(".");

    const pod = getPod(podId);
    if (!pod || pod.desiredStatus === "EXITED") {
      throw new Error("Pod exited unexpectedly");
    }

    if (pod.ssh?.ip && pod.ssh?.port) {
      try {
        execSync(
          `ssh ${sshFlags()} -p ${pod.ssh.port} -o ConnectTimeout=5 root@${pod.ssh.ip} "echo ok"`,
          { stdio: "pipe", timeout: 15000 },
        );
        console.log(" ✅");
        return { ip: pod.ssh.ip, port: pod.ssh.port };
      } catch {
        // SSH daemon not ready yet
      }
    }
  }

  throw new Error("Timeout waiting for pod SSH (200s)");
}

// ── Main ─────────────────────────────────────────────────────────────

export async function embedGpu(): Promise<void> {
  const flags = parseFlags();
  const monorepoRoot = findMonorepoRoot();
  const startTime = Date.now();

  printHeader();

  console.log("🔮 media:embed:gpu — Run embedding on RunPod");
  console.log(`   Engine:    ${flags.engine}`);
  console.log(`   Mode:      ${flags.cpu ? `CPU (${flags.cpuFlavor}, ${flags.cpuVcpus} vCPUs)` : "GPU"}`);
  console.log(`   Workspace: ${WORKSPACE_NAME}`);
  console.log(`   Monorepo:  ${monorepoRoot}`);
  console.log(`   Force:     ${flags.force}`);
  console.log(`   Limit:     ${flags.limit || "none"}`);
  console.log(`   Keep pod:  ${flags.keep}`);
  console.log();

  // ── Validate workspace has chunks ──────────────────────────────────
  const chunksDocDir = join(OUTPUT_DIR, "documents", "chunks");
  const chunksVidDir = join(OUTPUT_DIR, "videos", "chunks");
  const hasDocChunks = existsSync(chunksDocDir);
  const hasVidChunks = existsSync(chunksVidDir);

  if (!hasDocChunks && !hasVidChunks) {
    console.error("❌ No chunks found. Run media:split first.");
    console.error(`   Expected: ${chunksDocDir}`);
    console.error(`         or: ${chunksVidDir}`);
    process.exit(1);
  }

  // Count chunks
  const { readdirSync } = await import("fs");
  let chunkCount = 0;
  if (hasDocChunks) chunkCount += readdirSync(chunksDocDir).filter((f) => f.endsWith(".md")).length;
  if (hasVidChunks) chunkCount += readdirSync(chunksVidDir).filter((f) => f.endsWith(".md")).length;
  console.log(`📦 ${chunkCount} chunks to embed`);

  // ── Compute excludes ───────────────────────────────────────────────
  const excludes = computeExcludes(monorepoRoot);

  // ── Dry run stop ───────────────────────────────────────────────────
  if (flags.dryRun) {
    console.log();
    console.log("🔍 Dry run — would execute:");
    console.log("   1. gpu:create (RunPod GPU pod)");
    console.log("   2. Upload setup-embed.sh → install Node.js + pnpm");
    console.log(`   3. Upload monorepo → ${REMOTE_PROJECT} (tar+scp)`);
    console.log(`      Excludes: ${excludes.join(", ")}`);
    console.log(`   4. Upload chunks → ${REMOTE_WORKSPACE}/media/output/ (fresh db, no existing data)`);
    console.log(`   5. pnpm install + npm run media:embed ${flags.force ? "--force" : ""}`);
    console.log(`   6. Download workspace-gpu.db → merge embeddings into local workspace.db`);
    console.log(`   7. ${flags.keep ? "Keep pod running" : "Terminate pod"}`);
    return;
  }

  // ── Preflight ──────────────────────────────────────────────────────
  console.log();
  ensureRunpodctl();

  // ── Guard: existing pod for this engine ─────────────────────────────
  if (stateExists(flags.engine)) {
    const s = stateLoad(flags.engine);
    console.error(`⚠️  Pod already tracked for ${flags.engine}: ${s.id}`);
    console.error(`   Delete ${stateFile(flags.engine)} or wait for it to finish`);
    process.exit(1);
  }

  const podName = `${GPU_RUNPOD_POD_NAME}-embed-${flags.engine}`;
  console.log(`🔍 Checking for existing "${podName}" pod...`);
  let existing: Awaited<ReturnType<typeof getPods>> = [];
  try {
    existing = await getPods();
  } catch {
    // API may return empty body when no pods exist — safe to continue
  }
  const dup = existing.find((p) => p.name === podName && p.desiredStatus !== "EXITED");
  if (dup) {
    console.error(`⚠️  Pod "${podName}" already exists: ${dup.id}`);
    console.error("   Terminate it first.");
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════
  //  STEP 1 — Create pod
  // ══════════════════════════════════════════════════════════════════
  console.log();
  console.log("═══════════════════════════════════════════");
  console.log(`  STEP 1/7 — Create ${flags.cpu ? "CPU" : "GPU"} pod`);
  console.log("═══════════════════════════════════════════");

  const publicKey = validateKeyPair();
  addSSHKey(getGpuConfig().sshPublicKey);

  let config: Record<string, unknown>;

  if (flags.cpu) {
    // CPU pod — no GPU, lighter and cheaper for ONNX embedding
    config = {
      name: podName,
      computeType: "CPU",
      cpuFlavorIds: [flags.cpuFlavor],
      cpuFlavorPriority: "availability",
      vcpuCount: flags.cpuVcpus,
      dataCenterIds: getGpuConfig().podConfig.dataCenterIds,
      dataCenterPriority: "availability",
      cloudType: getGpuConfig().podConfig.cloudType,
      imageName: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
      containerDiskInGb: 30,
      ports: ["22/tcp"],
      env: { PUBLIC_KEY: publicKey },
    };
    console.log(`   CPU:    ${flags.cpuFlavor} (${flags.cpuVcpus} vCPUs)`);
  } else {
    // GPU pod — original behavior
    const gpuConfig = getGpuConfig();
    config = {
      ...gpuConfig.podConfig,
      name: podName,
      env: { ...gpuConfig.podConfig.env, PUBLIC_KEY: publicKey },
    };
    console.log(`   GPU:    ${(config.gpuTypeIds as string[])[0]} (+ fallbacks)`);
  }
  console.log(`   Cloud:  ${config.cloudType}`);

  const pod = await createPod(config);

  stateSave(flags.engine, {
    id: pod.id,
    name: podName,
    type: flags.cpu ? `CPU ${flags.cpuFlavor}` : `GPU ${pod.gpuCount ?? 1}x`,
    costPerHr: String(pod.costPerHr ?? "?"),
    createdAt: new Date().toISOString(),
  });

  console.log(`   ✅ Pod ${pod.id} — $${pod.costPerHr}/hr`);

  // From here on, wrap in try/finally to cleanup on error
  let sshInfo: { ip: string; port: number };

  try {
    sshInfo = await waitForSSH(pod.id);
    console.log(`   🔗 SSH: root@${sshInfo.ip}:${sshInfo.port}`);

    // ══════════════════════════════════════════════════════════════════
    //  STEP 2 — Setup (Node.js + pnpm)
    // ══════════════════════════════════════════════════════════════════
    console.log();
    console.log("═══════════════════════════════════════════");
    console.log("  STEP 2/7 — Install Node.js + pnpm");
    console.log("═══════════════════════════════════════════");

    scp(sshInfo.ip, sshInfo.port, SETUP_SCRIPT, "/root/setup-embed.sh");
    ssh(sshInfo.ip, sshInfo.port, "bash /root/setup-embed.sh");

    // ══════════════════════════════════════════════════════════════════
    //  STEP 3 — Upload monorepo code
    // ══════════════════════════════════════════════════════════════════
    console.log();
    console.log("═══════════════════════════════════════════");
    console.log("  STEP 3/7 — Upload project code");
    console.log("═══════════════════════════════════════════");

    ssh(sshInfo.ip, sshInfo.port, `mkdir -p ${REMOTE_PROJECT}`);
    uploadDir(sshInfo.ip, sshInfo.port, monorepoRoot, REMOTE_PROJECT, excludes);

    // ══════════════════════════════════════════════════════════════════
    //  STEP 4 — Upload workspace chunks
    // ══════════════════════════════════════════════════════════════════
    console.log();
    console.log("═══════════════════════════════════════════");
    console.log("  STEP 4/7 — Upload workspace chunks");
    console.log("═══════════════════════════════════════════");

    // Create remote workspace structure
    ssh(sshInfo.ip, sshInfo.port, `mkdir -p ${REMOTE_WORKSPACE}/media/output/documents ${REMOTE_WORKSPACE}/media/output/videos`);

    // Upload document chunks
    if (hasDocChunks) {
      console.log(`   📤 Uploading document chunks...`);
      uploadDir(
        sshInfo.ip, sshInfo.port,
        chunksDocDir,
        `${REMOTE_WORKSPACE}/media/output/documents/chunks`,
        [],
      );
    }

    // Upload video chunks
    if (hasVidChunks) {
      console.log(`   📤 Uploading video chunks...`);
      uploadDir(
        sshInfo.ip, sshInfo.port,
        chunksVidDir,
        `${REMOTE_WORKSPACE}/media/output/videos/chunks`,
        [],
      );
    }

    // (No workspace.db upload — GPU starts fresh, merged back in step 7)

    // ══════════════════════════════════════════════════════════════════
    //  STEP 5 — Generate + upload .env
    // ══════════════════════════════════════════════════════════════════
    console.log();
    console.log("═══════════════════════════════════════════");
    console.log("  STEP 5/7 — Configure remote .env");
    console.log("═══════════════════════════════════════════");

    const envContent = generateRemoteEnv(flags.engine);
    const localEnvTmp = join(monorepoRoot, ".env.gpu.tmp");
    writeFileSync(localEnvTmp, envContent);
    scp(sshInfo.ip, sshInfo.port, localEnvTmp, `${REMOTE_PROJECT}/.env`);
    // Clean up local tmp
    try { unlinkSync(localEnvTmp); } catch {}
    console.log(`   ✅ .env generated with RAG_ENGINE=${flags.engine}`);

    // ══════════════════════════════════════════════════════════════════
    //  STEP 6 — Install deps + run embed
    // ══════════════════════════════════════════════════════════════════
    console.log();
    console.log("═══════════════════════════════════════════");
    console.log("  STEP 6/7 — Run media:embed on pod");
    console.log("═══════════════════════════════════════════");

    const forceFlag = flags.force ? " --force" : "";
    const limitFlag = flags.limit > 0 ? ` --limit=${flags.limit}` : "";
    const embedFlags = `${forceFlag}${limitFlag}`;

    // Install project deps
    console.log("   📦 pnpm install...");
    ssh(sshInfo.ip, sshInfo.port, `cd ${REMOTE_PROJECT} && pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1`);

    // Force native build for ONNX runtime (pnpm may skip build scripts)
    console.log("   🔧 Building onnxruntime-node...");
    ssh(sshInfo.ip, sshInfo.port, `cd ${REMOTE_PROJECT} && pnpm rebuild onnxruntime-node 2>&1`);

    // Run embed
    console.log();
    console.log(`   🚀 Running media:embed${embedFlags}...`);
    console.log();
    ssh(sshInfo.ip, sshInfo.port, `cd ${REMOTE_PROJECT}/packages/core && npx tsx src/cli.ts embed${embedFlags}`, { timeout: 7_200_000 });

    // ══════════════════════════════════════════════════════════════════
    //  STEP 7 — Download + merge embeddings
    // ══════════════════════════════════════════════════════════════════
    console.log();
    console.log("═══════════════════════════════════════════");
    console.log("  STEP 7/7 — Download + merge embeddings");
    console.log("═══════════════════════════════════════════");

    // Ensure local workspace dir exists
    if (!existsSync(WORKSPACE)) mkdirSync(WORKSPACE, { recursive: true });

    // Download GPU db as temp file
    const gpuDbPath = join(WORKSPACE, "workspace-gpu.db");
    scpFrom(sshInfo.ip, sshInfo.port, `${REMOTE_WORKSPACE}/workspace.db`, gpuDbPath);
    console.log(`   📥 Downloaded workspace-gpu.db`);

    // Merge: read all embeddings from GPU db, upsert into local db
    const gpuDb = new Database(gpuDbPath, { readonly: true });
    const rows = gpuDb.prepare(
      "SELECT id, source, content, vector, model, dimensions FROM embeddings",
    ).all() as { id: string; source: string; content: string; vector: Buffer; model: string; dimensions: number }[];

    console.log(`   🔀 Merging ${rows.length} embeddings into local workspace.db...`);

    // Use the local db (via getDb singleton)
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

    // Batch insert in a transaction for speed
    const insertAll = localDb.transaction(() => {
      for (const row of rows) {
        upsertStmt.run(row.id, row.source, row.content, row.vector, row.model, row.dimensions);
      }
    });
    insertAll();

    console.log(`   ✅ ${rows.length} embeddings merged`);

    // Clean up temp file
    gpuDb.close();
    try { unlinkSync(gpuDbPath); } catch {}
    // Also clean WAL/SHM files if present
    try { unlinkSync(`${gpuDbPath}-wal`); } catch {}
    try { unlinkSync(`${gpuDbPath}-shm`); } catch {}
    console.log(`   🗑️  workspace-gpu.db cleaned up`);

  } catch (err) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.error();
    console.error(`❌ Failed after ${formatTime(elapsed)}: ${err instanceof Error ? err.message : err}`);
    console.error();

    if (!flags.keep) {
      console.log("🗑️  Cleaning up — terminating pod...");
      try {
        deletePod(pod.id);
        stateClear(flags.engine);
        console.log("   ✅ Pod terminated. $0 from now on.");
      } catch (e) {
        console.error(`   ⚠️  Failed to terminate: ${e instanceof Error ? e.message : e}`);
        console.error(`   Run manually: npm run gpu:terminate`);
      }
    } else {
      console.log("   --keep: pod left running for debugging");
      console.log("   Connect: npm run gpu:ssh");
      console.log("   Kill:    npm run gpu:terminate");
    }
    process.exit(1);
  }

  // ── Success — terminate or keep ────────────────────────────────────
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  if (!flags.keep) {
    console.log();
    console.log("🗑️  Terminating pod...");
    deletePod(pod.id);
    stateClear(flags.engine);
    console.log("   ✅ Pod terminated. $0 from now on.");
  } else {
    console.log();
    console.log("   --keep: pod left running");
    console.log("   Connect: npm run gpu:ssh");
    console.log("   Kill:    npm run gpu:terminate");
  }

  console.log();
  console.log("════════════════════════════════════════════");
  console.log("  🎉 media:embed:gpu complete!");
  console.log(`  ⏱️  Total: ${formatTime(elapsed)}`);
  console.log(`  📊 Database: ${join(WORKSPACE, "workspace.db")}`);
  console.log("════════════════════════════════════════════");
  console.log();
}

function formatTime(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}
