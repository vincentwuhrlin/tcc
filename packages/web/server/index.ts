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

import { API_PROVIDER, API_MODEL, CHAT_EMBED_ENGINE, CHAT_TOP_K, CHAT_MIN_SCORE, CHAT_DEEP_SEARCH, CHAT_FOCUS_MAX_TOKENS, CHAT_COMPACTION_SUMMARY_TOKENS, CHAT_COMPACTION_THRESHOLD_TOKENS, CHAT_COMPACTION_WINDOW_TOKENS, CHAT_API_STREAMING, CHAT_API_PROVIDER, CHAT_API_MODEL } from "@tcc/core/src/config.js";
import { getChatEmbedEngine, getMediaEmbedEngine } from "@tcc/core/src/common/embed/index.js";
import { searchChunks, assembleContext, deepSearch, extractCategoriesFromResults, getChunksByCategories, type SearchResult, type DeepSearchDebug } from "@tcc/core/src/common/rag.js";
import { upsertEmbedding, getUsageTotal, getUsageByKind, getUsageByDay, getUsageByProvider, getUsageBySession, addMemories, listMemories, getActiveMemories, setMemoryActive, updateMemory, deleteMemory, getMemoryStats, getBoolSetting, setSetting, getAllSettings } from "@tcc/core/src/common/db.js";
import { llmCall, llmStreamCall, getChatLlmConfig } from "@tcc/core/src/common/llm.js";
import { embedAndStoreMessage, searchMessages, backfillMessageEmbeddings, messageIndexSize } from "@tcc/core/src/common/history.js";
import { getChatEmbedEngine } from "@tcc/core/src/common/embed/index.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

import * as wm from "./workspace-manager.js";
import {
  createSession, getSession, listSessions, deleteSession, updateSessionTitle,
  getSessionMessages, addMessage, getMessageCount,
  buildSessionContext, getCompactionInput, saveCompactionSummary,
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

  // 2.5 Memories — persistent facts learned from prior conversations
  //     Only injected if memories feature is enabled for this workspace.
  if (getBoolSetting("memories_enabled", true)) {
    const activeMemories = getActiveMemories();
    if (activeMemories.length > 0) {
      parts.push("", "## What you know about the user (from prior conversations)", "");
      parts.push("These facts have been extracted from earlier sessions and persist across conversations. Use them naturally — do not announce that you are 'remembering' something, just incorporate the knowledge.");
      parts.push("");
      for (const mem of activeMemories) {
        const categoryTag = mem.category ? ` _(${mem.category})_` : "";
        parts.push(`- ${mem.content}${categoryTag}`);
      }
    }
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
const COMPACTION_SYSTEM = `You are producing a structured summary of a conversation that will be used to continue the discussion in a new context window. The summary replaces the full message history — so it MUST preserve every piece of information the assistant would need to continue seamlessly.

Preserve aggressively:
1. The user's goals, ongoing tasks, and current focus
2. Every key technical decision and the reasoning behind it
3. Specific identifiers: file paths, function names, env var names, model names, URLs, IP addresses, ports, versions
4. Code snippets, config fragments, command invocations
5. Concepts, acronyms, and tools introduced (with their meaning)
6. Open questions, planned next steps, and unresolved issues
7. Any personal or organizational context about the user

Format as Markdown with these sections (omit sections that are empty):

## Context
One dense paragraph: what the user is working on, why, and the current state.

## Topics discussed
- Bullet list of the major topics covered, in chronological order

## Decisions and conclusions
- Concrete decisions made, with rationale where relevant

## Code and technical details
- File paths, function names, env vars, configurations, commands, URLs
- Preserve exact names and values — no paraphrasing of identifiers

## Open questions / next steps
- What is still to be done, clarified, or tested

Be dense and precise. Prefer specific names, numbers, and quotations over vague descriptions. Do NOT use meta-commentary ("the user asked about...", "we discussed...") — state facts directly. Do NOT add a preamble or closing remark. Output only the Markdown summary.

If an existing summary is provided, treat it as authoritative for earlier parts of the conversation and merge it with the new messages into a single updated summary that covers everything. Do not lose information from the existing summary.`;

async function generateCompactionSummary(sessionId: string): Promise<string> {
  const { existingSummary, newMessages, newCount } = getCompactionInput(sessionId);
  if (newMessages.length === 0) return existingSummary ?? "";

  const conversation = newMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  // Build the user message: existing summary (if any) + new messages
  let userMessage: string;
  if (existingSummary) {
    userMessage =
      `# Existing summary (authoritative for earlier parts of the conversation)\n\n` +
      `${existingSummary}\n\n` +
      `---\n\n` +
      `# New messages to incorporate into the summary\n\n` +
      `${conversation}\n\n` +
      `---\n\n` +
      `Produce an updated structured summary that merges the existing summary with the new messages. Do not lose information from the existing summary.`;
  } else {
    userMessage =
      `# Conversation to summarize\n\n` +
      `${conversation}\n\n` +
      `---\n\n` +
      `Produce a structured summary of this conversation following the format in the system prompt.`;
  }

  console.log(`  📝 Compacting session ${sessionId}: ${newMessages.length} new messages${existingSummary ? " (rolling)" : ""} → summary`);
  const t0 = Date.now();
  const { text: summary } = await llmCall(COMPACTION_SYSTEM, userMessage, CHAT_COMPACTION_SUMMARY_TOKENS, getChatLlmConfig(), { sessionId, kind: "compaction" });
  console.log(`  📝 Compaction done in ${Date.now() - t0}ms (${summary.length} chars, covers ${newCount} messages)`);

  saveCompactionSummary(sessionId, summary, newCount);
  return summary;
}

// ── Memory extraction ──────────────────────────────────────────────
const MEMORY_EXTRACTION_SYSTEM = `You extract durable, persistent facts about the user from a conversation summary. These facts will be injected into all future conversations with this user, so they must be things that remain true over time.

Extract 0 to 5 facts in these categories:
- **personal**: name, location, organization, role, background
- **project**: ongoing projects, their names and states, tech stacks
- **preference**: tools, languages, coding style, communication preferences
- **technical**: recurring technical decisions, environment setup, versions in use
- **context**: colleagues, collaborators, domain-specific vocabulary

DO NOT extract:
- Temporary or one-off things ("user is currently debugging X")
- Conversation meta ("user asked about Y")
- Things the assistant told the user
- Anything the user explicitly asked you to forget
- Sensitive data (credentials, personal IDs)

Each fact must be:
- A complete, standalone statement (readable without context)
- Specific (no "the user likes things")
- Under 200 characters
- Phrased in third person ("Vincent works at...", not "works at...")

Output ONLY a JSON array (no preamble, no code fences):
[
  { "content": "Vincent works at Merck KTSO in Rosheim, France", "category": "personal" },
  { "content": "Primary project is TCC, a TypeScript RAG tool", "category": "project" }
]

If there are no durable facts worth extracting, output an empty array: []`;

interface ExtractedMemory {
  content: string;
  category: string;
}

/** Extract durable memories from a session's summary and insert them into the memories table. */
async function extractMemoriesFromSession(sessionId: string, summary: string): Promise<number> {
  if (!summary || summary.length < 100) return 0;

  // Dedup against existing active memories — provide them to the LLM so it doesn't re-extract the same facts
  const existing = getActiveMemories();
  const existingBlock = existing.length > 0
    ? `\n\n# Existing memories (do NOT re-extract these)\n${existing.map((m) => `- ${m.content}`).join("\n")}`
    : "";

  const userMessage = `# Conversation summary\n\n${summary}${existingBlock}\n\n---\n\nExtract new durable facts about the user from this summary. Do not repeat any existing memory. Return a JSON array.`;

  try {
    const { text } = await llmCall(
      MEMORY_EXTRACTION_SYSTEM,
      userMessage,
      1024,
      getChatLlmConfig(),
      { sessionId, kind: "memory_extract" },
    );

    // Strip potential code fences
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as ExtractedMemory[];

    if (!Array.isArray(parsed) || parsed.length === 0) return 0;

    // Filter invalid entries
    const valid = parsed.filter(
      (m) => m && typeof m.content === "string" && m.content.trim().length > 0 && m.content.length <= 300,
    );

    if (valid.length === 0) return 0;

    addMemories(
      valid.map((m) => ({
        content: m.content.trim(),
        category: m.category ?? null,
        sourceSessionId: sessionId,
      })),
    );

    console.log(`  🧠 Extracted ${valid.length} new memor${valid.length === 1 ? "y" : "ies"} from session ${sessionId}`);
    return valid.length;
  } catch (err) {
    console.error(`  ⚠️  Memory extraction failed: ${err instanceof Error ? err.message : err}`);
    return 0;
  }
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

  const userMsg = addMessage(sessionId, "user", message);
  // Fire-and-forget: embed the user message for semantic history search
  embedAndStoreMessage(userMsg.id, message).catch(() => {});

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
          async (system, user, maxTokens) => {
            const { text } = await llmCall(system, user, maxTokens, chatConfig, { sessionId, kind: "deep_search" });
            return text;
          },
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
  // Note: compaction is run INSIDE the SSE stream below so we can emit
  // progress events to the client. Until then, summary is just the existing one.

  // Extract focus categories from RAG results (for Focus pills in UI)
  const focusCategories = ragResults.length > 0
    ? extractCategoriesFromResults(ragResults, wm.planHeaders())
    : [];

  // SSE streaming response
  return streamSSE(c, async (stream) => {
    // 1. Send metadata (sources, RAG timing, context info, focus categories)
    await stream.writeSSE({
      data: JSON.stringify({
        type: "meta",
        sources,
        timing: { embed_ms: embedMs, search_ms: searchMs },
        context: { totalMessages: ctx.totalMessages + 2, hasCompaction: !!ctx.summary, windowSize: ctx.recentMessages.length - 1, willCompact: ctx.needsCompaction },
        focusCategories,
      }),
    });

    // 1.5 Run compaction if needed — emit progress events so the UI can show the step
    let summary = ctx.summary;
    if (ctx.needsCompaction) {
      const tCompact = Date.now();
      await stream.writeSSE({ data: JSON.stringify({ type: "compacting" }) });
      try {
        summary = await generateCompactionSummary(sessionId);
        await stream.writeSSE({
          data: JSON.stringify({
            type: "compacted",
            ms: Date.now() - tCompact,
            summaryLength: summary.length,
          }),
        });
        // Fire-and-forget memory extraction — only if memories are enabled
        if (summary && getBoolSetting("memories_enabled", true)) {
          extractMemoriesFromSession(sessionId, summary).catch((err) => {
            console.error(`⚠️  Memory extraction failed: ${err instanceof Error ? err.message : err}`);
          });
        }
      } catch (err) {
        console.error(`⚠️  Compaction failed: ${err instanceof Error ? err.message : err}`);
        await stream.writeSSE({
          data: JSON.stringify({
            type: "compacted",
            ms: Date.now() - tCompact,
            error: err instanceof Error ? err.message : String(err),
          }),
        });
      }
    }

    const recentWithoutCurrent = ctx.recentMessages.slice(0, -1);
    const systemPrompt = buildSystemPrompt(ragContext, summary, recentWithoutCurrent);

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
        const { textStream } = llmStreamCall(systemPrompt, message, 4096, chatConfig, { sessionId, kind: "chat" });
        for await (const chunk of textStream) {
          fullText += chunk;
          await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: chunk }) });
        }
      } else {
        // Wait for full response → send as single SSE delta event
        const result = await llmCall(systemPrompt, message, 4096, chatConfig, { sessionId, kind: "chat" });
        fullText = result.text;
        await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: fullText }) });
      }

      const llmMs = Date.now() - tl;

      // 3. Save complete response to DB + embed for history search
      const assistantMsg = addMessage(sessionId, "assistant", fullText);
      embedAndStoreMessage(assistantMsg.id, fullText).catch(() => {});

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

// ── Focus: deep-dive into a category ────────────────────────────────
// Loads ALL chunks from selected categories, re-runs LLM with full context.

app.post("/api/chat/focus", async (c) => {
  const body = await c.req.json<{ sessionId: string; message: string; category: string }>();
  const { sessionId, message, category } = body;

  if (!message?.trim()) return c.json({ error: "No message provided" }, 400);
  if (!category?.trim()) return c.json({ error: "No category provided" }, 400);
  if (!sessionId) return c.json({ error: "No sessionId provided" }, 400);

  // Auto-create session if needed
  if (!getSession(sessionId)) {
    createSession(undefined, sessionId);
  }

  const t0 = Date.now();

  // Load all chunks for the selected category
  const categoryChunks = getChunksByCategories([category]);
  const focusContext = assembleContext(categoryChunks, CHAT_FOCUS_MAX_TOKENS * 4);

  // Build a Focus-specific system prompt
  const focusSystemParts: string[] = [];
  focusSystemParts.push(wm.instructionsContent() || DEFAULT_INSTRUCTIONS);

  if (wm.domainContent()) {
    focusSystemParts.push("", "## Domain Context", "", wm.domainContent());
  }

  focusSystemParts.push(
    "",
    `## Focus Mode — Category ${category} (${categoryChunks.length} chunks loaded)`,
    "",
    "You have access to ALL documents from this category. Provide an exhaustive, detailed answer.",
    "",
    focusContext,
  );

  // Add session context
  const ctx = buildSessionContext(sessionId);
  const recentWithoutCurrent = ctx.recentMessages.slice(0, -1);
  if (recentWithoutCurrent.length > 0) {
    focusSystemParts.push("", "## Recent Conversation");
    for (const msg of recentWithoutCurrent) {
      focusSystemParts.push("", `**${msg.role === "user" ? "User" : "Assistant"}:** ${msg.content}`);
    }
  }

  const systemPrompt = focusSystemParts.join("\n");

  // Add focus message to session
  const focusMessage = `[Focus: ${category}] ${message}`;
  const focusUserMsg = addMessage(sessionId, "user", focusMessage);
  embedAndStoreMessage(focusUserMsg.id, focusMessage).catch(() => {});

  // SSE streaming response
  return streamSSE(c, async (stream) => {
    // 1. Meta
    const uniqueSources = new Map<string, number>();
    for (const ch of categoryChunks) {
      if (!uniqueSources.has(ch.source)) uniqueSources.set(ch.source, 1);
    }

    await stream.writeSSE({
      data: JSON.stringify({
        type: "meta",
        sources: [...uniqueSources.keys()].slice(0, 20).map((s) => ({ source: s, score: 1.0 })),
        timing: { embed_ms: 0, search_ms: 0 },
        context: { totalMessages: ctx.totalMessages + 2, hasCompaction: false, windowSize: recentWithoutCurrent.length },
        focus: { category, totalChunks: categoryChunks.length, contextChars: focusContext.length },
      }),
    });

    // 2. Debug
    const chatConfig = getChatLlmConfig();
    await stream.writeSSE({
      data: JSON.stringify({
        type: "debug",
        query: focusMessage,
        rag: {
          totalChunks: wm.ragChunkCount(),
          returned: categoryChunks.length,
          topK: categoryChunks.length,
          minScore: 0,
          chunks: categoryChunks.slice(0, 50).map((r) => ({
            id: r.id,
            source: r.source,
            score: 1.0,
            chars: r.content.length,
            preview: r.content.slice(0, 300),
          })),
        },
        prompt: {
          totalChars: systemPrompt.length,
          instructions: wm.instructionsContent().length,
          domain: wm.domainContent().length,
          plan: 0,
          ragContext: focusContext.length,
          history: recentWithoutCurrent.reduce((s, m) => s + m.content.length, 0),
          summary: 0,
        },
        session: {
          id: sessionId,
          totalMessages: ctx.totalMessages + 1,
          windowSize: recentWithoutCurrent.length,
          hasCompaction: false,
          needsCompaction: false,
        },
        config: {
          provider: chatConfig.provider,
          model: chatConfig.model,
          streaming: CHAT_API_STREAMING,
          embedEngine: CHAT_EMBED_ENGINE,
        },
        deepSearch: { enabled: false, subQueries: [], pass1Count: 0, pass2Count: 0, mergedCount: 0, deduped: 0, timings: { subQueryGenMs: 0, pass2EmbedMs: 0, pass2SearchMs: 0, totalMs: 0 } },
        focus: { category, totalChunks: categoryChunks.length, contextChars: focusContext.length },
      }),
    });

    // 3. LLM response
    let fullText = "";
    const tl = Date.now();

    try {
      if (CHAT_API_STREAMING) {
        const { textStream } = llmStreamCall(systemPrompt, message, 4096, chatConfig, { sessionId, kind: "focus" });
        for await (const chunk of textStream) {
          fullText += chunk;
          await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: chunk }) });
        }
      } else {
        const result = await llmCall(systemPrompt, message, 4096, chatConfig, { sessionId, kind: "focus" });
        fullText = result.text;
        await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: fullText }) });
      }

      const llmMs = Date.now() - tl;
      const focusAssistantMsg = addMessage(sessionId, "assistant", fullText);
      embedAndStoreMessage(focusAssistantMsg.id, fullText).catch(() => {});

      await stream.writeSSE({
        data: JSON.stringify({
          type: "done",
          timing: { embed_ms: 0, search_ms: 0, llm_ms: llmMs, total_ms: Date.now() - t0 },
        }),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`❌ Focus LLM error: ${errorMsg}`);
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
    const { text: raw } = await llmCall(systemPrompt, userMsg, 1024, getChatLlmConfig(), { sessionId: null, kind: "qa_prepare" });
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
    compaction: {
      triggerTokens: CHAT_COMPACTION_THRESHOLD_TOKENS,
      slidingWindowTokens: CHAT_COMPACTION_WINDOW_TOKENS,
      summaryMaxTokens: CHAT_COMPACTION_SUMMARY_TOKENS,
    },
  }),
);

// ── Start ───────────────────────────────────────────────────────────

/** Detailed workspace stats for the debug panel (served from cache). */
app.get("/api/workspace/stats", (c) => {
  const stats = wm.workspaceStats();
  if (!stats) return c.json({ error: "Stats not yet computed" }, 503);
  return c.json(stats);
});

// ── Token usage stats ───────────────────────────────────────────────

/** Overall token usage + breakdowns by kind, provider, and day. */
app.get("/api/usage", (c) => {
  const days = parseInt(c.req.query("days") ?? "30", 10);
  return c.json({
    total:      getUsageTotal(),
    byKind:     getUsageByKind(),
    byProvider: getUsageByProvider(),
    byDay:      getUsageByDay(days),
  });
});

/** Per-session usage total. */
app.get("/api/usage/session/:id", (c) => {
  const id = c.req.param("id");
  return c.json(getUsageBySession(id));
});

// ── Memories (cross-session persistent facts) ───────────────────────

/** List all memories (active and inactive). */
app.get("/api/memories", (c) => {
  return c.json({
    memories: listMemories(),
    stats: getMemoryStats(),
  });
});

/** Toggle a memory's active state. */
app.patch("/api/memories/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const body = await c.req.json() as { active?: boolean; content?: string; category?: string | null };

  if (body.active !== undefined) {
    setMemoryActive(id, body.active);
  }
  if (body.content !== undefined || body.category !== undefined) {
    updateMemory(id, { content: body.content, category: body.category });
  }
  return c.json({ ok: true });
});

/** Delete a memory permanently. */
app.delete("/api/memories/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  deleteMemory(id);
  return c.json({ ok: true });
});

/** Manually create a memory. */
app.post("/api/memories", async (c) => {
  const body = await c.req.json() as { content: string; category?: string };
  if (!body.content || typeof body.content !== "string") {
    return c.json({ error: "content required" }, 400);
  }
  const id = addMemories([{ content: body.content, category: body.category ?? null }])[0];
  return c.json({ id, ok: true }, 201);
});

/** Manually trigger memory extraction on a session. Forces a full summary
 *  of ALL messages (ignores sliding window), then extracts memories from it. */
app.post("/api/memories/extract/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const allMessages = getSessionMessages(sessionId);

  if (allMessages.length === 0) {
    return c.json({ error: "Session has no messages yet" }, 400);
  }

  // Build conversation from ALL messages (no sliding window filtering)
  const conversation = allMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const userMessage =
    `# Conversation to summarize\n\n` +
    `${conversation}\n\n` +
    `---\n\n` +
    `Produce a structured summary of this conversation following the format in the system prompt.`;

  try {
    const { text: summary } = await llmCall(
      COMPACTION_SYSTEM,
      userMessage,
      CHAT_COMPACTION_SUMMARY_TOKENS,
      getChatLlmConfig(),
      { sessionId, kind: "compaction" },
    );

    if (!summary || summary.length < 50) {
      return c.json({ error: "Summary too short to extract meaningful memories" }, 400);
    }

    const count = await extractMemoriesFromSession(sessionId, summary);
    return c.json({ extracted: count, summaryLength: summary.length });
  } catch (err) {
    return c.json({ error: `Extraction failed: ${err instanceof Error ? err.message : err}` }, 500);
  }
});

// ── App settings (workspace-scoped key/value config) ────────────────

/** Get all app settings. Typed booleans are normalized for the client. */
app.get("/api/settings", (c) => {
  return c.json({
    memoriesEnabled: getBoolSetting("memories_enabled", true),
    raw: getAllSettings(),
  });
});

/** Update one or more app settings. Booleans are stored as "true"/"false" strings. */
app.post("/api/settings", async (c) => {
  const body = await c.req.json() as Record<string, string | boolean | number>;
  for (const [key, value] of Object.entries(body)) {
    const str = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
    setSetting(key, str);
  }
  return c.json({ ok: true });
});

// ── Semantic history search ──────────────────────────────────────────

/** Search across all messages of all sessions in the current workspace. */
app.get("/api/history/search", async (c) => {
  const q = c.req.query("q")?.trim();
  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const minScore = parseFloat(c.req.query("min_score") ?? "0.3");

  if (!q || q.length < 2) {
    return c.json({ results: [], indexed: messageIndexSize() });
  }

  try {
    const engine = await getChatEmbedEngine();
    const queryVector = await engine.embedQuery(q);
    const results = searchMessages(queryVector, limit, minScore);
    return c.json({ results, indexed: messageIndexSize(), query: q });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** Backfill embeddings for all existing messages that don't have one yet. */
app.post("/api/history/backfill", async (c) => {
  try {
    const engine = await getChatEmbedEngine();
    const info = engine.info();
    // Get all messages from all sessions
    const db = (await import("@tcc/core/src/common/db.js")).getDb();
    const allMessages = db.prepare("SELECT id, content FROM messages ORDER BY id ASC").all() as { id: number; content: string }[];

    const result = await backfillMessageEmbeddings(info.model, () => allMessages);
    return c.json({ ...result, total: allMessages.length, indexed: messageIndexSize() });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** Stats about the history index (total messages, embedded count). */
app.get("/api/history/stats", async (c) => {
  const { getHistoryStats } = await import("@tcc/core/src/common/db.js");
  return c.json({
    ...getHistoryStats(),
    indexed: messageIndexSize(),
  });
});

// ── Start ───────────────────────────────────────────────────────────
// API_PORT = backend API port (Hono server, what this file runs)
// WEB_PORT = user-facing UI port (Vite dev server), shown in banner
// HOST     = bind host for the UI (default localhost)
const apiPort = parseInt(process.env.API_PORT ?? "3001", 10);
const uiHost = process.env.HOST ?? "localhost";
const uiPort = parseInt(process.env.WEB_PORT ?? "3000", 10);
// If user bound to 0.0.0.0, display "localhost" in the banner (browsable URL)
const displayHost = uiHost === "0.0.0.0" || uiHost === "" ? "localhost" : uiHost;

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
console.log(line("📝", `Compact: >${(CHAT_COMPACTION_THRESHOLD_TOKENS / 1000).toFixed(0)}k tok → ${(CHAT_COMPACTION_WINDOW_TOKENS / 1000).toFixed(0)}k window`));
console.log(sep);

await wm.init();

console.log(sep);

// The API server always binds to loopback only — never exposed to the network
// directly. If user sets HOST=0.0.0.0 to expose the UI on the LAN, the
// Vite dev server still proxies /api/* to 127.0.0.1:apiPort internally.
serve({ fetch: app.fetch, port: apiPort, hostname: "127.0.0.1" }, () => {
  const ws = wm.currentWorkspace();
  console.log(line("📂", `${ws.name}: ${ws.title}`));
  console.log(line("🌐", `http://${displayHost}:${uiPort}`));
  console.log(line("🔌", `API: :${apiPort}`));
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
