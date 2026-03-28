/**
 * provider-nomic-local — Nomic Embed Text v1.5 running locally via ONNX.
 *
 * Uses @huggingface/transformers (transformers.js) to run the model
 * directly in Node.js on CPU. No server, no API, no network needed.
 *
 * Model:      nomic-ai/nomic-embed-text-v1.5 (quantized int8, ~137 MB)
 * Dimensions: 768 (full matryoshka)
 * Context:    8192 tokens
 *
 * First call downloads the model (~137 MB) and caches it in ~/.cache/huggingface/.
 * Subsequent calls load from cache in ~3-5s.
 * Each embedding takes ~200-400ms on CPU.
 *
 * Nomic v1.5 requires task prefixes:
 *   - embedChunks: "search_document: <text>"
 *   - embedQuery:  "search_query: <text>"
 */
import type { EmbedEngine, EmbedEngineInfo } from "./types.js";

const MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";
const MODEL_NAME = "nomic-embed-text-v1.5";
const DIMENSIONS = 768;

// Lazy-loaded pipeline singleton
let _pipeline: any = null;

async function getPipeline() {
  if (_pipeline) return _pipeline;

  console.log(`   ⏳ Loading ${MODEL_ID} (first time downloads ~137 MB)...`);
  const startMs = Date.now();

  const { pipeline } = await import("@huggingface/transformers");
  _pipeline = await pipeline("feature-extraction", MODEL_ID, {
    dtype: "q8",       // quantized int8 — ~137 MB instead of ~547 MB
    revision: "main",
  });

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`   ✅ Model loaded in ${elapsed}s`);

  return _pipeline;
}

export class LocalNomicEngine implements EmbedEngine {
  info(): EmbedEngineInfo {
    return { engine: "nomic-local", model: MODEL_NAME, dimensions: DIMENSIONS, mode: "local" };
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.run(`search_query: ${text}`);
  }

  async embedChunks(
    texts: string[],
    options?: { concurrency?: number; onProgress?: (done: number, total: number) => void },
  ): Promise<number[][]> {
    // CPU-bound: concurrency > 1 won't help, process sequentially
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(await this.run(`search_document: ${texts[i]}`));
      options?.onProgress?.(i + 1, texts.length);
    }
    return results;
  }

  private async run(prefixedText: string): Promise<number[]> {
    const extractor = await getPipeline();
    const output = await extractor(prefixedText, { pooling: "mean", normalize: true });
    return Array.from(output.data).slice(0, DIMENSIONS) as number[];
  }
}
