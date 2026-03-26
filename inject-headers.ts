#!/usr/bin/env node
// Inject source headers into existing document .md files that don't have one yet
// Usage: npx tsx inject-headers.ts

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";

const OUTPUT_DIR = process.env.RUNPOD_OUTPUT
  ?? join(process.env.RUNPOD_MEDIA_DIR ?? "../media", "output");
const PDF_INPUT_DIR = process.env.RUNPOD_PDF_INPUT
  ?? join(process.env.RUNPOD_MEDIA_DIR ?? "../media", "pdfs");

function countPdfPages(pdfPath: string): number {
  try {
    const buf = readFileSync(pdfPath);
    const content = buf.toString("latin1");
    const matches = content.match(/\/Type\s*\/Page(?!s)/g);
    if (matches && matches.length > 0) return matches.length;
    const countMatch = content.match(/\/Pages[\s\S]{0,200}\/Count\s+(\d+)/);
    if (countMatch) return parseInt(countMatch[1], 10);
    return 0;
  } catch {
    return 0;
  }
}

function findPdfs(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(dir)) return map;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of findPdfs(full)) map.set(k, v);
    } else if (entry.name.toLowerCase().endsWith(".pdf")) {
      const mdName = entry.name.replace(/\.pdf$/i, ".md");
      map.set(mdName, full);
    }
  }
  return map;
}

// Load .env
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const docsDir = join(OUTPUT_DIR, "documents");
if (!existsSync(docsDir)) {
  console.log("⚠️  No documents directory found");
  process.exit(0);
}

const pdfMap = findPdfs(PDF_INPUT_DIR);
const mdFiles = readdirSync(docsDir).filter((f) => f.endsWith(".md"));

let injected = 0;
let skipped = 0;

for (const f of mdFiles) {
  const mdPath = join(docsDir, f);
  const content = readFileSync(mdPath, "utf-8");

  // Skip if already has header
  if (content.startsWith("> Source:") || content.startsWith("---\n")) {
    skipped++;
    continue;
  }

  // Find matching PDF
  const pdfPath = pdfMap.get(f);
  if (!pdfPath) {
    console.log(`   ⚠️  No PDF found for ${f}`);
    continue;
  }

  const pdfSize = statSync(pdfPath).size;
  const sizeMB = (pdfSize / (1024 * 1024)).toFixed(1);
  const pages = countPdfPages(pdfPath);

  const header = [
    `> Source: ${pdfPath}`,
    pages > 0 ? `> Pages: ${pages}` : null,
    `> Size: ${sizeMB} MB`,
  ].filter(Boolean).join("\n");

  writeFileSync(mdPath, header + "\n\n" + content);
  console.log(`   ✅ ${f} (${pages} pages, ${sizeMB} MB)`);
  injected++;
}

console.log();
console.log(`✅ Injected: ${injected} | Skipped: ${skipped} (already have header)`);
