/**
 * provider-nomic-uptimize — Embedding via UPTIMIZE /nomic v1 API.
 *
 * Endpoint: https://api.nlp.p.uptimize.merckgroup.com/nomic/v1/embeddings
 * Model:    nomic-embed-text-v1 (768 dimensions, fixed)
 * Auth:     MEDIA_EMBED_API_KEY (falls back to API_KEY if not set)
 *
 * Nomic v1 does not require task prefixes (unlike v1.5),
 * so embedQuery and embedChunks behave identically.
 */
import type { EmbedEngine, EmbedEngineInfo } from "./types.js";
import { runConcurrent } from "./types.js";
import { MEDIA_EMBED_API_KEY, MEDIA_EMBED_API_BASE_URL, MEDIA_EMBED_BATCH_CONCURRENCY } from "../../config.js";

const NOMIC_PATH = "/nomic/v1/embeddings";
const MODEL = "nomic-embed-text-v1";
const DIMENSIONS = 768;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

export class UptimizeNomicEngine implements EmbedEngine {
  private baseUrl: string;
  private apiKey: string;

  constructor(apiKey?: string, apiBaseUrl?: string) {
    const resolvedUrl = apiBaseUrl ?? MEDIA_EMBED_API_BASE_URL;
    const resolvedKey = apiKey ?? MEDIA_EMBED_API_KEY;
    if (!resolvedUrl) {
      console.error("❌ Set MEDIA_EMBED_API_BASE_URL (or API_BASE_URL) in .env for uptimize embedding");
      process.exit(1);
    }
    if (!resolvedKey) {
      console.error("❌ Set MEDIA_EMBED_API_KEY (or API_KEY) in .env");
      process.exit(1);
    }
    this.baseUrl = resolvedUrl;
    this.apiKey = resolvedKey;
  }

  info(): EmbedEngineInfo {
    return { engine: "nomic-uptimize", model: MODEL, dimensions: DIMENSIONS, mode: "api" };
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.callApi(text);
  }

  async embedChunks(
    texts: string[],
    options?: { concurrency?: number; onProgress?: (done: number, total: number) => void },
  ): Promise<number[][]> {
    const concurrency = options?.concurrency ?? MEDIA_EMBED_BATCH_CONCURRENCY;
    const results: number[][] = new Array(texts.length);
    let done = 0;

    await runConcurrent(texts, concurrency, async (text, idx) => {
      results[idx] = await this.callApi(text);
      done++;
      options?.onProgress?.(done, texts.length);
    });

    return results;
  }

  private async callApi(text: string, attempt = 1): Promise<number[]> {
    const url = `${this.baseUrl}${NOMIC_PATH}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers: {
          "content-type": "application/json",
          "api-key": this.apiKey,
        },
        body: JSON.stringify({ input: text, model: MODEL }),
      });
    } catch (err) {
      // Retry on timeout or network errors
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        await new Promise((r) => setTimeout(r, delay));
        return this.callApi(text, attempt + 1);
      }
      throw err;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");

      // Retry on 429 (rate limit) or 5xx
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        await new Promise((r) => setTimeout(r, delay));
        return this.callApi(text, attempt + 1);
      }

      throw new Error(`UPTIMIZE /nomic ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json() as unknown;

    // UPTIMIZE returns the array directly: [{ index, embedding }]
    // OpenAI format wraps it: { data: [{ index, embedding }] }
    const items = Array.isArray(json) ? json : (json as { data?: unknown[] })?.data;

    if (!Array.isArray(items) || !items[0]?.embedding) {
      throw new Error(`Unexpected /nomic response: ${JSON.stringify(json).slice(0, 200)}`);
    }

    return items[0].embedding;
  }
}
