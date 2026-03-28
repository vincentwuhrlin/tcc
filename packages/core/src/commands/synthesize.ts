/**
 * Synthesize — Read all source frontmatters, produce PLAN.md + SUMMARY.md.
 *
 * Reads frontmatters directly from source files (not DISCOVERY.md).
 * Two separate LLM calls with external prompts:
 *   - context/synthesize/prompt-plan.md    → PLAN.md
 *   - context/synthesize/prompt-summary.md → SUMMARY.md
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR, PLAN_FILE, CONTEXT_DIR, MEDIA_SYNTHESIZE_MAX_TOKENS, printHeader } from "../config.js";
import { loadDomain } from "../common/prompts.js";
import { llmCall } from "../common/llm.js";
import { scanMarkdownFiles } from "../common/media.js";

// ── Frontmatter parser (lightweight YAML) ────────────────────────────

function parseFrontmatter(content: string): Record<string, any> | null {
  if (!content.startsWith("---\n")) return null;
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return null;

  const fmText = content.slice(4, endIdx);
  const result: Record<string, any> = {};

  let currentKey: string | null = null;
  let currentList: (string | number)[] | null = null;

  for (const line of fmText.split("\n")) {
    const listItem = line.match(/^\s+-\s+(.+)/);
    if (listItem && currentKey) {
      if (!currentList) currentList = [];
      let val: string | number = listItem[1].replace(/^"(.*)"$/, "$1");
      if (/^\d+$/.test(val as string)) val = parseInt(val as string, 10);
      currentList.push(val);
      continue;
    }

    if (currentKey && currentList) {
      result[currentKey] = currentList;
      currentList = null;
      currentKey = null;
    }

    const kv = line.match(/^(\w[\w_]*?):\s*(.*)/);
    if (kv) {
      const key = kv[1];
      let value = kv[2].replace(/^"(.*)"$/, "$1").trim();
      if (value === "" || value === "[]") {
        currentKey = key;
        currentList = [];
      } else {
        result[key] = value;
        currentKey = null;
      }
    }
  }

  if (currentKey && currentList) {
    result[currentKey] = currentList;
  }

  return result;
}

// ── Build input from frontmatters ─────────────────────────────────────

function buildSynthesizeInput(files: ReturnType<typeof scanMarkdownFiles>): string {
  const docs: string[] = [];
  const videos: string[] = [];

  const skipFields = new Set([
    "discovered_at", "source_origin", "source_pages", "source_duration",
    "source_language", "source_type",
  ]);

  for (const f of files) {
    const content = readFileSync(f.path, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm) continue;

    const lines: string[] = [];
    const title = fm.title ?? f.name;
    const quality = fm.quality ?? "?";
    const sourceType = fm.source_type ?? "?";

    lines.push(`### ${title}`);
    lines.push(`\`${f.name}\` | ${sourceType} | quality: ${quality}`);

    for (const [key, value] of Object.entries(fm)) {
      if (skipFields.has(key) || key === "title" || key === "quality") continue;

      if (Array.isArray(value) && value.length > 0) {
        const displayKey = key.replace(/_/g, " ");
        if (key === "tags") {
          lines.push(`${displayKey}: ${value.join(", ")}`);
        } else if (key === "key_facts") {
          lines.push(`${displayKey}: ${value.slice(0, 3).join(" | ")}`);
        } else {
          lines.push(`${displayKey}: ${value.join(", ")}`);
        }
      } else if (typeof value === "string" && value) {
        const displayKey = key.replace(/_/g, " ");
        lines.push(`${displayKey}: ${value}`);
      }
    }

    lines.push("");

    if (f.dir.startsWith("video")) {
      videos.push(lines.join("\n"));
    } else {
      docs.push(lines.join("\n"));
    }
  }

  const sections: string[] = [];

  if (docs.length > 0) {
    sections.push(`## Documents (${docs.length} files)\n\n${docs.join("\n")}`);
  }
  if (videos.length > 0) {
    sections.push(`## Videos (${videos.length} files)\n\n${videos.join("\n")}`);
  }

  return sections.join("\n\n");
}

// ── Prompt loading ───────────────────────────────────────────────────

function loadSynthesizePrompt(filename: string): { system: string; userTemplate: string } {
  const path = join(CONTEXT_DIR, "synthesize", filename);
  if (!existsSync(path)) {
    console.error(`❌ Prompt not found: ${path}`);
    process.exit(1);
  }

  const raw = readFileSync(path, "utf-8");
  const domain = loadDomain();
  const interpolated = raw.replace(/\{\{DOMAIN\}\}/g, domain);

  const separator = "---USER---";
  const idx = interpolated.indexOf(separator);

  if (idx === -1) {
    return { system: interpolated.trim(), userTemplate: "{{CONTENT}}" };
  }

  return {
    system: interpolated.slice(0, idx).trim(),
    userTemplate: interpolated.slice(idx + separator.length).trim(),
  };
}

// ── Progress indicator ────────────────────────────────────────────────

function startProgress(): NodeJS.Timeout {
  const start = Date.now();
  return setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r   ⏳ ${elapsed}s elapsed...`);
  }, 2000);
}

function stopProgress(timer: NodeJS.Timeout): void {
  clearInterval(timer);
  process.stdout.write("\r" + " ".repeat(40) + "\r");
}

// ── Main ──────────────────────────────────────────────────────────────

export async function synthesize(): Promise<void> {
  printHeader();

  const allFiles = scanMarkdownFiles();
  const discovered = allFiles.filter((f) => {
    const content = readFileSync(f.path, "utf-8");
    return content.startsWith("---\n") && content.includes("discovered_at:");
  });

  if (discovered.length === 0) {
    console.error("❌ No discovered files found. Run: npm run media:discover");
    process.exit(1);
  }

  console.log(`📚 ${discovered.length} discovered sources (${allFiles.length} total)`);

  const input = buildSynthesizeInput(discovered);
  const inputTokens = Math.round(input.length / 4000);

  console.log(`📄 Synthesize input: ${(input.length / 1000).toFixed(0)}k chars (~${inputTokens}k tokens)`);
  console.log();

  // ── Call 1: PLAN.md ─────────────────────────────────────────────────
  console.log(`🧠 [1/2] Generating PLAN.md...`);

  const planPrompt = loadSynthesizePrompt("prompt-plan.md");
  const planUser = planPrompt.userTemplate.replace("{{CONTENT}}", input);
  const timer1 = startProgress();
  const planResponse = await llmCall(planPrompt.system, planUser, MEDIA_SYNTHESIZE_MAX_TOKENS);
  stopProgress(timer1);

  writeFileSync(PLAN_FILE, planResponse.trim());
  console.log(`   📋 PLAN.md → ${PLAN_FILE}`);

  // ── Call 2: SUMMARY.md ──────────────────────────────────────────────
  console.log(`🧠 [2/2] Generating SUMMARY.md...`);

  const summaryPrompt = loadSynthesizePrompt("prompt-summary.md");
  const summaryUser = summaryPrompt.userTemplate.replace("{{CONTENT}}", input);
  const timer2 = startProgress();
  const summaryResponse = await llmCall(summaryPrompt.system, summaryUser, MEDIA_SYNTHESIZE_MAX_TOKENS);
  stopProgress(timer2);

  writeFileSync(join(OUTPUT_DIR, "SUMMARY.md"), summaryResponse.trim());
  console.log(`   📋 SUMMARY.md`);

  console.log();
  console.log("Next: review PLAN.md, then npm run media:classify");
}
