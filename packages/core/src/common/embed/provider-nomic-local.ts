/**
 * provider-nomic-local — Nomic Embed Text v1.5 running locally via ONNX.
 *
 * Uses @huggingface/transformers (transformers.js) to run the model
 * directly in Node.js on CPU. No server, no API, no network needed.
 *
 * Model:      nomic-ai/nomic-embed-text-v1.5
 * Dimensions: 768 (full matryoshka)
 * Context:    8192 tokens
 *
 * Quantization controlled by MEDIA_EMBED_DTYPE env var or constructor param:
 *   - "q8"   → int8 quantized, ~137 MB (default, fastest)
 *   - "fp16" → half precision, ~274 MB
 *   - "fp32" → full precision, ~547 MB (best quality, slowest)
 *
 * Model name in DB includes dtype: "nomic-embed-text-v1.5-q8", "nomic-embed-text-v1.5-fp16", etc.
 * This allows different dtypes to coexist in the same workspace.db.
 *
 * Nomic v1.5 requires task prefixes:
 *   - embedChunks: "search_document: <text>"
 *   - embedQuery:  "search_query: <text>"
 */
import type { EmbedEngine, EmbedEngineInfo } from "./types.js";
import { MEDIA_EMBED_DTYPE } from "../../config.js";

const MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";
const DIMENSIONS = 768;
const DEFAULT_DTYPE = "q8";
const VALID_DTYPES = ["q8", "fp16", "fp32"];

const DTYPE_SIZES: Record<string, string> = {
  q8: "~137 MB",
  fp16: "~274 MB",
  fp32: "~547 MB",
};

// Pipeline cache — keyed by dtype so multiple instances can coexist
const _pipelines: Map<string, any> = new Map();

async function getPipeline(dtype: string) {
  if (_pipelines.has(dtype)) return _pipelines.get(dtype);

  const size = DTYPE_SIZES[dtype] ?? "unknown size";
  console.log(`   ⏳ Loading ${MODEL_ID} [${dtype}] (first time downloads ${size})...`);
  const startMs = Date.now();

  const { pipeline } = await import("@huggingface/transformers");
  const pipe = await pipeline("feature-extraction", MODEL_ID, {
    dtype,
    revision: "main",
  });

  _pipelines.set(dtype, pipe);
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`   ✅ Model loaded in ${elapsed}s [${dtype}]`);

  return pipe;
}

export class LocalNomicEngine implements EmbedEngine {
  private dtype: string;

  constructor(dtype?: string) {
    const resolved = dtype ?? (MEDIA_EMBED_DTYPE || DEFAULT_DTYPE);
    if (!VALID_DTYPES.includes(resolved)) {
      console.error(`❌ Invalid MEDIA_EMBED_DTYPE="${resolved}" for nomic-local. Valid: ${VALID_DTYPES.join(", ")}`);
      process.exit(1);
    }
    this.dtype = resolved;
  }

  info(): EmbedEngineInfo {
    return {
      engine: "nomic-local",
      model: `nomic-embed-text-v1.5-${this.dtype}`,
      dimensions: DIMENSIONS,
      mode: "local",
    };
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.run(`search_query: ${text}`);
  }

  async embedChunks(
    texts: string[],
    options?: { concurrency?: number; onProgress?: (done: number, total: number) => void },
  ): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(await this.run(`search_document: ${texts[i]}`));
      options?.onProgress?.(i + 1, texts.length);
    }
    return results;
  }

  private async run(prefixedText: string): Promise<number[]> {
    const extractor = await getPipeline(this.dtype);

    // ONNX rotary embedding has an off-by-one bug at certain sequence lengths
    // in fp16/fp32. Strategy: start with full text (capped at safe max),
    // if it crashes, progressively truncate and retry.
    const MAX_INPUT_CHARS = 3500;
    const TRUNCATE_STEP = 200;
    const MAX_RETRIES = 5;

    let text = prefixedText.length > MAX_INPUT_CHARS
      ? prefixedText.slice(0, MAX_INPUT_CHARS)
      : prefixedText;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const output = await extractor(text, { pooling: "mean", normalize: true });
        return Array.from(output.data).slice(0, DIMENSIONS) as number[];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRotaryBug = msg.includes("rotary_emb") || msg.includes("Shape mismatch") || msg.includes("broadcast");
        if (!isRotaryBug || attempt === MAX_RETRIES) throw err;
        // Truncate and retry
        text = text.slice(0, text.length - TRUNCATE_STEP);
      }
    }

    throw new Error("Unreachable");
  }
}
