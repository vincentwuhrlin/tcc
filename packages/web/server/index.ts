/**
 * TCC Web Server — Hono on Node.js
 *
 * Release 5: RAG + sessions + compaction + domain context + score filtering.
 *
 * All workspace state is managed by workspace-manager.ts.
 * Switching workspace reloads DB, RAG index, domain.md, PLAN.md, INDEX.md.
 */
import "./env.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";

import { API_PROVIDER, API_MODEL, CHAT_EMBED_ENGINE, CHAT_TOP_K, CHAT_MIN_SCORE, CHAT_DEEP_SEARCH, CHAT_API_STREAMING, CHAT_API_PROVIDER, CHAT_API_MODEL } from "@tcc/core/src/config.js";
import { getChatEmbedEngine, getMediaEmbedEngine } from "@tcc/core/src/common/embed/index.js";
import { searchChunks, assembleContext, deepSearch, type SearchResult, type DeepSearchDebug } from "@tcc/core/src/common/rag.js";
import { upsertEmbedding } from "@tcc/core/src/common/db.js";
import { llmCall, llmStreamCall, getChatLlmConfig } from "@tcc/core/src/common/llm.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

import * as wm from "./workspace-manager.js";
import {
  createSession, getSession, listSessions, deleteSession, updateSessionTitle,
  getSessionMessages, addMessage, getMessageCount,
  buildSessionContext, getMessagesToSummarize, saveCompactionSummary,
  COMPACT_THRESHOLD, SLIDING_WINDOW_SIZE, COMPACT_INTERVAL,
} from "./sessions.js";

const app = new Hono();

// ── Middleware ───────────────────────────────────────────────────────
app.use("*", logger());
app.use("/api/*", cors());

// ── Default chat behavior (fallback when no instructions.md) ────────
const DEFAULT_INSTRUCTIONS = `You are a knowledgeable technical assistant for a documentation knowledge base.
Answer questions precisely, citing sources when possible using the format [filename.md §section].
If the provided context doesn't contain enough information, say so clearly.
Respond in the same language as the user's question.`;

// ── System prompt builder ───────────────────────────────────────────
function buildSystemPrompt(
  ragContext: string,
  sessionSummary: string | null,
  recentMessages: { role: string; content: string }[],
): string {
  const parts: string[] = [];

  // 1. Instructions — chat behavior, audience, citation rules
  //    If instructions.md exists, it replaces the default intro entirely.
  parts.push(wm.instructionsContent() || DEFAULT_INSTRUCTIONS);

  // 2. Domain context — vocabulary, components, team context
  if (wm.domainContent()) {
    parts.push("", "## Domain Context", "", wm.domainContent());
  }

  // 3. Plan categories — compact table of contents (headers only)
  if (wm.planHeaders()) {
    parts.push("", "## Knowledge Base Categories", "", wm.planHeaders());
  }

  // 4. RAG chunks — the actual relevant content from vector search
  if (ragContext) {
    parts.push("", "## Relevant Excerpts (from vector search)", "", ragContext);
  }

  // 5. Conversation history
  if (sessionSummary) {
    parts.push("", "## Previous Conversation Summary", "", sessionSummary);
  }
  if (recentMessages.length > 0) {
    parts.push("", "## Recent Conversation");
    for (const msg of recentMessages) {
      parts.push("", `**${msg.role === "user" ? "User" : "Assistant"}:** ${msg.content}`);
    }
  }

  return parts.join("\n");
}

// ── Compaction ───────────────────────────────────────────────────────
const COMPACTION_SYSTEM = `You are a conversation summarizer. Given a chat history between a user and a technical assistant about an industrial knowledge base, produce a concise summary (~150-200 words) that captures:
1. The main topics discussed
2. Key conclusions or answers found
3. The user's specific context or setup (e.g. hardware, network, configuration)
4. Any unresolved questions

Write in English, past tense. Do NOT include greetings or meta-commentary. Just the facts.`;

async function generateCompactionSummary(sessionId: string): Promise<string> {
  const messagesToSummarize = getMessagesToSummarize(sessionId);
  if (messagesToSummarize.length === 0) return "";

  const conversation = messagesToSummarize
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const totalMessages = getMessageCount(sessionId);

  console.log(`  📝 Compacting session ${sessionId}: ${messagesToSummarize.length} messages → summary`);
  const t0 = Date.now();
  const summary = await llmCall(COMPACTION_SYSTEM, conversation, 512, getChatLlmConfig());
  console.log(`  📝 Compaction done in ${Date.now() - t0}ms (${summary.length} chars)`);

  saveCompactionSummary(sessionId, summary, totalMessages);
  return summary;
}

// ═══════════════════════════════════════════════════════════════════
// API Routes
// ═══════════════════════════════════════════════════════════════════

// ── Workspace ───────────────────────────────────────────────────────
app.get("/api/workspace", (c) => {
  const ws = wm.currentWorkspace();
  return c.json({
    id: ws.id,
    name: ws.name,
    title: ws.title,
    description: ws.description,
    stats: { ...ws.stats, ragChunks: wm.ragChunkCount(), ragReady: wm.ragReady() },
  });
});

app.get("/api/workspaces", (c) => {
  const current = wm.currentWorkspace();
  return c.json(
    wm.allWorkspaces().map((ws) => ({
      id: ws.id,
      name: ws.name,
      title: ws.title,
      active: ws.id === current.id,
      stats: ws.stats,
    })),
  );
});

// Switch workspace (hot-reload)
app.post("/api/workspace/:id", async (c) => {
  const id = c.req.param("id");
  const result = await wm.switchWorkspace(id);

  if (!result) {
    return c.json({ error: `Workspace "${id}" not found` }, 404);
  }

  return c.json({
    id: result.id,
    name: result.name,
    title: result.title,
    description: result.description,
    stats: { ...result.stats, ragChunks: wm.ragChunkCount(), ragReady: wm.ragReady() },
  });
});

// ── Sessions ────────────────────────────────────────────────────────
app.get("/api/sessions", (c) => c.json(listSessions()));
app.post("/api/sessions", (c) => c.json(createSession(), 201));

app.delete("/api/sessions/:id", (c) => {
  const id = c.req.param("id");
  return deleteSession(id) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

app.patch("/api/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const { title } = await c.req.json<{ title: string }>();
  if (!title?.trim()) return c.json({ error: "Title required" }, 400);
  updateSessionTitle(id, title.trim());
  return c.json({ ok: true, title: title.trim() });
});

app.get("/api/sessions/:id/messages", (c) => {
  const id = c.req.param("id");
  return c.json(getSessionMessages(id));
});

// ── Chat (SSE streaming) ────────────────────────────────────────────
app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ sessionId: string; message: string }>();
  const { sessionId, message } = body;

  if (!message?.trim()) return c.json({ error: "No message provided" }, 400);
  if (!sessionId) return c.json({ error: "No sessionId provided" }, 400);

  // Auto-create session if it doesn't exist (resilience after restart/workspace switch)
  if (!getSession(sessionId)) {
    console.log(`  ⚠️  Session ${sessionId} not found — creating on the fly`);
    createSession(undefined, sessionId);
  }

  addMessage(sessionId, "user", message);

  const t0 = Date.now();
  let ragContext = "";
  let sources: { source: string; score: number }[] = [];
  let ragResults: SearchResult[] = [];
  let embedMs = 0;
  let searchMs = 0;
  let deepSearchDebug: DeepSearchDebug | null = null;

  // RAG (sync — happens before streaming starts)
  if (wm.ragReady()) {
    try {
      const te = Date.now();
      const engine = await getChatEmbedEngine();
      const queryVector = await engine.embedQuery(message);
      embedMs = Date.now() - te;

      const ts = Date.now();
      ragResults = searchChunks(queryVector, CHAT_TOP_K);
      searchMs = Date.now() - ts;

      // Deep search: multi-pass retrieval with LLM-generated sub-queries
      if (CHAT_DEEP_SEARCH && ragResults.length > 0) {
        const chatConfig = getChatLlmConfig();
        const ds = await deepSearch(
          message,
          ragResults,
          (text) => engine.embedQuery(text),
          (system, user, maxTokens) => llmCall(system, user, maxTokens, chatConfig),
          CHAT_TOP_K,
          CHAT_MIN_SCORE,
        );
        ragResults = ds.results;
        deepSearchDebug = ds.debug;
      }

      ragContext = assembleContext(ragResults, 80_000);
      const seen = new Set<string>();
      sources = ragResults
        .filter((r) => { if (seen.has(r.source)) return false; seen.add(r.source); return true; })
        .slice(0, 15)
        .map((r) => ({ source: r.source, score: Math.round(r.score * 1000) / 1000 }));
    } catch (err) {
      console.error(`⚠️  RAG failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Session context (sliding window + compaction)
  const ctx = buildSessionContext(sessionId);
  let summary = ctx.summary;

  if (ctx.needsCompaction && ctx.totalMessages > COMPACT_THRESHOLD) {
    try {
      summary = await generateCompactionSummary(sessionId);
    } catch (err) {
      console.error(`⚠️  Compaction failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const recentWithoutCurrent = ctx.recentMessages.slice(0, -1);
  const systemPrompt = buildSystemPrompt(ragContext, summary, recentWithoutCurrent);

  // SSE streaming response
  return streamSSE(c, async (stream) => {
    // 1. Send metadata (sources, RAG timing, context info)
    await stream.writeSSE({
      data: JSON.stringify({
        type: "meta",
        sources,
        timing: { embed_ms: embedMs, search_ms: searchMs },
        context: { totalMessages: ctx.totalMessages + 2, hasCompaction: !!summary, windowSize: ctx.recentMessages.length - 1 },
      }),
    });

    // 2. Send debug diagnostic (full RAG chunks, prompt breakdown, config)
    const chatConfig = getChatLlmConfig();
    await stream.writeSSE({
      data: JSON.stringify({
        type: "debug",
        query: message,
        rag: {
          totalChunks: wm.ragChunkCount(),
          returned: ragResults.length,
          topK: CHAT_TOP_K,
          minScore: CHAT_MIN_SCORE,
          chunks: ragResults.map((r) => ({
            id: r.id,
            source: r.source,
            score: Math.round(r.score * 1000) / 1000,
            chars: r.content.length,
            preview: r.content.slice(0, 300),
          })),
        },
        prompt: {
          totalChars: systemPrompt.length,
          instructions: wm.instructionsContent().length,
          domain: wm.domainContent().length,
          plan: wm.planHeaders().length,
          ragContext: ragContext.length,
          history: recentWithoutCurrent.reduce((s, m) => s + m.content.length, 0),
          summary: summary?.length ?? 0,
        },
        session: {
          id: sessionId,
          totalMessages: ctx.totalMessages + 1,
          windowSize: recentWithoutCurrent.length,
          hasCompaction: !!summary,
          needsCompaction: ctx.needsCompaction,
        },
        config: {
          provider: chatConfig.provider,
          model: chatConfig.model,
          streaming: CHAT_API_STREAMING,
          embedEngine: CHAT_EMBED_ENGINE,
        },
        deepSearch: deepSearchDebug ?? { enabled: false, subQueries: [], pass1Count: ragResults.length, pass2Count: 0, mergedCount: ragResults.length, deduped: 0, timings: { subQueryGenMs: 0, pass2EmbedMs: 0, pass2SearchMs: 0, totalMs: 0 } },
      }),
    });

    // 3. LLM response (streaming or full, both sent via SSE)
    let fullText = "";
    const tl = Date.now();

    try {
      if (CHAT_API_STREAMING) {
        // Stream tokens from LLM → pipe as SSE delta events
        const { textStream } = llmStreamCall(systemPrompt, message, 4096, chatConfig);
        for await (const chunk of textStream) {
          fullText += chunk;
          await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: chunk }) });
        }
      } else {
        // Wait for full response → send as single SSE delta event
        fullText = await llmCall(systemPrompt, message, 4096, chatConfig);
        await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: fullText }) });
      }

      const llmMs = Date.now() - tl;

      // 3. Save complete response to DB
      addMessage(sessionId, "assistant", fullText);

      // 4. Send done event with final timing
      await stream.writeSSE({
        data: JSON.stringify({
          type: "done",
          timing: { embed_ms: embedMs, search_ms: searchMs, llm_ms: llmMs, total_ms: Date.now() - t0 },
        }),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`❌ LLM stream error: ${errorMsg}`);
      await stream.writeSSE({
        data: JSON.stringify({ type: "error", message: errorMsg }),
      });
    }
  });
});

// ── QA Tagging ─────────────────────────────────────────────────────

/** Return PLAN.md categories for the QA modal dropdown. */
app.get("/api/qa/categories", (c) => {
  const headers = wm.planHeaders();
  if (!headers) return c.json({ categories: [] });

  // Parse "A. Category Name" lines (not indented subcategories)
  const categories = headers
    .split("\n")
    .filter((l) => !l.startsWith("  ") && l.trim())
    .map((l) => l.trim());

  return c.json({ categories });
});

/** LLM-generate title + category + condensed version for a QA pair. */
app.post("/api/qa/prepare", async (c) => {
  const { question, answer } = await c.req.json<{ question: string; answer: string }>();

  if (!question?.trim() || !answer?.trim()) {
    return c.json({ error: "question and answer are required" }, 400);
  }

  const categories = wm.planHeaders()
    .split("\n")
    .filter((l) => !l.startsWith("  ") && l.trim())
    .map((l) => l.trim());

  const systemPrompt = `You are a knowledge base curator. Given a Q&A exchange, produce a JSON object with:
- "title": a concise descriptive title (30–80 chars, in the language of the content)
- "category": the best matching category from the list below (exact string), or "Uncategorized" if none fits
- "condensed": a condensed version of the Q+A optimized for semantic search (150–250 tokens max, same language as content). Format: "Q: <short question>\\nA: <key points of the answer>". Keep technical terms, drop filler.

Available categories:
${categories.map((c) => `- ${c}`).join("\n")}

Respond ONLY with valid JSON, no markdown fences, no preamble.`;

  const userMsg = `## Question\n${question}\n\n## Answer\n${answer}`;

  try {
    const raw = await llmCall(systemPrompt, userMsg, 1024, getChatLlmConfig());
    const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const result = JSON.parse(cleaned) as { title: string; category: string; condensed: string };

    return c.json({
      title: result.title,
      category: result.category,
      condensed: result.condensed,
      categories,
    });
  } catch (err) {
    console.error("❌ QA prepare failed:", err);
    return c.json({ error: `LLM call failed: ${err instanceof Error ? err.message : err}` }, 500);
  }
});

/** Save a QA document: write file → embed condensed → upsert → reload index. */
app.post("/api/qa/save", async (c) => {
  const { question, answer, title, category, condensed, sessionId } =
    await c.req.json<{
      question: string; answer: string; title: string;
      category: string; condensed: string; sessionId?: string;
    }>();

  if (!question?.trim() || !answer?.trim() || !title?.trim() || !condensed?.trim()) {
    return c.json({ error: "question, answer, title, and condensed are required" }, 400);
  }

  const wsPath = wm.currentWorkspacePath();
  const qaDir = join(wsPath, "qa");

  // Ensure qa/ directory exists
  if (!existsSync(qaDir)) {
    mkdirSync(qaDir, { recursive: true });
  }

  // Generate slug from title
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F]+/gi, "_") // keep accented chars
    .replace(/^_|_$/g, "")
    .slice(0, 80);
  const id = `QA__${slug}`;
  const filename = `${id}.md`;
  const filepath = join(qaDir, filename);

  // Build the markdown file with YAML frontmatter
  const now = new Date().toISOString();
  const fileContent = `---
title: "${title.replace(/"/g, '\\"')}"
category: "${category}"
source_type: qa
session_id: "${sessionId ?? "unknown"}"
created_at: "${now}"
condensed: |
  ${condensed.split("\n").join("\n  ")}
---

## Question

${question}

## Answer

${answer}
`;

  try {
    // 1. Write file
    writeFileSync(filepath, fileContent, "utf-8");
    console.log(`  🏷️  QA saved: ${filename}`);

    // 2. Embed the condensed version
    const engine = await getMediaEmbedEngine();
    const info = engine.info();
    const [vector] = await engine.embedChunks([condensed]);

    // 3. Upsert into DB (content = full Q+A for RAG context injection)
    const fullContent = `Q: ${question}\n\nA: ${answer}`;
    const sourceLabel = `QA: ${title}`;
    upsertEmbedding(id, sourceLabel, fullContent, vector, info.model, info.dimensions);
    console.log(`  🧲 QA embedded: ${id} (${info.engine}, ${info.dimensions}d)`);

    // 4. Hot-reload RAG index + refresh cached stats
    const newCount = await wm.reloadRagIndex();
    await wm.refreshStats();
    console.log(`  🧠 RAG index reloaded: ${newCount} chunks`);

    return c.json({ ok: true, id, filename, ragChunks: newCount });
  } catch (err) {
    console.error("❌ QA save failed:", err);
    return c.json({ error: `Save failed: ${err instanceof Error ? err.message : err}` }, 500);
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/api/health", (c) =>
  c.json({
    status: "ok", release: 5,
    ragReady: wm.ragReady(), ragChunks: wm.ragChunkCount(), ragMinScore: CHAT_MIN_SCORE,
    streaming: CHAT_API_STREAMING,
    hasInstructions: !!wm.instructionsContent(),
    hasDomain: !!wm.domainContent(),
    hasPlan: !!wm.planHeaders(),
    workspace: wm.currentWorkspace().id,
    compaction: { threshold: COMPACT_THRESHOLD, windowSize: SLIDING_WINDOW_SIZE, interval: COMPACT_INTERVAL },
  }),
);

// ── Start ───────────────────────────────────────────────────────────

/** Detailed workspace stats for the debug panel (served from cache). */
app.get("/api/workspace/stats", (c) => {
  const stats = wm.workspaceStats();
  if (!stats) return c.json({ error: "Stats not yet computed" }, 503);
  return c.json(stats);
});

// ── Start ───────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? "3001", 10);

const W = 44;
const line = (icon: string, text: string) => {
  const content = `${icon} ${text}`;
  const truncated = content.length > W ? content.slice(0, W - 1) + "…" : content;
  return `  ║  ${truncated.padEnd(W)}║`;
};
const sep = "  ╠══════════════════════════════════════════════╣";

console.log();
console.log("  ╔══════════════════════════════════════════════╗");
console.log("  ║  🔥 TCC Server (Hono) — Release 5           ║");
console.log(sep);
console.log(line("🤖", `LLM: ${CHAT_API_PROVIDER} / ${CHAT_API_MODEL}`));
console.log(line("🧲", `Embed: ${CHAT_EMBED_ENGINE} (min ${(CHAT_MIN_SCORE * 100).toFixed(0)}%)`));
console.log(line("⚡", `Stream: ${CHAT_API_STREAMING ? "ON" : "OFF"}`));
console.log(line("📝", `Compaction: >${COMPACT_THRESHOLD} msgs → summ + ${SLIDING_WINDOW_SIZE} recent`));
console.log(sep);

await wm.init();

console.log(sep);

serve({ fetch: app.fetch, port }, () => {
  const ws = wm.currentWorkspace();
  console.log(line("📂", `${ws.name}: ${ws.title}`));
  console.log(line("📡", `http://localhost:${port}`));
  if (wm.allWorkspaces().length > 1) {
    console.log(sep);
    for (const w of wm.allWorkspaces()) {
      const marker = w.id === ws.id ? "▸" : " ";
      console.log(line(marker, `${w.name}: ${w.title}`));
    }
  }
  console.log("  ╚══════════════════════════════════════════════╝");
  console.log();
});
