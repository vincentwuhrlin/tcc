#!/usr/bin/env node
// Extract all > Context: lines from split files for validation
// Usage: npx tsx check-contexts.ts

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const OUTPUT_DIR = process.env.RUNPOD_OUTPUT
  ?? join(process.env.RUNPOD_MEDIA_DIR ?? "../media", "output");

// Load .env
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const splitsDir = join(OUTPUT_DIR, "documents", "splits");
if (!existsSync(splitsDir)) {
  console.log("⚠️  No splits directory found");
  process.exit(0);
}

const files = readdirSync(splitsDir).filter((f) => f.endsWith(".md")).sort();
let lastParent = "";

for (const f of files) {
  const content = readFileSync(join(splitsDir, f), "utf-8");

  // Extract parent_document
  const parentMatch = content.match(/parent_document:\s*"([^"]+)"/);
  const parent = parentMatch?.[1] ?? "unknown";

  // Extract context
  const ctxMatch = content.match(/^> Context:\s*(.+)$/m);
  const context = ctxMatch?.[1] ?? "❌ NO CONTEXT";

  // Group by parent
  if (parent !== lastParent) {
    console.log();
    console.log(`📂 ${parent}`);
    lastParent = parent;
  }

  console.log(`   ${context}`);
}

console.log();
console.log(`✅ ${files.length} split files checked`);
