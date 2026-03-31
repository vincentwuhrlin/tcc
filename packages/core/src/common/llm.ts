/**
 * LLM wrapper — supports streaming (Vercel AI SDK) and batch (Anthropic Batch API).
 *
 * Providers:
 *   - "anthropic" → Anthropic direct (streaming + batch)
 *   - "uptimize"  → UPTIMIZE Foundry (streaming only, OpenAI-compatible proxy)
 *
 * Config scopes:
 *   - API_* → default config, used by media pipeline commands (discover, classify, synthesize)
 *   - CHAT_API_* → chat-specific config (falls back to API_*)
 *   - Pass a LlmConfig to llmCall/llmStreamCall to override at call site
 *
 * Modes (MEDIA_API_MODE):
 *   - "streaming" → one call at a time via Vercel AI SDK (works with both providers)
 *   - "batch"     → submit all at once via Anthropic Batch API (anthropic provider only, -50% cost)
 */
import { generateText, streamText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  API_PROVIDER, API_KEY, API_MODEL, API_BASE_URL, MEDIA_API_MODE,
  CHAT_API_PROVIDER, CHAT_API_KEY, CHAT_API_MODEL, CHAT_API_BASE_URL,
  type ApiProvider,
} from "../config.js";

// ── LLM Config ──────────────────────────────────────────────────────

export interface LlmConfig {
  provider: ApiProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Default config for media pipeline commands. */
export function getDefaultLlmConfig(): LlmConfig {
  return { provider: API_PROVIDER, apiKey: API_KEY, baseUrl: API_BASE_URL, model: API_MODEL };
}

/** Chat-specific config (falls back to API_* via config.ts). */
export function getChatLlmConfig(): LlmConfig {
  return { provider: CHAT_API_PROVIDER, apiKey: CHAT_API_KEY, baseUrl: CHAT_API_BASE_URL, model: CHAT_API_MODEL };
}

// ── Vercel AI SDK provider ──────────────────────────────────────────

function getProvider(config?: LlmConfig) {
  const prov = config?.provider ?? API_PROVIDER;
  const key = config?.apiKey ?? API_KEY;
  const baseUrl = config?.baseUrl ?? API_BASE_URL;
  const model = config?.model ?? API_MODEL;

  if (!key) {
    console.error("❌ Set API_KEY in .env");
    process.exit(1);
  }

  if (prov === "uptimize") {
    if (!baseUrl) {
      console.error("❌ Set API_BASE_URL in .env for uptimize provider");
      process.exit(1);
    }

    return createOpenAI({
      apiKey: key,
      baseURL: `${baseUrl}/not-used`,
      fetch: async (input, init) => {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        const m = body.model || model;
        const url = `${baseUrl}/model/${m}/invoke`;

        const headers = new Headers(init?.headers);
        headers.set("api-key", key);
        headers.set("openai-standard", "True");
        headers.set("content-type", "application/json");
        headers.delete("Authorization");

        return globalThis.fetch(url, { ...init, headers });
      },
    });
  }

  return createAnthropic({ apiKey: key });
}

// ── Streaming call (one at a time) ──────────────────────────────────

/** Call the LLM with a system prompt and user message. Returns the text response. */
export async function llmCall(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 4096,
  config?: LlmConfig,
): Promise<string> {
  const cfg = config ?? getDefaultLlmConfig();
  const provider = getProvider(cfg);
  const model = provider(cfg.model);

  const { text } = await generateText({
    model,
    system: systemPrompt,
    prompt: userMessage,
    maxTokens,
  });

  return text.trim();
}

/**
 * Stream LLM response as an async iterable of text chunks.
 * Each yielded string is a partial token/word from the model.
 */
export function llmStreamCall(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 4096,
  config?: LlmConfig,
): { textStream: AsyncIterable<string> } {
  const cfg = config ?? getDefaultLlmConfig();
  const provider = getProvider(cfg);
  const model = provider(cfg.model);

  const result = streamText({
    model,
    system: systemPrompt,
    prompt: userMessage,
    maxTokens,
  });

  return { textStream: result.textStream };
}

// ── Batch API (Anthropic only, -50% cost) ───────────────────────────

const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_API_VERSION = "2023-06-01";
const POLL_INTERVAL_MS = 30_000; // 30s

export interface BatchRequest {
  customId: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}

export interface BatchResult {
  customId: string;
  text: string;
}

async function anthropicRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${ANTHROPIC_API_BASE}${path}`, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * Submit a batch, poll until done, return results. All-in-one.
 * Prints progress to stdout.
 */
export async function llmBatchCall(requests: BatchRequest[]): Promise<BatchResult[]> {
  if (API_PROVIDER !== "anthropic") {
    throw new Error("Batch mode requires API_PROVIDER=anthropic");
  }

  const model = API_MODEL.startsWith("claude-") ? API_MODEL
    : API_MODEL === "sonnet" ? "claude-sonnet-4-6-20250514"
    : API_MODEL === "haiku" ? "claude-haiku-4-5-20251001"
    : API_MODEL;

  // 1. Submit
  const batchRequests = requests.map((r) => ({
    custom_id: r.customId,
    params: {
      model,
      max_tokens: r.maxTokens ?? 1024,
      system: r.systemPrompt,
      messages: [{ role: "user", content: r.userMessage }],
    },
  }));

  console.log(`🚀 Submitting batch (${requests.length} requests, model: ${model})...`);

  const submitResult = await anthropicRequest("POST", "/messages/batches", {
    requests: batchRequests,
  }) as { id: string };

  const batchId = submitResult.id;
  console.log(`   Batch ID: ${batchId}`);

  // 2. Poll
  console.log(`⏳ Polling every ${POLL_INTERVAL_MS / 1000}s...`);

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const status = await anthropicRequest("GET", `/messages/batches/${batchId}`) as {
      processing_status: string;
      request_counts: { succeeded?: number; processing?: number; errored?: number };
      results_url?: string;
    };

    const succeeded = status.request_counts.succeeded ?? 0;
    const processing = status.request_counts.processing ?? 0;
    const errored = status.request_counts.errored ?? 0;
    const total = requests.length;
    const pct = Math.round((succeeded / total) * 100);

    process.stdout.write(`\r   ⏳ ${succeeded}/${total} done (${pct}%) | ${processing} processing | ${errored} errors`);

    if (status.processing_status === "ended") {
      console.log(); // newline after progress
      if (!status.results_url) {
        throw new Error("Batch ended but no results URL (may have expired)");
      }

      // 3. Download results
      console.log("📥 Downloading results...");
      return await downloadBatchResults(status.results_url);
    }
  }
}

async function downloadBatchResults(resultsUrl: string): Promise<BatchResult[]> {
  const res = await fetch(resultsUrl, {
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": ANTHROPIC_API_VERSION,
    },
  });

  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const text = await res.text();
  const results: BatchResult[] = [];
  let errors = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line) as {
        custom_id: string;
        result: {
          type: string;
          message?: { content: { type: string; text: string }[] };
        };
      };

      if (entry.result.type !== "succeeded") {
        if (errors < 3) console.log(`   ⚠️  ${entry.custom_id}: ${entry.result.type}`);
        errors++;
        continue;
      }

      const textBlock = entry.result.message?.content?.find((c) => c.type === "text");
      if (textBlock?.text) {
        results.push({ customId: entry.custom_id, text: textBlock.text });
      }
    } catch {
      errors++;
    }
  }

  if (errors > 0) console.log(`   ⚠️  ${errors} error(s) in batch results`);
  console.log(`   ✅ ${results.length} successful results`);

  return results;
}

// ── Config display ──────────────────────────────────────────────────

export function printApiConfig(): void {
  const mode = MEDIA_API_MODE === "batch" ? "batch (-50% cost)" : "streaming";
  console.log(`🤖 Provider: ${API_PROVIDER} | Model: ${API_MODEL} | Mode: ${mode}`);
  if (API_PROVIDER === "uptimize") {
    console.log(`🔗 API: ${API_BASE_URL}`);
  }
}

// ── Error detection ────────────────────────────────────────────────

/** Check if an error is a quota/rate-limit error that should stop the loop. */
export function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /quota|rate.limit|daily.limit/i.test(msg) || /\b(401|429)\b/.test(msg);
}

/** Log a quota error and print a restart hint. Returns true so callers can `if (logQuotaStop(...)) break;` */
export function logQuotaStop(context: string, done: number): true {
  console.log(`\n   🛑 API quota/rate limit reached — stopping ${context}.`);
  console.log(`      ${done} completed. Re-run after quota reset (already processed items will be skipped).`);
  return true;
}
