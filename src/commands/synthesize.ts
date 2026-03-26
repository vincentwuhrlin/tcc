import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { OUTPUT_DIR, PLAN_FILE } from "../config.js";
import { buildSynthesizePrompt, fillUserMessage } from "../common/prompts.js";
import { llmCall, printApiConfig } from "../common/llm.js";

export async function synthesize(): Promise<void> {
  const discoveryPath = join(OUTPUT_DIR, "DISCOVERY.md");
  if (!existsSync(discoveryPath)) {
    console.error("❌ DISCOVERY.md not found. Run: npm run media:discover");
    process.exit(1);
  }

  const discovery = readFileSync(discoveryPath, "utf-8");
  const { system, userTemplate } = buildSynthesizePrompt();
  const userMessage = fillUserMessage(userTemplate, discovery);

  console.log(`📄 DISCOVERY.md: ${(discovery.length / 1000).toFixed(0)}k chars (~${Math.round(discovery.length / 4000)}k tokens)`);
  console.log(`🧠 Synthesizing (single API call)...`);
  printApiConfig();
  console.log();

  const response = await llmCall(system, userMessage, 64000);

  const splitMarker = "===SPLIT===";
  const splitIdx = response.indexOf(splitMarker);
  if (splitIdx === -1) {
    console.log("⚠️  Could not split response — writing as SUMMARY.md only");
    writeFileSync(join(OUTPUT_DIR, "SUMMARY.md"), response);
    return;
  }

  writeFileSync(join(OUTPUT_DIR, "SUMMARY.md"), response.slice(0, splitIdx).trim());
  console.log(`   📋 SUMMARY.md`);
  writeFileSync(PLAN_FILE, response.slice(splitIdx + splitMarker.length).trim());
  console.log(`   📋 PLAN.md → ${PLAN_FILE}`);
  console.log();
  console.log("Next: review PLAN.md, then npm run media:classify");
}
