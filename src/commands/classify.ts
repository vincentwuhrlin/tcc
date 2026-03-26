import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR, PLAN_FILE, MEDIA_API_MODE } from "../config.js";
import { buildClassifyPrompt, fillUserMessage } from "../common/prompts.js";
import { llmCall, llmBatchCall, printApiConfig, type BatchRequest } from "../common/llm.js";
import {
  scanMarkdownFiles, hasClassificationFrontmatter, stripFrontmatter,
  prepareContent, parseJsonResponse, buildFrontmatter, generateIndex, loadPlan,
  sanitizeCustomId,
} from "../common/media.js";

export async function classify(): Promise<void> {
  const plan = loadPlan();
  const { system, userTemplate } = buildClassifyPrompt(plan);
  const allFiles = scanMarkdownFiles();
  if (allFiles.length === 0) { console.log("⚠️  No .md files found"); return; }

  const toTag = allFiles.filter((f) => !hasClassificationFrontmatter(readFileSync(f.path, "utf-8")));
  const skipped = allFiles.length - toTag.length;
  console.log(`📚 ${allFiles.length} files, ${skipped} tagged, ${toTag.length} to process`);
  if (toTag.length === 0) { console.log("✅ All files already tagged!"); return; }
  printApiConfig();
  console.log(`📋 Plan: ${PLAN_FILE}`);
  console.log();

  // Prepare all files
  const prepared = toTag.map((f) => {
    const raw = readFileSync(f.path, "utf-8");
    const { body, existingFm } = stripFrontmatter(raw);
    const content = prepareContent(body);
    const userMessage = fillUserMessage(userTemplate, content);
    const cid = sanitizeCustomId(`${f.dir}/${f.name}`);
    return { file: f, cid, body, existingFm, userMessage };
  });

  let applied = 0, errors = 0;

  if (MEDIA_API_MODE === "batch") {
    // ── Batch mode ──
    const batchRequests: BatchRequest[] = prepared.map((p) => ({
      customId: p.cid,
      systemPrompt: system,
      userMessage: p.userMessage,
      maxTokens: 1024,
    }));

    const batchResults = await llmBatchCall(batchRequests);
    const resultMap = new Map(batchResults.map((r) => [r.customId, r.text]));

    for (const p of prepared) {
      const responseText = resultMap.get(p.cid);
      if (!responseText) { errors++; continue; }

      const meta = parseJsonResponse(responseText);
      if (meta) {
        writeFileSync(p.file.path, buildFrontmatter(meta, p.file.name, p.file.dir, p.existingFm) + p.body);
        const icon = meta.quality === "high" ? "🟢" : meta.quality === "medium" ? "🟡" : "🔴";
        console.log(`   ${icon} [${meta.categories?.join(", ") ?? "?"}] ${meta.title?.slice(0, 50) ?? "?"}`);
        applied++;
      } else { errors++; }
    }

  } else {
    // ── Streaming mode ──
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      process.stdout.write(`   [${i + 1}/${prepared.length}] ${p.file.dir}/${p.file.name}...`);

      try {
        const response = await llmCall(system, p.userMessage, 1024);
        const meta = parseJsonResponse(response);
        if (meta) {
          writeFileSync(p.file.path, buildFrontmatter(meta, p.file.name, p.file.dir, p.existingFm) + p.body);
          const icon = meta.quality === "high" ? "🟢" : meta.quality === "medium" ? "🟡" : "🔴";
          console.log(` ${icon} [${meta.categories?.join(", ") ?? "?"}] ${meta.title?.slice(0, 50) ?? "?"}`);
          applied++;
        } else { console.log(` ⚠️  invalid JSON`); errors++; }
      } catch (err) { console.log(` ❌ ${err instanceof Error ? err.message.slice(0, 80) : err}`); errors++; }
    }
  }

  console.log();
  console.log(`✅ Classified: ${applied} | Skipped: ${skipped} | Errors: ${errors}`);
  console.log("📋 Generating INDEX.md...");
  const index = generateIndex(scanMarkdownFiles());
  const indexPath = join(OUTPUT_DIR, "INDEX.md");
  writeFileSync(indexPath, index);
  console.log(`   ${indexPath}`);
}
