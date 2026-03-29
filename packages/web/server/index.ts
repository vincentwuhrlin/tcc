/**
 * TCC Web Server — Hono on Node.js
 *
 * Release 4: RAG + sessions + compaction + workspace hot-reload.
 *
 * All workspace state is managed by workspace-manager.ts.
 * Switching workspace reloads DB, RAG index, PLAN.md, INDEX.md.
 */
import "./env.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { API_PROVIDER, API_MODEL, RAG_ENGINE, RAG_TOP_K } from "@tcc/core/src/config.js";
import { getEmbedEngine } from "@tcc/core/src/common/embed/index.js";
import { searchChunks, assembleContext } from "@tcc/core/src/common/rag.js";
import { llmCall } from "@tcc/core/src/common/llm.js";

import * as wm from "./workspace-manager.js";
import {
  createSession, listSessions, deleteSession, updateSessionTitle,
  getSessionMessages, addMessage, getMessageCount,
  buildSessionContext, getMessagesToSummarize, saveCompactionSummary,
  COMPACT_THRESHOLD, SLIDING_WINDOW_SIZE, COMPACT_INTERVAL,
} from "./sessions.js";

const app = new Hono();

// ── Middleware ───────────────────────────────────────────────────────
app.use("*", logger());
app.use("/api/*", cors());

// ── System prompt builder ───────────────────────────────────────────
function buildSystemPrompt(
  ragContext: string,
  sessionSummary: string | null,
  recentMessages: { role: string; content: string }[],
): string {
  const parts: string[] = [
    "You are a knowledgeable technical assistant for the knowledge base described below.",
    "Answer questions precisely, citing sources when possible using the format [filename.md].",
    "If the provided context doesn't contain enough information, say so clearly.",
    "Respond in the same language as the user's question.",
  ];

  if (wm.planContent()) {
    parts.push("", "## Knowledge Base Structure (PLAN.md)", "", wm.planContent());
  }
  if (wm.indexContent()) {
    parts.push("", "## Document Index (INDEX.md)", "", wm.indexContent());
  }
  if (ragContext) {
    parts.push("", "## Relevant Excerpts (from vector search)", "", ragContext);
  }
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
  const summary = await llmCall(COMPACTION_SYSTEM, conversation, 512);
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

// ── Chat ────────────────────────────────────────────────────────────
app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ sessionId: string; message: string }>();
  const { sessionId, message } = body;

  if (!message?.trim()) return c.json({ error: "No message provided" }, 400);
  if (!sessionId) return c.json({ error: "No sessionId provided" }, 400);

  addMessage(sessionId, "user", message);

  const t0 = Date.now();
  let ragContext = "";
  let sources: { source: string; score: number }[] = [];
  let embedMs = 0;
  let searchMs = 0;

  // RAG
  if (wm.ragReady()) {
    try {
      const te = Date.now();
      const engine = await getEmbedEngine();
      const queryVector = await engine.embedQuery(message);
      embedMs = Date.now() - te;

      const ts = Date.now();
      const results = searchChunks(queryVector, RAG_TOP_K);
      searchMs = Date.now() - ts;

      ragContext = assembleContext(results, 80_000);
      const seen = new Set<string>();
      sources = results
        .filter((r) => { if (seen.has(r.source)) return false; seen.add(r.source); return true; })
        .slice(0, 10)
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

  // LLM
  try {
    const recentWithoutCurrent = ctx.recentMessages.slice(0, -1);
    const systemPrompt = buildSystemPrompt(ragContext, summary, recentWithoutCurrent);
    const tl = Date.now();
    const response = await llmCall(systemPrompt, message, 4096);
    const llmMs = Date.now() - tl;

    addMessage(sessionId, "assistant", response);

    return c.json({
      role: "assistant",
      content: response,
      sessionId,
      sources,
      timing: { embed_ms: embedMs, search_ms: searchMs, llm_ms: llmMs, total_ms: Date.now() - t0 },
      context: { totalMessages: ctx.totalMessages + 2, hasCompaction: !!summary, windowSize: ctx.recentMessages.length - 1 },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`❌ LLM error: ${errorMsg}`);
    return c.json({ role: "assistant", content: `**Error** — ${errorMsg}`, sessionId, sources: [] }, 500);
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/api/health", (c) =>
  c.json({
    status: "ok", release: 4,
    ragReady: wm.ragReady(), ragChunks: wm.ragChunkCount(),
    workspace: wm.currentWorkspace().id,
    compaction: { threshold: COMPACT_THRESHOLD, windowSize: SLIDING_WINDOW_SIZE, interval: COMPACT_INTERVAL },
  }),
);

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
console.log("  ║  🔥 TCC Server (Hono) — Release 4           ║");
console.log(sep);
console.log(line("🤖", `LLM: ${API_PROVIDER} / ${API_MODEL}`));
console.log(line("🧲", `RAG: ${RAG_ENGINE}`));
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
