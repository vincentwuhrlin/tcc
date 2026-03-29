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
 * Quantization controlled by RAG_DTYPE env var or constructor param:
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
import { RAG_DTYPE } from "../../config.js";

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
    const resolved = dtype ?? (RAG_DTYPE || DEFAULT_DTYPE);
    if (!VALID_DTYPES.includes(resolved)) {
      console.error(`❌ Invalid RAG_DTYPE="${resolved}" for nomic-local. Valid: ${VALID_DTYPES.join(", ")}`);
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
    // Truncate long texts to avoid ONNX rotary embedding bugs in fp16/fp32
    // with certain sequence lengths (off-by-one in rotary position embeddings).
    // 4000 chars ≈ 1000 tokens — safe threshold. Matches MEDIA_SPLIT_MAX_CHUNK.
    // After re-split, all chunks will be ≤4000 chars so no truncation occurs.
    const MAX_INPUT_CHARS = 4000;
    const safeText = prefixedText.length > MAX_INPUT_CHARS
      ? prefixedText.slice(0, MAX_INPUT_CHARS)
      : prefixedText;

    const extractor = await getPipeline(this.dtype);
    const output = await extractor(safeText, { pooling: "mean", normalize: true });
    return Array.from(output.data).slice(0, DIMENSIONS) as number[];
  }
}
