import { readFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { homedir } from "os";

// ── Find monorepo root (walk up to pnpm-workspace.yaml) ────────────
function findMonorepoRoot(from: string): string {
  let dir = resolve(from);
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

const MONOREPO_ROOT = findMonorepoRoot(process.cwd());

// ── Load .env from monorepo root ────────────────────────────────────
const envPath = join(MONOREPO_ROOT, ".env");
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
  if (p.startsWith("~")) return p.replace("~", homedir());
  return resolve(MONOREPO_ROOT, p);
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

// ── Workspace ────────────────────────────────────────────────────────
// WORKSPACES_DIR = directory containing all workspaces
// WORKSPACE      = active workspace name (subdirectory)
// Full path      = WORKSPACES_DIR/WORKSPACE
// CLI flag --workspace= overrides WORKSPACE name
const workspaceFlag = process.argv.find((a) => a.startsWith("--workspace="))?.split("=")[1];
/** True if --workspace=<name> was passed on the command line (not fallback to env/default). */
export const WORKSPACE_FLAG_EXPLICIT = workspaceFlag !== undefined;
export const WORKSPACES_DIR = resolvePath(process.env.WORKSPACES_DIR ?? "workspaces");
export const WORKSPACE_NAME = workspaceFlag ?? process.env.WORKSPACE ?? "default";
export const WORKSPACE = resolve(WORKSPACES_DIR, WORKSPACE_NAME);

export const MEDIA_DIR = resolvePath(process.env.MEDIA_DIR ?? `${WORKSPACE}/media`);
export const CONTEXT_DIR = resolvePath(process.env.CONTEXT_DIR ?? `${WORKSPACE}/context`);
export const BUNDLES_DIR = resolvePath(process.env.BUNDLES_DIR ?? `${WORKSPACE}/bundles`);

// ── Workspace info (workspace.json) ─────────────────────────────────
export interface WorkspaceInfo {
  name: string;
  title: string;
  description: string;
}

export function loadWorkspaceInfo(): WorkspaceInfo | null {
  const wsJsonPath = join(WORKSPACE, "workspace.json");
  if (!existsSync(wsJsonPath)) return null;
  try {
    return JSON.parse(readFileSync(wsJsonPath, "utf-8"));
  } catch { return null; }
}

/** Print a header with workspace + API info. Call at the start of each command. */
export function printHeader(): void {
  const info = loadWorkspaceInfo();
  console.log();
  console.log("┌─────────────────────────────────────────────────────────────");
  if (info) {
    console.log(`│  📂 ${info.title} (${info.name})`);
    console.log(`│  ${info.description}`);
  } else {
    console.log(`│  📂 ${WORKSPACE_NAME}`);
  }
  console.log("├─────────────────────────────────────────────────────────────");
  console.log(`│  Workspace:  ${WORKSPACE}`);
  console.log(`│  API:        ${API_PROVIDER} | ${API_MODEL} | ${MEDIA_API_MODE}`);
  if (API_PROVIDER === "uptimize" && API_BASE_URL) {
    console.log(`│  API URL:    ${API_BASE_URL}`);
  }
  console.log("└─────────────────────────────────────────────────────────────");
  console.log();
}

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

// ── Media processing (discover) ─────────────────────────────────────
export const MEDIA_DISCOVER_MAX_CHARS = parseInt(process.env.MEDIA_DISCOVER_MAX_CHARS ?? "400000", 10);
export const MEDIA_DISCOVER_SECTION_MAX_CHARS = parseInt(process.env.MEDIA_DISCOVER_SECTION_MAX_CHARS ?? "400000", 10);
export const MEDIA_DISCOVER_MAX_TOKENS = parseInt(process.env.MEDIA_DISCOVER_MAX_TOKENS ?? "1024", 10);

// ── Media processing (synthesize) ───────────────────────────────────
export const MEDIA_SYNTHESIZE_MAX_TOKENS = parseInt(process.env.MEDIA_SYNTHESIZE_MAX_TOKENS ?? "16000", 10);

// ── Media processing (classify) ─────────────────────────────────────
export const MEDIA_CLASSIFY_MAX_TOKENS = parseInt(process.env.MEDIA_CLASSIFY_MAX_TOKENS ?? "512", 10);

export const PLAN_FILE = resolvePath(process.env.PLAN_FILE ?? join(OUTPUT_DIR, "PLAN.md"));

// ── Split (RAG chunking) ────────────────────────────────────────────
export const MEDIA_SPLIT_MAX_CHUNK = parseInt(process.env.MEDIA_SPLIT_MAX_CHUNK ?? "6000", 10);

// ── Embedding (media:embed) ────────────────────────────────────────
// Credentials for corpus embedding. Independent from LLM credentials.
// Falls back to API_KEY / API_BASE_URL if not set explicitly.
export type EmbedEngineType = "nomic-uptimize" | "nomic-local" | "jina-local";
export const MEDIA_EMBED_ENGINE = (process.env.MEDIA_EMBED_ENGINE ?? "nomic-uptimize") as EmbedEngineType;
export const MEDIA_EMBED_API_KEY = process.env.MEDIA_EMBED_API_KEY ?? API_KEY;
export const MEDIA_EMBED_API_BASE_URL = process.env.MEDIA_EMBED_API_BASE_URL ?? API_BASE_URL;
export const MEDIA_EMBED_BATCH_SIZE = parseInt(process.env.MEDIA_EMBED_BATCH_SIZE ?? "10", 10);
export const MEDIA_EMBED_BATCH_CONCURRENCY = parseInt(process.env.MEDIA_EMBED_BATCH_CONCURRENCY ?? "5", 10);

// Quantization for local embedding models.
// Values: "q8" (int8, smallest/fastest), "fp16" (half precision), "fp32" (full precision)
// Stored in model name in DB so different dtypes coexist: e.g. "nomic-embed-text-v1.5-fp16"
export const MEDIA_EMBED_DTYPE = process.env.MEDIA_EMBED_DTYPE ?? "";

// ── Chat ───────────────────────────────────────────────────────────
// Chat has its own LLM + embed config, both falling back to defaults.
// This lets you use e.g. a faster/cheaper model for interactive chat
// while keeping a more powerful model for media pipeline commands.

// Chat LLM (fallback → API_*)
export const CHAT_API_PROVIDER = (process.env.CHAT_API_PROVIDER ?? API_PROVIDER) as ApiProvider;
export const CHAT_API_KEY = process.env.CHAT_API_KEY ?? API_KEY;
export const CHAT_API_BASE_URL = process.env.CHAT_API_BASE_URL ?? API_BASE_URL;
export const CHAT_API_MODEL = process.env.CHAT_API_MODEL ?? API_MODEL;
// LLM streaming: true = stream tokens from LLM API (requires provider support).
// false = wait for full response, then send via SSE in one shot.
// Either way the frontend uses SSE — this only controls the LLM ↔ server leg.
export const CHAT_API_STREAMING = (process.env.CHAT_API_STREAMING ?? "true") === "true";

// Chat embedding (fallback → MEDIA_EMBED_*)
// ⚠️ CHAT_EMBED model must produce vectors compatible with the corpus embeddings in DB.
export const CHAT_EMBED_ENGINE = (process.env.CHAT_EMBED_ENGINE ?? MEDIA_EMBED_ENGINE) as EmbedEngineType;
export const CHAT_EMBED_DTYPE = process.env.CHAT_EMBED_DTYPE ?? MEDIA_EMBED_DTYPE;
export const CHAT_EMBED_API_KEY = process.env.CHAT_EMBED_API_KEY ?? MEDIA_EMBED_API_KEY;
export const CHAT_EMBED_API_BASE_URL = process.env.CHAT_EMBED_API_BASE_URL ?? MEDIA_EMBED_API_BASE_URL;

// Chat search
export const CHAT_TOP_K = parseInt(process.env.CHAT_TOP_K ?? "20", 10);
export const CHAT_MIN_SCORE = parseFloat(process.env.CHAT_MIN_SCORE ?? "0.3");
export const CHAT_DEEP_SEARCH = (process.env.CHAT_DEEP_SEARCH ?? "false") === "true";

// Focus: load all chunks from selected categories (token budget)
export const CHAT_FOCUS_MAX_TOKENS = parseInt(process.env.CHAT_FOCUS_MAX_TOKENS ?? "150000", 10);

// ── Chat — Compaction (session history summarization) ─────────────
// These control WHEN and HOW the current session's message history is
// summarized to keep LLM context calls bounded. They do NOT affect:
//   - Memories (cross-session facts, controlled via Settings UI)
//   - Semantic history search (always on, no config)

// Trigger compaction when total session history exceeds this threshold.
export const CHAT_COMPACTION_THRESHOLD_TOKENS = parseInt(process.env.CHAT_COMPACTION_THRESHOLD_TOKENS ?? "20000", 10);
// Keep this many tokens of the most recent messages verbatim (not summarized).
export const CHAT_COMPACTION_WINDOW_TOKENS = parseInt(process.env.CHAT_COMPACTION_WINDOW_TOKENS ?? "8000", 10);
// Maximum length of the compaction summary output.
export const CHAT_COMPACTION_SUMMARY_TOKENS = parseInt(process.env.CHAT_COMPACTION_SUMMARY_TOKENS ?? "2000", 10);

// ── Projects (Claude Projects export) ───────────────────────────────
export const BUNDLES_FILE = resolvePath(process.env.BUNDLES_FILE ?? join(BUNDLES_DIR, "bundles.json"));
export const BUNDLE_MIN_QUALITY = process.env.BUNDLE_MIN_QUALITY ?? "medium";
export const BUNDLE_MAX_TOKENS = parseInt(process.env.BUNDLE_MAX_TOKENS ?? "200000", 10);
