/**
 * provider-jina-local — Jina Embeddings v3 running locally via ONNX.
 *
 * Uses @huggingface/transformers low-level API (not pipeline).
 * Jina v3 uses LoRA task adapters, requiring a task_id input.
 *
 * Model:      jinaai/jina-embeddings-v3 (~570M params, fp16 ~1.1 GB)
 * Dimensions: 1024
 * Context:    8192 tokens
 * Tasks:      retrieval.query, retrieval.passage, separation, classification, text-matching
 *
 * Based on: https://github.com/huggingface/transformers.js/issues/1072
 *
 * First call downloads the model (~1.1 GB) and caches it in ~/.cache/huggingface/.
 * Each embedding takes ~1-3s on CPU (570M params is significantly heavier than Nomic 137M).
 */
import type { EmbedEngine, EmbedEngineInfo } from "./types.js";

const MODEL_ID = "jinaai/jina-embeddings-v3";
const MODEL_NAME = "jina-embeddings-v3";
const DIMENSIONS = 1024;

// Lazy-loaded model singleton
let _tokenizer: any = null;
let _model: any = null;
let _taskInstructions: Record<string, string> = {};

async function loadModel() {
  if (_model) return;

  console.log(`   ⏳ Loading ${MODEL_ID} (first time downloads ~1.1 GB)...`);
  const startMs = Date.now();

  const { AutoTokenizer, PreTrainedModel } = await import("@huggingface/transformers");

  _tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  _model = await PreTrainedModel.from_pretrained(MODEL_ID, { dtype: "fp16" });
  _taskInstructions = _model.config.task_instructions ?? {};

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`   ✅ Model loaded in ${elapsed}s`);
}

export class LocalJinaEngine implements EmbedEngine {
  info(): EmbedEngineInfo {
    return { engine: "jina-local", model: MODEL_NAME, dimensions: DIMENSIONS, mode: "local" };
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.run(text, "retrieval.query");
  }

  async embedChunks(
    texts: string[],
    options?: { concurrency?: number; onProgress?: (done: number, total: number) => void },
  ): Promise<number[][]> {
    // CPU-bound: process sequentially
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(await this.run(texts[i], "retrieval.passage"));
      options?.onProgress?.(i + 1, texts.length);
    }
    return results;
  }

  private async run(text: string, task: string): Promise<number[]> {
    await loadModel();

    const { Tensor } = await import("@huggingface/transformers");

    // Add task instruction prefix
    const prefix = _taskInstructions[task] ?? "";
    const prefixedText = prefix + text;

    // Tokenize
    const inputs = await _tokenizer([prefixedText], { padding: true, truncation: true });

    // Get task_id index
    const taskKeys = Object.keys(_taskInstructions);
    const taskId = taskKeys.indexOf(task);

    // Run model with task_id
    const output = await _model({
      ...inputs,
      task_id: new Tensor("int64", [taskId >= 0 ? taskId : 0], []),
    });

    // Extract pooled embeddings — Jina v3 returns named outputs,
    // the pooled_embeds key may be numeric (13049) or named
    const pooled = output.pooled_embeds ?? output.text_embeds ?? Object.values(output).find(
      (v: any) => v?.dims && v.dims[v.dims.length - 1] === DIMENSIONS,
    );

    if (!pooled) {
      throw new Error("Could not extract embeddings from Jina v3 output");
    }

    // Normalize
    const normalized = pooled.normalize();
    const data: Float32Array = normalized.data;

    // Return first (and only) embedding
    return Array.from(data).slice(0, DIMENSIONS);
  }
}
