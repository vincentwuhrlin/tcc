/**
 * chat — Interactive chat terminal powered by workspace context.
 *
 * Loads all tagged documents from the workspace and lets you ask questions.
 * Uses the same LLM config (API_PROVIDER/API_KEY/API_MODEL) as other commands.
 *
 * Usage:
 *   npm run chat
 *   npm run chat -- --workspace=../workspaces/industrial-edge
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { WORKSPACE, MEDIA_DIR, CONTEXT_DIR, OUTPUT_DIR, API_MODEL, API_PROVIDER } from "../config.js";
import { llmCall, printApiConfig } from "../common/llm.js";
import { scanMarkdownFiles, hasClassificationFrontmatter, stripFrontmatter } from "../common/media.js";
import { loadContextFile } from "../common/prompts.js";

export async function chat(): Promise<void> {
  console.log("🧠 media2kb — Interactive Chat");
  console.log(`📂 Workspace: ${WORKSPACE}`);
  printApiConfig();
  console.log();

  // Load domain context
  let domainContext = "";
  try {
    domainContext = loadContextFile("shared/domain.md");
    console.log(`✅ Domain context loaded`);
  } catch {
    console.log(`⚠️  No domain context found (context/shared/domain.md)`);
  }

  // Load INDEX.md if available
  let indexContent = "";
  const indexPath = join(OUTPUT_DIR, "INDEX.md");
  if (existsSync(indexPath)) {
    indexContent = readFileSync(indexPath, "utf-8");
    console.log(`✅ INDEX.md loaded (${Math.round(indexContent.length / 1000)}k chars)`);
  }

  // Load PLAN.md if available
  let planContent = "";
  const planPath = join(OUTPUT_DIR, "PLAN.md");
  if (existsSync(planPath)) {
    planContent = readFileSync(planPath, "utf-8");
    console.log(`✅ PLAN.md loaded`);
  }

  // Count available docs
  const allFiles = scanMarkdownFiles();
  const tagged = allFiles.filter((f) => hasClassificationFrontmatter(readFileSync(f.path, "utf-8")));
  console.log(`📚 ${tagged.length}/${allFiles.length} documents tagged`);

  // Build system prompt
  const systemPrompt = buildChatSystemPrompt(domainContext, planContent, indexContent);
  console.log(`📝 System prompt: ${Math.round(systemPrompt.length / 4)}k tokens`);
  console.log();
  console.log("━".repeat(60));
  console.log("Type your question (or 'quit' to exit, '/docs' to list docs)");
  console.log("━".repeat(60));
  console.log();

  // Chat loop
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: { role: "user" | "assistant"; content: string }[] = [];

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) { prompt(); return; }
      if (trimmed === "quit" || trimmed === "exit") { rl.close(); return; }

      if (trimmed === "/docs") {
        console.log(`\n📚 ${tagged.length} tagged documents:`);
        for (const f of tagged.slice(0, 20)) {
          const { body } = stripFrontmatter(readFileSync(f.path, "utf-8"));
          const firstLine = body.split("\n").find((l) => l.trim())?.slice(0, 80) ?? "";
          console.log(`   ${f.dir}/${f.name} — ${firstLine}`);
        }
        if (tagged.length > 20) console.log(`   ... and ${tagged.length - 20} more`);
        console.log();
        prompt();
        return;
      }

      if (trimmed.startsWith("/load ")) {
        const filename = trimmed.slice(6).trim();
        const found = allFiles.find((f) => f.name === filename || f.path.endsWith(filename));
        if (found) {
          const content = readFileSync(found.path, "utf-8");
          const { body } = stripFrontmatter(content);
          history.push({ role: "user", content: `Here is the content of ${found.name}:\n\n${body}` });
          console.log(`\n📄 Loaded ${found.name} (${Math.round(body.length / 4000)}k tokens) into context\n`);
        } else {
          console.log(`\n❌ File not found: ${filename}\n`);
        }
        prompt();
        return;
      }

      // Normal chat
      process.stdout.write("\n🤖 ");

      try {
        // For now, single-turn with system prompt (no history to stay within context)
        // TODO: implement conversation history with token budget management
        const response = await llmCall(systemPrompt, trimmed, 4096);
        console.log(response);
      } catch (err) {
        console.log(`❌ ${err instanceof Error ? err.message : err}`);
      }

      console.log();
      prompt();
    });
  };

  prompt();
}

function buildChatSystemPrompt(domain: string, plan: string, index: string): string {
  const parts: string[] = [
    "You are a knowledgeable assistant for a technical documentation knowledge base.",
    "Answer questions based on the domain context, plan, and document index provided below.",
    "Always cite sources when possible: [filename.md §section].",
    "If you don't have the information, say so clearly.",
    "Respond in the same language as the user's question.",
  ];

  if (domain) {
    parts.push("", "## Domain Context", "", domain);
  }

  if (plan) {
    parts.push("", "## Classification Plan (PLAN.md)", "", plan);
  }

  if (index) {
    // Truncate index if too large (keep first 50k chars)
    const maxIndexChars = 50_000;
    const truncated = index.length > maxIndexChars
      ? index.slice(0, maxIndexChars) + `\n\n[... INDEX.md truncated at ${Math.round(maxIndexChars / 4000)}k tokens ...]`
      : index;
    parts.push("", "## Document Index (INDEX.md)", "", truncated);
  }

  return parts.join("\n");
}
