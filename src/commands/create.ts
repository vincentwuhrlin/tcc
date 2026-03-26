import { execSync } from "child_process";
import { resolve } from "path";
import { getGpuConfig, GPU_RUNPOD_POD_NAME } from "../config.js";
import { createPod, getPods } from "../runpod.js";
import { getPod } from "../runpodctl.js";
import { validateKeyPair, sshFlags } from "../ssh.js";
import { checkSetup } from "../preflight.js";
import * as state from "../state.js";

const SETUP_SCRIPT = resolve(process.cwd(), "setup.sh");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

function runSetup(ip: string, port: number): void {
  const flags = sshFlags();

  console.log("📤 Uploading setup.sh...");
  execSync(
    `scp ${flags} -P ${port} "${SETUP_SCRIPT}" root@${ip}:/root/setup.sh`,
    { stdio: "inherit" },
  );

  console.log("🔧 Running setup on pod...");
  console.log();
  execSync(
    `ssh ${flags} -p ${port} root@${ip} "bash /root/setup.sh"`,
    { stdio: "inherit" },
  );
}

export async function create(): Promise<void> {
  const startTime = Date.now();
  checkSetup();

  // ── Guard: local state ─────────────────────────────────────────────
  if (state.exists()) {
    const s = state.load();
    console.error(`⚠️  Pod already tracked locally: ${s.id}`);
    console.error('   Run "npm run gpu:terminate" first, or delete pod-info.json');
    process.exit(1);
  }

  // ── Guard: remote duplicate by name ────────────────────────────────
  console.log(`🔍 Checking for existing "${GPU_RUNPOD_POD_NAME}" pod...`);
  const existing = await getPods();
  const dup = existing.find(
    (p) => p.name === GPU_RUNPOD_POD_NAME && p.desiredStatus !== "EXITED",
  );
  if (dup) {
    console.error(`⚠️  Pod "${GPU_RUNPOD_POD_NAME}" already exists: ${dup.id} (${dup.desiredStatus})`);
    console.error("   Terminate it first, or change GPU_RUNPOD_POD_NAME in .env");
    process.exit(1);
  }

  // ── Read SSH key for pod env ───────────────────────────────────────
  const publicKey = validateKeyPair();

  // ── Create pod via REST API ────────────────────────────────────────
  const config = {
    ...getGpuConfig().podConfig,
    env: { ...getGpuConfig().podConfig.env, PUBLIC_KEY: publicKey },
  };

  console.log();
  console.log("🚀 Creating RunPod...");
  console.log(`   Name:   ${GPU_RUNPOD_POD_NAME}`);
  console.log(`   GPU:    ${config.gpuTypeIds[0]} (+ fallbacks)`);
  console.log(`   Cloud:  ${config.cloudType}${config.cloudType === "COMMUNITY" ? " (spot)" : ""}`);
  console.log(`   Region: EU preferred`);
  console.log(`   Disk:   ${config.containerDiskInGb}GB ephemeral`);
  console.log();

  const pod = await createPod(config);

  state.save({
    id: pod.id,
    name: pod.name ?? GPU_RUNPOD_POD_NAME,
    gpu: `${pod.gpuCount ?? 1}x`,
    costPerHr: String(pod.costPerHr ?? "?"),
    createdAt: new Date().toISOString(),
  });

  console.log(`✅ Pod created! ID: ${pod.id} — $${pod.costPerHr}/hr`);
  console.log("💾 State → pod-info.json");
  console.log();

  // ── Wait for SSH + run setup ───────────────────────────────────────
  try {
    const ssh = await waitForSSH(pod.id);
    console.log(`🔗 SSH ready: root@${ssh.ip}:${ssh.port}`);
    console.log();

    runSetup(ssh.ip, ssh.port);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;

    console.log();
    console.log("============================================");
    console.log("  🎉 Pod ready! Tools installed.");
    console.log(`  ⏱️  Total: ${mins}m ${secs}s`);
    console.log("============================================");
    console.log();
    console.log("  Next:");
    console.log("    npm run transcript:videos");
    console.log("    npm run transcript:documents");
    console.log("    npm run gpu:ssh");
    console.log("    npm run gpu:stop / npm run gpu:terminate");
  } catch (err) {
    console.log();
    console.log(`⚠️  ${err instanceof Error ? err.message : err}`);
    console.log("   Pod is created but setup didn't run automatically.");
    console.log("   Connect manually: npm run gpu:ssh");
  }
}
