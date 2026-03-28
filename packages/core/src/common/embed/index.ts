/**
 * Embed engine factory — creates the right provider based on RAG_ENGINE.
 *
 * The engine is a singleton: created once, reused everywhere (CLI + web server).
 * Local providers (nomic-local, jina-local) have a ~5s warm-up on first call
 * as they load the ONNX model into memory.
 */
import type { EmbedEngine } from "./types.js";
import { RAG_ENGINE } from "../../config.js";

let _instance: EmbedEngine | null = null;

/** Get or create the embed engine singleton. */
export async function getEmbedEngine(): Promise<EmbedEngine> {
  if (_instance) return _instance;
  _instance = await createEmbedEngine();
  return _instance;
}

async function createEmbedEngine(): Promise<EmbedEngine> {
  switch (RAG_ENGINE) {
    case "nomic-uptimize": {
      const { UptimizeNomicEngine } = await import("./provider-nomic-uptimize.js");
      return new UptimizeNomicEngine();
    }

    case "nomic-local": {
      const { LocalNomicEngine } = await import("./provider-nomic-local.js");
      return new LocalNomicEngine();
    }

    case "jina-local": {
      const { LocalJinaEngine } = await import("./provider-jina-local.js");
      return new LocalJinaEngine();
    }

    default:
      console.error(`❌ Unknown RAG_ENGINE: "${RAG_ENGINE}"`);
      console.error("   Valid options: nomic-uptimize, nomic-local, jina-local");
      process.exit(1);
  }
}

// Re-export types for convenience
export type { EmbedEngine, EmbedEngineInfo, EmbeddingRecord } from "./types.js";
export { runConcurrent } from "./types.js";
