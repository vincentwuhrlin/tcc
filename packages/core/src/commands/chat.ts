/**
 * chat — Interactive RAG-powered chat in the terminal.
 *
 * Pipeline per question:
 *   1. Embed the query via EmbedEngine.embedQuery()
 *   2. Search top-K chunks via cosine similarity
 *   3. Assemble context (instructions + domain + plan headers + RAG chunks + history)
 *   4. Call LLM with assembled system prompt
 *
 * System prompt layers:
 *   - instructions.md → chat behavior, audience, citation rules (context/chat/)
 *   - domain.md       → domain knowledge, vocabulary, team context (context/shared/)
 *   - PLAN.md         → category headers only (compact TOC)
 *   - RAG chunks      → relevant excerpts from vector search
 *   - history         → sliding window of recent exchanges
 *
 * Usage:
 *   pnpm tcc chat
 *   pnpm tcc chat --workspace=industrial-edge
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { WORKSPACE, OUTPUT_DIR, API_MODEL, API_PROVIDER, CHAT_EMBED_ENGINE, CHAT_TOP_K, CHAT_API_PROVIDER, CHAT_API_MODEL, printHeader } from "../config.js";
import { llmCall, getChatLlmConfig } from "../common/llm.js";
import { loadIndex, searchChunks, assembleContext, type SearchResult } from "../common/rag.js";
import { getChatEmbedEngine, type EmbedEngine } from "../common/embed/index.js";
import { scanMarkdownFiles, hasClassificationFrontmatter, stripFrontmatter } from "../common/media.js";

// ── Constants ───────────────────────────────────────────────────────

const SLIDING_WINDOW = 5;
const MAX_CHAT_CONTEXT_CHARS = 60_000;

const DEFAULT_INSTRUCTIONS = `You are a knowledgeable technical assistant for a documentation knowledge base.
Answer questions precisely, citing sources when possible using the format [filename.md §section].
If the provided context doesn't contain enough information, say so clearly.
Respond in the same language as the user's question.`;

// ── Types ───────────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant";
  content: string;
}

// ── PLAN.md headers extraction ──────────────────────────────────────

function extractPlanHeaders(raw: string): string {
  const headers: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (/^#{2,3}\s+[A-Z][\.\d]*/.test(trimmed)) {
      const depth = trimmed.startsWith("### ") ? "  " : "";
      const text = trimmed.replace(/^#{2,3}\s+/, "");
      headers.push(`${depth}${text}`);
    }
  }
  return headers.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────

export async function chat(): Promise<void> {
  printHeader();
  console.log("🧠 TCC — Interactive RAG Chat");
  console.log(`📂 Workspace: ${WORKSPACE}`);
  console.log();

  // ── Load instructions.md (chat behavior) ───────────────────────
  let instructions = "";
  const instructionsPath = join(WORKSPACE, "context", "chat", "instructions.md");
  if (existsSync(instructionsPath)) {
    instructions = readFileSync(instructionsPath, "utf-8");
    console.log(`✅ instructions.md loaded (${Math.round(instructions.length / 1000)}k chars)`);
  } else {
    console.log("⚠️  No instructions.md (context/chat/instructions.md) — using defaults");
  }

  // ── Load domain.md (domain knowledge) ──────────────────────────
  let domainContext = "";
  const domainPath = join(WORKSPACE, "context", "shared", "domain.md");
  if (existsSync(domainPath)) {
    domainContext = readFileSync(domainPath, "utf-8");
    console.log(`✅ domain.md loaded (${Math.round(domainContext.length / 1000)}k chars)`);
  } else {
    console.log("⚠️  No domain.md (context/shared/domain.md)");
  }

  // ── Load PLAN.md (headers only) ────────────────────────────────
  let planHeaders = "";
  const planPath = join(OUTPUT_DIR, "PLAN.md");
  if (existsSync(planPath)) {
    const raw = readFileSync(planPath, "utf-8");
    planHeaders = extractPlanHeaders(raw);
    const catCount = planHeaders.split("\n").filter((l) => !l.startsWith("  ")).length;
    console.log(`✅ PLAN.md → ${catCount} categories (headers only)`);
  }

  // ── Load RAG index ─────────────────────────────────────────────
  let engine: EmbedEngine | null = null;
  let ragChunks = 0;

  try {
    engine = await getChatEmbedEngine();
    const info = engine.info();
    ragChunks = loadIndex(info.model);
    console.log(`✅ RAG index: ${ragChunks} chunks (${info.engine}, ${info.model}, ${info.dimensions}d)`);
  } catch (err) {
    console.log(`⚠️  RAG init failed: ${err instanceof Error ? err.message : err}`);
    console.log("   Chat will work without vector search.");
  }

  // ── Count docs ─────────────────────────────────────────────────
  const allFiles = scanMarkdownFiles();
  const tagged = allFiles.filter((f) => hasClassificationFrontmatter(readFileSync(f.path, "utf-8")));
  console.log(`📚 ${tagged.length}/${allFiles.length} documents tagged`);

  console.log();
  console.log("━".repeat(60));
  console.log(`  LLM:    ${CHAT_API_PROVIDER} / ${CHAT_API_MODEL}`);
  console.log(`  Embed:  ${CHAT_EMBED_ENGINE} (${ragChunks} chunks, top-${CHAT_TOP_K})`);
  console.log(`  Prompt: ${instructions ? "instructions.md" : "defaults"} + ${domainContext ? "domain.md" : "—"} + ${planHeaders ? "PLAN headers" : "—"}`);
  console.log(`  Window: last ${SLIDING_WINDOW} exchanges`);
  console.log("━".repeat(60));
  console.log();
  console.log("Commands:  /docs  /load <file>  /clear  /stats  quit");
  console.log();

  // ── Chat loop ──────────────────────────────────────────────────
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: Message[] = [];

  const doPrompt = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) { doPrompt(); return; }
      if (trimmed === "quit" || trimmed === "exit") { rl.close(); return; }

      // ── Slash commands ──────────────────────────────────────
      if (trimmed === "/docs") {
        console.log(`\n📚 ${tagged.length} tagged documents:`);
        for (const f of tagged.slice(0, 25)) {
          const { body } = stripFrontmatter(readFileSync(f.path, "utf-8"));
          const firstLine = body.split("\n").find((l) => l.trim())?.slice(0, 80) ?? "";
          console.log(`   ${f.dir}/${f.name} — ${firstLine}`);
        }
        if (tagged.length > 25) console.log(`   ... and ${tagged.length - 25} more`);
        console.log();
        doPrompt();
        return;
      }

      if (trimmed.startsWith("/load ")) {
        const filename = trimmed.slice(6).trim();
        const found = allFiles.find((f) => f.name === filename || f.path.endsWith(filename));
        if (found) {
          const content = readFileSync(found.path, "utf-8");
          const { body } = stripFrontmatter(content);
          history.push({ role: "user", content: `Here is the content of ${found.name}:\n\n${body}` });
          console.log(`\n📄 Loaded ${found.name} (${Math.round(body.length / 4000)}k tokens) into history\n`);
        } else {
          console.log(`\n❌ File not found: ${filename}\n`);
        }
        doPrompt();
        return;
      }

      if (trimmed === "/clear") {
        history.length = 0;
        console.log("\n🗑️  Conversation history cleared\n");
        doPrompt();
        return;
      }

      if (trimmed === "/stats") {
        console.log(`\n📊 History: ${history.length} messages (${Math.floor(history.length / 2)} exchanges)`);
        console.log(`   RAG: ${ragChunks} chunks indexed`);
        console.log(`   Window: last ${SLIDING_WINDOW} exchanges sent to LLM\n`);
        doPrompt();
        return;
      }

      // ── RAG search ─────────────────────────────────────────
      let ragContext = "";
      let sources: SearchResult[] = [];

      if (engine && ragChunks > 0) {
        try {
          const t0 = Date.now();
          const queryVector = await engine.embedQuery(trimmed);
          const embedMs = Date.now() - t0;

          const t1 = Date.now();
          sources = searchChunks(queryVector, CHAT_TOP_K);
          const searchMs = Date.now() - t1;

          ragContext = assembleContext(sources, MAX_CHAT_CONTEXT_CHARS);

          const topScore = sources.length > 0 ? (sources[0].score * 100).toFixed(0) : "—";
          process.stdout.write(
            `   🔍 ${sources.length} chunks (top: ${topScore}%) — embed ${embedMs}ms, search ${searchMs}ms\n`,
          );
        } catch (err) {
          console.log(`   ⚠️  RAG error: ${err instanceof Error ? err.message : err}`);
        }
      }

      // ── Build system prompt ────────────────────────────────
      const systemPrompt = buildSystemPrompt(instructions, domainContext, planHeaders, ragContext, history);

      // ── LLM call ───────────────────────────────────────────
      process.stdout.write("\n🤖 ");

      try {
        const t0 = Date.now();
        const response = await llmCall(systemPrompt, trimmed, 4096, getChatLlmConfig());
        const llmMs = Date.now() - t0;

        console.log(response);

        // Show sources
        if (sources.length > 0) {
          const uniqueSources = new Map<string, number>();
          for (const s of sources) {
            if (!uniqueSources.has(s.source)) uniqueSources.set(s.source, s.score);
          }
          const srcList = [...uniqueSources.entries()]
            .slice(0, 5)
            .map(([name, score]) => `${name} (${(score * 100).toFixed(0)}%)`)
            .join(", ");
          console.log(`\n   📎 Sources: ${srcList}`);
        }
        console.log(`   ⏱️  LLM: ${llmMs}ms`);

        // Save to history
        history.push({ role: "user", content: trimmed });
        history.push({ role: "assistant", content: response });
      } catch (err) {
        console.log(`❌ ${err instanceof Error ? err.message : err}`);
      }

      console.log();
      doPrompt();
    });
  };

  doPrompt();
}

// ── System prompt builder ───────────────────────────────────────────

function buildSystemPrompt(
  instructions: string,
  domain: string,
  planHeaders: string,
  ragContext: string,
  history: Message[],
): string {
  const parts: string[] = [];

  // 1. Instructions — chat behavior, audience, citation rules
  parts.push(instructions || DEFAULT_INSTRUCTIONS);

  // 2. Domain context — vocabulary, components, team context
  if (domain) {
    parts.push("", "## Domain Context", "", domain);
  }

  // 3. Plan categories — compact table of contents
  if (planHeaders) {
    parts.push("", "## Knowledge Base Categories", "", planHeaders);
  }

  // 4. RAG chunks — relevant excerpts from vector search
  if (ragContext) {
    parts.push("", "## Relevant Excerpts (from vector search)", "", ragContext);
  }

  // 5. Sliding window of recent conversation
  if (history.length > 0) {
    const windowSize = SLIDING_WINDOW * 2;
    const recent = history.slice(-windowSize);
    parts.push("", "## Recent Conversation");
    for (const msg of recent) {
      parts.push("", `**${msg.role === "user" ? "User" : "Assistant"}:** ${msg.content}`);
    }
  }

  return parts.join("\n");
}
