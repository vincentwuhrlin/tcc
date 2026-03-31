/**
 * Embed engine factory — dual singletons for media (corpus) and chat (query).
 *
 * - getMediaEmbedEngine() → uses MEDIA_EMBED_* config (corpus embedding)
 * - getChatEmbedEngine()  → uses CHAT_EMBED_* config (query embedding at chat time)
 * - getEmbedEngine()      → alias for getMediaEmbedEngine() (backward compat)
 *
 * By default CHAT_EMBED_* falls back to MEDIA_EMBED_*, so both return
 * the same engine unless you explicitly set CHAT_EMBED_* in .env.
 *
 * Local providers have a ~5s warm-up on first call (ONNX model load).
 */
import type { EmbedEngine } from "./types.js";
import {
  MEDIA_EMBED_ENGINE, MEDIA_EMBED_DTYPE, MEDIA_EMBED_API_KEY, MEDIA_EMBED_API_BASE_URL,
  CHAT_EMBED_ENGINE, CHAT_EMBED_DTYPE, CHAT_EMBED_API_KEY, CHAT_EMBED_API_BASE_URL,
  type EmbedEngineType,
} from "../../config.js";

// ── Config bundle ───────────────────────────────────────────────────

interface EmbedConfig {
  engine: EmbedEngineType;
  dtype: string;
  apiKey: string;
  apiBaseUrl: string;
}

// ── Singletons ──────────────────────────────────────────────────────

let _mediaInstance: EmbedEngine | null = null;
let _chatInstance: EmbedEngine | null = null;

/** Embed engine for corpus embedding (media:embed command). */
export async function getMediaEmbedEngine(): Promise<EmbedEngine> {
  if (_mediaInstance) return _mediaInstance;
  _mediaInstance = await createEngine({
    engine: MEDIA_EMBED_ENGINE,
    dtype: MEDIA_EMBED_DTYPE,
    apiKey: MEDIA_EMBED_API_KEY,
    apiBaseUrl: MEDIA_EMBED_API_BASE_URL,
  });
  return _mediaInstance;
}

/** Embed engine for query embedding at chat time. */
export async function getChatEmbedEngine(): Promise<EmbedEngine> {
  if (_chatInstance) return _chatInstance;
  _chatInstance = await createEngine({
    engine: CHAT_EMBED_ENGINE,
    dtype: CHAT_EMBED_DTYPE,
    apiKey: CHAT_EMBED_API_KEY,
    apiBaseUrl: CHAT_EMBED_API_BASE_URL,
  });
  return _chatInstance;
}

/** Alias — backward compat for embed commands. */
export const getEmbedEngine = getMediaEmbedEngine;

/** Clear both singletons (e.g. after workspace switch). */
export function clearEngineCache(): void {
  _mediaInstance = null;
  _chatInstance = null;
}

// ── Factory ─────────────────────────────────────────────────────────

async function createEngine(config: EmbedConfig): Promise<EmbedEngine> {
  switch (config.engine) {
    case "nomic-uptimize": {
      const { UptimizeNomicEngine } = await import("./provider-nomic-uptimize.js");
      return new UptimizeNomicEngine(config.apiKey, config.apiBaseUrl);
    }

    case "nomic-local": {
      const { LocalNomicEngine } = await import("./provider-nomic-local.js");
      return new LocalNomicEngine(config.dtype || undefined);
    }

    case "jina-local": {
      const { LocalJinaEngine } = await import("./provider-jina-local.js");
      return new LocalJinaEngine(config.dtype || undefined);
    }

    default:
      console.error(`❌ Unknown embed engine: "${config.engine}"`);
      console.error("   Valid: nomic-uptimize, nomic-local, jina-local");
      process.exit(1);
  }
}

// Re-export types for convenience
export type { EmbedEngine, EmbedEngineInfo, EmbeddingRecord } from "./types.js";
export { runConcurrent } from "./types.js";
