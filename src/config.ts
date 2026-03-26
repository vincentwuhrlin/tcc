import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";

// ── Load .env ────────────────────────────────────────────────────────
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      let value = match[2].trim();
      if (!value.startsWith('"') && !value.startsWith("'")) {
        value = value.replace(/\s+#.*$/, "");
      }
      process.env[match[1].trim()] = value;
    }
  }
}

function resolvePath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : resolve(p);
}

function requireEnv(key: string, hint?: string): string {
  const val = process.env[key] ?? "";
  if (!val) {
    console.error(`❌ Set ${key} in .env`);
    if (hint) console.error(`   ${hint}`);
    process.exit(1);
  }
  return val;
}

// ── Workspace (single root for all domain data) ────────────────────
// CLI flag --workspace= overrides .env WORKSPACE
const workspaceFlag = process.argv.find((a) => a.startsWith("--workspace="))?.split("=")[1];
export const WORKSPACE = resolvePath(workspaceFlag ?? process.env.WORKSPACE ?? "../workspace");

export const MEDIA_DIR = resolvePath(process.env.MEDIA_DIR ?? `${WORKSPACE}/media`);
export const CONTEXT_DIR = resolvePath(process.env.CONTEXT_DIR ?? `${WORKSPACE}/context`);
export const BUNDLES_DIR = resolvePath(process.env.BUNDLES_DIR ?? `${WORKSPACE}/bundles`);

// ── Media sub-paths ─────────────────────────────────────────────────
export const OUTPUT_DIR = resolvePath(process.env.MEDIA_OUTPUT ?? `${MEDIA_DIR}/output`);
export const PDF_INPUT_DIR = resolvePath(process.env.MEDIA_PDF_INPUT ?? `${MEDIA_DIR}/pdfs`);
export const VIDEO_LINKS_FILE = resolvePath(process.env.MEDIA_VIDEO_LINKS ?? `${MEDIA_DIR}/videos/videos.md`);
export const COOKIES_DIR = resolvePath(process.env.MEDIA_COOKIES ?? `${MEDIA_DIR}/cookies`);

// ── GPU pod (RunPod) — lazy loaded, only required for gpu:* commands ─
export const GPU_RUNPOD_POD_NAME = process.env.GPU_RUNPOD_POD_NAME ?? "tcc";

/** Get GPU config — only call from gpu:* commands. Crashes if keys not set. */
export function getGpuConfig() {
  const apiKey = requireEnv("GPU_RUNPOD_API_KEY", "→ https://www.runpod.io/console/user/settings");
  const rawKeyPath = requireEnv("GPU_RUNPOD_SSH_KEY", "Example: GPU_RUNPOD_SSH_KEY=~/.ssh/runpod_ed25519");
  const sshPrivateKey = resolvePath(rawKeyPath);
  const sshPublicKey = `${sshPrivateKey}.pub`;

  const defaultGpus = "NVIDIA RTX PRO 4500,NVIDIA RTX A4000,NVIDIA L4,NVIDIA GeForce RTX 3090";
  const defaultDatacenters = "EU-RO-1,EU-SE-1,EU-CZ-1,EU-NL-1";

  const podConfig = {
    name: GPU_RUNPOD_POD_NAME,
    gpuTypeIds: (process.env.GPU_RUNPOD_TYPES ?? defaultGpus).split(",").map((s) => s.trim()).filter(Boolean),
    gpuTypePriority: "availability" as const,
    gpuCount: 1,
    dataCenterIds: (process.env.GPU_RUNPOD_DATACENTERS ?? defaultDatacenters).split(",").map((s) => s.trim()).filter(Boolean),
    dataCenterPriority: "availability" as const,
    cloudType: process.env.GPU_RUNPOD_CLOUD_TYPE ?? "SECURE",
    imageName: process.env.GPU_RUNPOD_IMAGE ?? "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
    containerDiskInGb: 80,
    minDownloadMbps: 200,
    minUploadMbps: 50,
    ports: ["22/tcp", "8501/http"],
    env: {} as Record<string, string>,
  };

  return { apiKey, sshPrivateKey, sshPublicKey, podConfig };
}

// ── API (Claude via Vercel AI SDK) ──────────────────────────────────
export type ApiProvider = "anthropic" | "uptimize";
export type MediaApiMode = "streaming" | "batch";

export const API_PROVIDER = (process.env.API_PROVIDER ?? "anthropic") as ApiProvider;
export const API_KEY = process.env.API_KEY ?? "";
export const API_MODEL = process.env.API_MODEL ?? "claude-sonnet-4-6-20250514";
export const API_BASE_URL = process.env.API_BASE_URL ?? "";
export const MEDIA_API_MODE = (process.env.MEDIA_API_MODE ?? "streaming") as MediaApiMode;

// Validate: batch only works with Anthropic direct
if (MEDIA_API_MODE === "batch" && API_PROVIDER !== "anthropic") {
  console.error(`❌ MEDIA_API_MODE=batch is only supported with API_PROVIDER=anthropic`);
  console.error(`   Current provider: ${API_PROVIDER}`);
  console.error(`   Either set MEDIA_API_MODE=streaming or API_PROVIDER=anthropic`);
  process.exit(1);
}

// ── Media tagging ───────────────────────────────────────────────────
export const MEDIA_FILE_MODE = process.env.MEDIA_FILE_MODE ?? "full";
export const MEDIA_SUMMARY_HEAD = parseInt(process.env.MEDIA_SUMMARY_HEAD ?? "2000", 10);
export const MEDIA_SUMMARY_MID  = parseInt(process.env.MEDIA_SUMMARY_MID  ?? "1500", 10);
export const MEDIA_SUMMARY_TAIL = parseInt(process.env.MEDIA_SUMMARY_TAIL ?? "1000", 10);
export const PLAN_FILE = resolvePath(process.env.PLAN_FILE ?? join(OUTPUT_DIR, "PLAN.md"));

// ── Split (large doc chunking) ──────────────────────────────────────
export const MEDIA_SPLIT_THRESHOLD = parseInt(process.env.MEDIA_SPLIT_THRESHOLD ?? "200000", 10);
export const MEDIA_SPLIT_LEVEL = parseInt(process.env.MEDIA_SPLIT_LEVEL ?? "2", 10);
export const MEDIA_SPLIT_MAX_CHUNK = parseInt(process.env.MEDIA_SPLIT_MAX_CHUNK ?? "100000", 10);

// ── Projects (Claude Projects export) ───────────────────────────────
export const BUNDLES_FILE = resolvePath(process.env.BUNDLES_FILE ?? join(BUNDLES_DIR, "bundles.json"));
export const BUNDLE_MIN_QUALITY = process.env.BUNDLE_MIN_QUALITY ?? "medium";
export const BUNDLE_MAX_TOKENS = parseInt(process.env.BUNDLE_MAX_TOKENS ?? "200000", 10);
