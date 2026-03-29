/**
 * provider-jina-local — Jina Embeddings v3 running locally via ONNX.
 *
 * Uses @huggingface/transformers low-level API (not pipeline).
 * Jina v3 uses LoRA task adapters, requiring a task_id input.
 *
 * Model:      jinaai/jina-embeddings-v3 (~570M params)
 * Dimensions: 1024
 * Context:    8192 tokens
 * Tasks:      retrieval.query, retrieval.passage, separation, classification, text-matching
 *
 * Quantization controlled by RAG_DTYPE env var or constructor param:
 *   - "fp16" → half precision, ~1.1 GB (default)
 *   - "fp32" → full precision, ~2.2 GB (best quality, slowest)
 *
 * Model name in DB includes dtype: "jina-embeddings-v3-fp16", etc.
 *
 * Based on: https://github.com/huggingface/transformers.js/issues/1072
 */
import type { EmbedEngine, EmbedEngineInfo } from "./types.js";
import { RAG_DTYPE } from "../../config.js";

const MODEL_ID = "jinaai/jina-embeddings-v3";
const DIMENSIONS = 1024;
const DEFAULT_DTYPE = "fp16";
const VALID_DTYPES = ["fp16", "fp32"];

const DTYPE_SIZES: Record<string, string> = {
  fp16: "~1.1 GB",
  fp32: "~2.2 GB",
};

// Model cache — keyed by dtype
const _models: Map<string, { tokenizer: any; model: any; taskInstructions: Record<string, string> }> = new Map();

async function loadModel(dtype: string) {
  if (_models.has(dtype)) return _models.get(dtype)!;

  const size = DTYPE_SIZES[dtype] ?? "unknown size";
  console.log(`   ⏳ Loading ${MODEL_ID} [${dtype}] (first time downloads ${size})...`);
  const startMs = Date.now();

  const { AutoTokenizer, PreTrainedModel } = await import("@huggingface/transformers");

  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  const model = await PreTrainedModel.from_pretrained(MODEL_ID, { dtype });
  const taskInstructions = model.config.task_instructions ?? {};

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`   ✅ Model loaded in ${elapsed}s [${dtype}]`);

  const entry = { tokenizer, model, taskInstructions };
  _models.set(dtype, entry);
  return entry;
}

export class LocalJinaEngine implements EmbedEngine {
  private dtype: string;

  constructor(dtype?: string) {
    const resolved = dtype ?? RAG_DTYPE || DEFAULT_DTYPE;
    if (!VALID_DTYPES.includes(resolved)) {
      console.error(`❌ Invalid RAG_DTYPE="${resolved}" for jina-local. Valid: ${VALID_DTYPES.join(", ")}`);
      process.exit(1);
    }
    this.dtype = resolved;
  }

  info(): EmbedEngineInfo {
    return {
      engine: "jina-local",
      model: `jina-embeddings-v3-${this.dtype}`,
      dimensions: DIMENSIONS,
      mode: "local",
    };
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.run(text, "retrieval.query");
  }

  async embedChunks(
    texts: string[],
    options?: { concurrency?: number; onProgress?: (done: number, total: number) => void },
  ): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(await this.run(texts[i], "retrieval.passage"));
      options?.onProgress?.(i + 1, texts.length);
    }
    return results;
  }

  private async run(text: string, task: string): Promise<number[]> {
    const { tokenizer, model, taskInstructions } = await loadModel(this.dtype);
    const { Tensor } = await import("@huggingface/transformers");

    const prefix = taskInstructions[task] ?? "";
    const prefixedText = prefix + text;

    const inputs = await tokenizer([prefixedText], { padding: true, truncation: true });

    const taskKeys = Object.keys(taskInstructions);
    const taskId = taskKeys.indexOf(task);

    const output = await model({
      ...inputs,
      task_id: new Tensor("int64", [taskId >= 0 ? taskId : 0], []),
    });

    const pooled = output.pooled_embeds ?? output.text_embeds ?? Object.values(output).find(
      (v: any) => v?.dims && v.dims[v.dims.length - 1] === DIMENSIONS,
    );

    if (!pooled) {
      throw new Error("Could not extract embeddings from Jina v3 output");
    }

    const normalized = pooled.normalize();
    const data: Float32Array = normalized.data;
    return Array.from(data).slice(0, DIMENSIONS);
  }
}
