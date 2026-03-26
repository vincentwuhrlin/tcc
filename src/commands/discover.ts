import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR, MEDIA_API_MODE, CONTEXT_DIR } from "../config.js";
import { buildDiscoverPrompt, fillUserMessage, loadPhaseLabels, loadContextFile, interpolate, loadDomain } from "../common/prompts.js";
import { llmCall, llmBatchCall, printApiConfig, type BatchRequest } from "../common/llm.js";
import {
  scanMarkdownFiles, stripFrontmatter, prepareContent, parseJsonResponse,
  sanitizeCustomId, idToPath, type TagResult,
} from "../common/media.js";

export async function discover(): Promise<void> {
  const { system, userTemplate } = buildDiscoverPrompt();
  const allFiles = scanMarkdownFiles();
  if (allFiles.length === 0) { console.log("⚠️  No .md files found"); return; }

  console.log(`📚 Found ${allFiles.length} file(s) for discovery`);
  printApiConfig();
  console.log();

  // Prepare all files
  const prepared = allFiles.map((f) => {
    const label = `${f.dir}/${f.name}`;
    const cid = sanitizeCustomId(label);
    idToPath.set(cid, { dir: f.dir, name: f.name });
    const { body } = stripFrontmatter(readFileSync(f.path, "utf-8"));
    const content = prepareContent(body);
    const userMessage = fillUserMessage(userTemplate, content);
    return { file: f, label, cid, userMessage };
  });

  const results = new Map<string, TagResult>();
  let errors = 0;

  if (MEDIA_API_MODE === "batch") {
    // ── Batch mode: submit all, poll, collect ──
    const batchRequests: BatchRequest[] = prepared.map((p) => ({
      customId: p.cid,
      systemPrompt: system,
      userMessage: p.userMessage,
      maxTokens: 1024,
    }));

    const batchResults = await llmBatchCall(batchRequests);

    for (const r of batchResults) {
      const parsed = parseJsonResponse(r.text);
      if (parsed) {
        results.set(r.customId, parsed);
      } else { errors++; }
    }
    errors += prepared.length - batchResults.length;

  } else {
    // ── Streaming mode: one call per file ──
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      process.stdout.write(`   [${i + 1}/${prepared.length}] ${p.label}...`);

      try {
        const response = await llmCall(system, p.userMessage, 1024);
        const parsed = parseJsonResponse(response);
        if (parsed) {
          results.set(p.cid, parsed);
          const icon = parsed.quality === "high" ? "🟢" : parsed.quality === "medium" ? "🟡" : "🔴";
          console.log(` ${icon} ${parsed.title?.slice(0, 60) ?? "?"}`);
        } else { console.log(` ⚠️  invalid JSON`); errors++; }
      } catch (err) { console.log(` ❌ ${err instanceof Error ? err.message.slice(0, 80) : err}`); errors++; }
    }
  }

  console.log();
  console.log(`✅ Discovered: ${results.size} | Errors: ${errors}`);
  writeDiscovery(results);
}

function writeDiscovery(results: Map<string, TagResult>): void {
  const phaseLabels = loadPhaseLabels();
  const categoryCount = new Map<string, number>();
  const topicCount = new Map<string, number>();
  const tagCount = new Map<string, number>();
  const componentCount = new Map<string, number>();
  const phaseCount = new Map<number, number>();

  const lines: string[] = ["# Discovery Report", "", `> Auto-generated on ${new Date().toISOString()}`, `> ${results.size} documents analyzed`, "", "## Per Document", ""];

  for (const [customId, meta] of results) {
    const icon = meta.quality === "high" ? "🟢" : meta.quality === "medium" ? "🟡" : "🔴";
    const pathInfo = idToPath.get(customId);
    const label = pathInfo ? `${pathInfo.dir}/${pathInfo.name}` : customId;
    lines.push(`### ${icon} ${(meta as any).title ?? label}`, `\`${label}\``, "", `**Summary:** ${(meta as any).summary ?? "—"}`, "");

    const components: string[] = (meta as any).components ?? [];
    const phases: number[] = (meta as any).project_phases ?? [];
    if (components.length > 0 || phases.length > 0) {
      const compStr = components.length > 0 ? `Components: ${components.join(", ")}` : "";
      const phaseStr = phases.length > 0 ? `Phases: ${phases.map((p) => `${p} (${phaseLabels[p] ?? "?"})`).join(", ")}` : "";
      lines.push(`**${[compStr, phaseStr].filter(Boolean).join(" · ")}**`);
    }
    const topics: string[] = (meta as any).topics ?? [];
    if (topics.length > 0) lines.push(`**Topics:** ${topics.join(", ")}`);
    const tags: string[] = (meta as any).tags ?? [];
    if (tags.length > 0) lines.push(`**Tags:** ${tags.map((t) => `\`${t}\``).join(" ")}`);
    const sugCat: string = (meta as any).suggested_category ?? "";
    if (sugCat) lines.push(`**Suggested category:** ${sugCat}`);
    const keyFacts: string[] = (meta as any).key_facts ?? [];
    if (keyFacts.length > 0) lines.push(`**Key facts:** ${keyFacts.join(" · ")}`);
    lines.push("");

    if (sugCat) categoryCount.set(sugCat, (categoryCount.get(sugCat) ?? 0) + 1);
    for (const t of topics) topicCount.set(t, (topicCount.get(t) ?? 0) + 1);
    for (const t of tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    for (const c of components) componentCount.set(c, (componentCount.get(c) ?? 0) + 1);
    for (const p of phases) phaseCount.set(p, (phaseCount.get(p) ?? 0) + 1);
  }

  lines.push("---", "", "## Component Coverage", "");
  for (const [comp, count] of [...componentCount.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- **${comp}**: ${count} docs (${Math.round((count / results.size) * 100)}%)`);
  }
  lines.push("", "## Project Phase Coverage", "");
  for (let phase = 1; phase < phaseLabels.length; phase++) {
    const count = phaseCount.get(phase) ?? 0;
    const pct = Math.round((count / results.size) * 100);
    const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
    lines.push(`- **Phase ${phase} (${phaseLabels[phase]})**: ${bar} ${count} docs (${pct}%)`);
  }
  lines.push("", "## Suggested Categories (for PLAN.md)", "");
  for (const [cat, count] of [...categoryCount.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- **${cat}** (${count} doc${count > 1 ? "s" : ""})`);
  }
  lines.push("", "## Top Topics", "");
  for (const [topic, count] of [...topicCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    lines.push(`- ${topic} (${count})`);
  }
  lines.push("", "## Tag Cloud", "");
  lines.push([...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t, c]) => `\`${t}\`×${c}`).join("  "));
  lines.push("");

  const discoveryPath = join(OUTPUT_DIR, "DISCOVERY.md");
  writeFileSync(discoveryPath, lines.join("\n"));
  console.log(`📋 Discovery report: ${discoveryPath}`);
  console.log();

  // Print refine helper prompt
  printRefinePrompt(discoveryPath);

  console.log("Next steps:");
  console.log("   1. (Optional) Refine: copy the prompt above into Claude + DISCOVERY.md");
  console.log("      Save the result → context/discover/prompt.md, then re-run discover");
  console.log("   2. npm run media:synthesize → SUMMARY.md + PLAN.md");
  console.log("   3. Tweak PLAN.md if needed");
  console.log("   4. npm run media:classify → classify with your plan");
}

function printRefinePrompt(discoveryPath: string): void {
  let template: string;
  try {
    template = loadContextFile("discover/refine-prompt.md");
  } catch {
    // No refine template — skip silently
    return;
  }

  const domain = loadDomain();
  const currentPrompt = loadContextFile("discover/prompt.md");
  const prompt = interpolate(template, {
    DOMAIN: domain,
    CURRENT_PROMPT: currentPrompt,
  });

  const discoverySize = readFileSync(discoveryPath, "utf-8").length;

  console.log("═".repeat(70));
  console.log("💡 Want to improve your prompts for a second pass?");
  console.log("   Copy the prompt below into Claude, then add your DISCOVERY.md.");
  console.log("═".repeat(70));
  console.log();
  console.log("── COPY FROM HERE ──────────────────────────────────────────────");
  console.log();
  console.log(prompt);
  console.log();
  console.log("── COPY TO HERE ────────────────────────────────────────────────");
  console.log();
  console.log(`Then paste the content of DISCOVERY.md (${Math.round(discoverySize / 1000)}k chars):`);
  console.log(`   ${discoveryPath}`);
  console.log();
  console.log(`Save Claude's output as: ${join(CONTEXT_DIR, "discover/prompt.md")}`);
  console.log("Then align classify + synthesize prompts (see README Step 7c).");
  console.log();
}
