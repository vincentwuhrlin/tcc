/**
 * EmbedEngine — abstract interface for text embedding providers.
 *
 * Implementations:
 *   - provider-nomic-uptimize  → UPTIMIZE /nomic v1 API
 *   - provider-nomic-local     → @huggingface/transformers (nomic v1.5 ONNX)
 *   - provider-jina-local      → @huggingface/transformers (jina v3 ONNX)
 *
 * All providers must produce normalized vectors (unit length).
 * Vectors from different providers are NOT comparable — always re-embed
 * the full corpus when switching providers.
 */

// ── Interface ────────────────────────────────────────────────────────

export interface EmbedEngine {
  /**
   * Embed a user question for RAG search.
   * Some models (Nomic v1.5) prefix with "search_query:".
   */
  embedQuery(text: string): Promise<number[]>;

  /**
   * Embed document chunks for RAG indexation.
   * Some models (Nomic v1.5) prefix with "search_document:".
   * Supports concurrency for parallel API calls.
   */
  embedChunks(
    texts: string[],
    options?: {
      concurrency?: number;
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<number[][]>;

  /** Engine metadata — used for logging, validation, and benchmarking. */
  info(): EmbedEngineInfo;
}

export interface EmbedEngineInfo {
  /** Provider key matching MEDIA_EMBED_ENGINE env var */
  engine: string;
  /** Model identifier (e.g. "nomic-embed-text-v1") */
  model: string;
  /** Vector dimensions (768, 1024, etc.) */
  dimensions: number;
  /** "api" or "local" */
  mode: "api" | "local";
}

// ── Embedding record (stored in SQLite) ─────────────────────────────

export interface EmbeddingRecord {
  /** Chunk ID — usually the relative path (e.g. "documents/chunks/file__chunk_01.md") */
  id: string;
  /** Source file that produced this chunk */
  source: string;
  /** The text content that was embedded */
  content: string;
  /** Binary vector (Float32Array serialized to Buffer) */
  vector: Buffer;
  /** Engine that produced this vector */
  model: string;
  /** Vector dimensions */
  dimensions: number;
}

// ── Concurrency helper ──────────────────────────────────────────────

/**
 * Run async tasks with a concurrency limit.
 * Used by providers to parallelize API calls or CPU work.
 */
export async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
}
