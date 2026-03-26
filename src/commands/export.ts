import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, rmSync, statSync } from "fs";
import { join, basename, resolve } from "path";
import { OUTPUT_DIR, MEDIA_DIR, BUNDLES_DIR, BUNDLES_FILE, BUNDLE_MIN_QUALITY, BUNDLE_MAX_TOKENS, PLAN_FILE } from "../config.js";
import { loadContextFile } from "../common/prompts.js";

// ── Config ────────────────────────────────────────────────────────────

const MIN_QUALITY = BUNDLE_MIN_QUALITY;
const MAX_TOKENS = BUNDLE_MAX_TOKENS;
const DRY_RUN = process.argv.includes("--dry-run");

const QUALITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

// ── Types ─────────────────────────────────────────────────────────────

interface ProjectDef {
  id: string;
  name: string;
  categories: string[];          // glob patterns like "C.*", "D.*"
  instructions: string;
  min_quality?: string;          // override global MIN_QUALITY
  hub?: boolean;                 // if true, gets PLAN.md, SUMMARY.md, ROUTING.md in data/
}

interface FileMeta {
  path: string;
  filename: string;
  dir: string;                   // "documents", "splits", "videos"
  title: string;
  categories: string[];
  quality: string;
  language: string;
  building_blocks: string[];
  ne_references: string[];
  standards: string[];
  source_type: string;
  summary: string;
  tags: string[];
  chars: number;
  tokens: number;
}

// ── YAML frontmatter parser (minimal, no deps) ───────────────────────

function parseFrontmatter(content: string): Record<string, any> {
  if (!content.startsWith("---\n")) return {};
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) return {};

  const yaml = content.slice(4, endIdx);
  const result: Record<string, any> = {};
  let currentKey = "";
  let currentList: string[] | null = null;

  for (const line of yaml.split("\n")) {
    // List item
    if (/^\s+-\s+/.test(line)) {
      let val = line.replace(/^\s+-\s+/, "").trim();
      val = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      if (currentList) currentList.push(val);
      continue;
    }

    // Key-value
    const kvMatch = line.match(/^(\w+):\s*(.*)/);
    if (kvMatch) {
      // Save previous list
      if (currentList && currentKey) {
        result[currentKey] = currentList;
      }

      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();

      if (val === "" || val === "[]") {
        // Start a list or empty value
        currentList = [];
      } else {
        currentList = null;
        result[currentKey] = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      }
    }
  }

  // Save last list
  if (currentList && currentKey) {
    result[currentKey] = currentList;
  }

  return result;
}

// ── Scan and parse ────────────────────────────────────────────────────

function scanTaggedFiles(): FileMeta[] {
  const dirs = [
    { path: join(OUTPUT_DIR, "documents"), label: "documents" },
    { path: join(OUTPUT_DIR, "documents", "splits"), label: "splits" },
    { path: join(OUTPUT_DIR, "videos"), label: "videos" },
  ];

  const files: FileMeta[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir.path)) continue;
    for (const f of readdirSync(dir.path)) {
      if (!f.endsWith(".md")) continue;
      const fullPath = join(dir.path, f);

      // Only process files with frontmatter (tagged)
      const content = readFileSync(fullPath, "utf-8");
      if (!content.startsWith("---\n")) continue;

      const fm = parseFrontmatter(content);
      if (!fm.categories || !fm.quality) continue;

      const chars = content.length;
      files.push({
        path: fullPath,
        filename: f,
        dir: dir.label,
        title: fm.title ?? f.replace(/\.md$/, ""),
        categories: Array.isArray(fm.categories) ? fm.categories : [fm.categories],
        quality: fm.quality ?? "medium",
        language: fm.language ?? "en",
        building_blocks: Array.isArray(fm.building_blocks) ? fm.building_blocks : [],
        ne_references: Array.isArray(fm.ne_references) ? fm.ne_references : [],
        standards: Array.isArray(fm.standards) ? fm.standards : [],
        source_type: fm.source_type ?? "unknown",
        summary: fm.summary ?? "",
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        chars,
        tokens: Math.round(chars / 4),
      });
    }
  }

  return files;
}

// ── Category matching ─────────────────────────────────────────────────

function matchesCategory(fileCategories: string[], patterns: string[]): boolean {
  for (const pattern of patterns) {
    const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
    for (const cat of fileCategories) {
      if (regex.test(cat)) return true;
    }
  }
  return false;
}

// ── Generate PROJECT_INSTRUCTIONS.md ──────────────────────────────────





function generateInstructions(project: ProjectDef, files: FileMeta[]): string {
  const blocks = [...new Set(files.flatMap((f) => f.building_blocks))].sort();
  const nes = [...new Set(files.flatMap((f) => f.ne_references))].sort();
  const stds = [...new Set(files.flatMap((f) => f.standards))].sort();

  const rules = loadContextFile(project.hub ? "export/rules-hub.md" : "export/rules-project.md");

  const lines = [
    `# ${project.name}`,
    "",
    project.instructions,
    "",
    rules,
  ];

  // Skip corpus summary for hub (it has no tagged docs, just PLAN/SUMMARY/ROUTING)
  if (!project.hub) {
    lines.push(
      "",
      "---",
      "",
      "## Corpus summary",
      "",
      `- **${files.length}** documents`,
      `- **~${Math.round(files.reduce((s, f) => s + f.tokens, 0) / 1000)}k** tokens`,
    );
    if (blocks.length > 0) lines.push(`- **Building blocks:** ${blocks.join(", ")}`);
    if (nes.length > 0) lines.push(`- **NE references:** ${nes.join(", ")}`);
    if (stds.length > 0) lines.push(`- **Standards:** ${stds.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Generate MANIFEST.md ──────────────────────────────────────────────

function generateManifest(project: ProjectDef, files: FileMeta[]): string {
  const totalTokens = files.reduce((s, f) => s + f.tokens, 0);
  const sorted = [...files].sort((a, b) => b.tokens - a.tokens);

  const lines: string[] = [
    `# ${project.name} — Manifest`,
    "",
    `> ${files.length} documents, ~${Math.round(totalTokens / 1000)}k tokens`,
    totalTokens > MAX_TOKENS ? `> ⚠️  Exceeds ${Math.round(MAX_TOKENS / 1000)}k token target — RAG will be active` : `> ✅ Within ${Math.round(MAX_TOKENS / 1000)}k token target`,
    "",
    "| # | Quality | Tokens | Building Blocks | File |",
    "|---|---------|--------|----------------|------|",
  ];

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    const icon = f.quality === "high" ? "🟢" : f.quality === "medium" ? "🟡" : "🔴";
    const blocks = f.building_blocks.join(", ") || "—";
    lines.push(`| ${i + 1} | ${icon} | ~${Math.round(f.tokens / 1000)}k | ${blocks} | ${f.filename} |`);
  }

  lines.push("");
  lines.push("## Token breakdown by quality");
  lines.push("");

  const byQuality = { high: 0, medium: 0, low: 0 };
  for (const f of files) {
    byQuality[f.quality as keyof typeof byQuality] += f.tokens;
  }
  lines.push(`- 🟢 High: ~${Math.round(byQuality.high / 1000)}k tokens`);
  lines.push(`- 🟡 Medium: ~${Math.round(byQuality.medium / 1000)}k tokens`);
  lines.push(`- 🔴 Low: ~${Math.round(byQuality.low / 1000)}k tokens`);

  return lines.join("\n");
}

// ── Generate ROUTING.md (for hub bundle) ───────────────────────────

function generateRouting(projects: ProjectDef[]): string {
  const lines: string[] = [
    "# Routing — Knowledge Base Project Map",
    "",
    "> Ce fichier mappe chaque section du PLAN.md vers le projet Claude correspondant.",
    "> Quand un utilisateur pose une question, identifie les sections pertinentes dans PLAN.md,",
    "> puis indique dans quel projet Claude se trouvent les documents détaillés.",
    "",
    "## Sections → Projets",
    "",
    "| Sections PLAN.md | Projet Claude | Description |",
    "|------------------|---------------|-------------|",
  ];

  for (const p of projects) {
    if (p.hub) continue; // skip the hub bundle
    const cats = p.categories.join(", ");
    lines.push(`| ${cats} | **${p.name}** | ${p.id} |`);
  }

  lines.push("");
  lines.push("## Comment utiliser ce routage");
  lines.push("");
  lines.push("1. L'utilisateur pose une question dans ce projet (hub)");
  lines.push("2. Tu identifies les sections PLAN.md pertinentes (ex: C.1, D.2)");
  lines.push("3. Tu donnes une réponse de haut niveau basée sur PLAN.md et SUMMARY.md");
  lines.push("4. Tu indiques le projet Claude spécialisé pour approfondir");
  lines.push("");
  // Generate a dynamic example from the first non-hub project
  const exampleProject = projects.find((p) => !p.hub);
  const exampleName = exampleProject?.name ?? "Projet Spécialisé";
  const exampleCats = exampleProject?.categories?.[0] ?? "C.*";
  lines.push(`Exemple : "Les détails sur [sujet] se trouvent dans le projet **${exampleName}** (sections ${exampleCats})"`);
  lines.push("");

  return lines.join("\n");
}

// ── Auto-generate bundles from PLAN.md from PLAN.md + tagged files ──────────

interface PlanSection {
  id: string;         // "A", "B", "C"
  title: string;      // "NOA Foundations — Core concepts"
  subsections: string[]; // ["A.1", "A.2", "A.3"]
}

function parsePlanSections(planPath: string): PlanSection[] {
  if (!existsSync(planPath)) return [];
  const content = readFileSync(planPath, "utf-8");
  const sections: PlanSection[] = [];
  let current: PlanSection | null = null;

  for (const line of content.split("\n")) {
    // Major section: "## A. Section Name — Description" or "## A. Section Name"
    const majorMatch = line.match(/^##\s+([A-Z])\.?\s+(.+)/);
    if (majorMatch) {
      if (current) sections.push(current);
      current = { id: majorMatch[1], title: majorMatch[2].trim(), subsections: [] };
      continue;
    }

    // Subsection: "- A.1 Subsection name (keywords)"
    const subMatch = line.match(/^\s*-\s+([A-Z]\.\d+)\s/);
    if (subMatch && current) {
      current.subsections.push(subMatch[1]);
    }
  }
  if (current) sections.push(current);

  return sections;
}

function autoGenerateProjects(
  planSections: PlanSection[],
  allFiles: FileMeta[],
  maxTokens: number,
): ProjectDef[] {
  if (planSections.length === 0) {
    console.error("❌ Cannot auto-generate: PLAN.md has no sections (## A., ## B., ...)");
    process.exit(1);
  }

  // Calculate tokens per section
  const sectionTokens = new Map<string, number>();
  const minQRank = QUALITY_RANK[MIN_QUALITY] ?? 2;

  for (const section of planSections) {
    const patterns = [
      `${section.id}.*`,  // matches A, A.1, A.2, etc.
    ];
    const matched = allFiles.filter((f) =>
      (QUALITY_RANK[f.quality] ?? 0) >= minQRank && matchesCategory(f.categories, patterns)
    );
    const tokens = matched.reduce((sum, f) => sum + f.tokens, 0);
    sectionTokens.set(section.id, tokens);
  }

  console.log("📊 Section token analysis:");
  for (const section of planSections) {
    const tokens = sectionTokens.get(section.id) ?? 0;
    const bar = "█".repeat(Math.min(Math.round(tokens / 10_000), 20));
    console.log(`   ${section.id}. ${bar} ~${Math.round(tokens / 1000)}k — ${section.title}`);
  }
  console.log();

  // Greedy packing: merge sections into bundles ≤ maxTokens
  const projects: ProjectDef[] = [];
  let currentBundle: PlanSection[] = [];
  let currentTokens = 0;

  for (const section of planSections) {
    const tokens = sectionTokens.get(section.id) ?? 0;

    // If a single section exceeds budget, it gets its own bundle
    if (tokens > maxTokens) {
      if (currentBundle.length > 0) {
        projects.push(buildProjectDef(currentBundle));
        currentBundle = [];
        currentTokens = 0;
      }
      projects.push(buildProjectDef([section]));
      continue;
    }

    // Would adding this section exceed the budget?
    if (currentTokens + tokens > maxTokens && currentBundle.length > 0) {
      projects.push(buildProjectDef(currentBundle));
      currentBundle = [];
      currentTokens = 0;
    }

    currentBundle.push(section);
    currentTokens += tokens;
  }

  // Flush remaining
  if (currentBundle.length > 0) {
    projects.push(buildProjectDef(currentBundle));
  }

  // Add hub project
  projects.unshift({
    id: "hub",
    name: "Hub — Knowledge Base Router",
    categories: ["*"],
    instructions: "Central routing bundle. Use PLAN.md, SUMMARY.md and ROUTING.md to direct users to the right sub-bundle.",
    hub: true,
  });

  return projects;
}

function buildProjectDef(sections: PlanSection[]): ProjectDef {
  const ids = sections.map((s) => s.id);
  const id = ids.join("-").toLowerCase();
  const name = sections.length === 1
    ? sections[0].title.replace(/\s*—.*/, "")
    : `${ids.join("+")} — ${sections[0].title.replace(/\s*—.*/, "")} + ${sections.length - 1} more`;

  const categories = sections.flatMap((s) => [`${s.id}.*`]);
  const instructions = sections.map((s) =>
    `Section ${s.id}: ${s.title}` + (s.subsections.length > 0 ? ` (${s.subsections.join(", ")})` : "")
  ).join("\n");

  return { id, name, categories, instructions };
}

// ── Main ──────────────────────────────────────────────────────────────

export async function exportProjects(): Promise<void> {
  // Scan all tagged files (needed for both auto-gen and export)
  const allFiles = scanTaggedFiles();
  if (allFiles.length === 0) {
    console.log("⚠️  No tagged files found. Run the tagging pipeline first.");
    return;
  }
  console.log(`📚 Found ${allFiles.length} tagged files`);
  console.log();

  // Always generate from PLAN.md + token budget
  const planPath = PLAN_FILE;
  if (!existsSync(planPath)) {
    console.error("❌ PLAN.md not found. Run media:synthesize first.");
    process.exit(1);
  }

  console.log(`🔧 Generating bundles from PLAN.md (budget: ${Math.round(MAX_TOKENS / 1000)}k tokens per bundle)`);
  console.log();

  const planSections = parsePlanSections(planPath);
  const projects = autoGenerateProjects(planSections, allFiles, MAX_TOKENS);

  console.log(`✅ ${projects.length} bundles (${projects.filter((p) => !p.hub).length} topic bundles + 1 hub)`);
  for (const p of projects) {
    const icon = p.hub ? "🏠" : "📁";
    console.log(`   ${icon} ${p.name} [${p.categories.join(", ")}]`);
  }
  console.log();

  if (!DRY_RUN) {
    mkdirSync(BUNDLES_DIR, { recursive: true });
    writeFileSync(BUNDLES_FILE, JSON.stringify(projects, null, 2));
    console.log(`💾 Saved ${basename(BUNDLES_FILE)}`);
    console.log();
  }

  console.log(`   Quality filter: ≥ ${MIN_QUALITY}`);
  console.log(`   Token target:   ${Math.round(MAX_TOKENS / 1000)}k`);
  console.log(`   Output:         ${BUNDLES_DIR}`);
  console.log();

  // Process each project
  let grandTotalFiles = 0;
  let grandTotalTokens = 0;

  for (const project of projects) {
    const minQ = project.min_quality ?? MIN_QUALITY;
    const minQRank = QUALITY_RANK[minQ] ?? 2;

    // Match files by category patterns
    const matched = allFiles.filter((f) => matchesCategory(f.categories, project.categories));

    // Filter by quality
    const filtered = matched.filter((f) => (QUALITY_RANK[f.quality] ?? 0) >= minQRank);

    // Deduplicate by filename (a file can match multiple categories)
    const seen = new Set<string>();
    const deduped = filtered.filter((f) => {
      if (seen.has(f.path)) return false;
      seen.add(f.path);
      return true;
    });

    const totalTokens = deduped.reduce((s, f) => s + f.tokens, 0);

    // Hub bundle gets PLAN.md, SUMMARY.md, ROUTING.md added to their data/
    let hubTokens = 0;
    const hubFiles: string[] = [];
    if (project.hub) {
      for (const name of ["PLAN.md", "SUMMARY.md"]) {
        const p = join(OUTPUT_DIR, name);
        if (existsSync(p)) {
          hubTokens += Math.round(statSync(p).size / 4);
          hubFiles.push(name);
        }
      }
      hubTokens += 500; // estimate for generated ROUTING.md
      hubFiles.push("ROUTING.md");
    }
    const totalWithHub = totalTokens + hubTokens;

    const tokensK = Math.round(totalWithHub / 1000);
    const exceedsLimit = totalWithHub > MAX_TOKENS;
    const statusIcon = exceedsLimit ? "⚠️" : "✅";
    const droppedCount = matched.length - deduped.length;
    const filteredOut = matched.filter((f) => (QUALITY_RANK[f.quality] ?? 0) < minQRank);

    console.log(`┌─ ${project.name} (${project.id})`);
    console.log(`│  Categories: ${project.categories.join(", ")}${project.hub ? " + hub (PLAN, SUMMARY, ROUTING)" : ""}`);
    console.log(`│  Quality: ≥ ${minQ} (${filteredOut.length} 🔴 excluded)`);
    console.log(`│  Files: ${deduped.length}${hubFiles.length > 0 ? ` + ${hubFiles.length} hub files` : ""} (${matched.length} matched, ${droppedCount} duplicates removed)`);
    console.log(`│  ${statusIcon} Tokens: ~${tokensK}k / ${Math.round(MAX_TOKENS / 1000)}k`);

    if (!DRY_RUN) {
      // Create project directory with data/ subfolder
      // data/ = what you connect to Claude (docs only)
      // PROJECT_INSTRUCTIONS.md + MANIFEST.md stay at project root (not uploaded to Claude)
      const projectDir = join(BUNDLES_DIR, project.id);
      const dataDir = join(projectDir, "data");

      // Clean and recreate
      if (existsSync(projectDir)) rmSync(projectDir, { recursive: true });
      mkdirSync(dataDir, { recursive: true });

      // Copy docs into data/
      for (const f of deduped) {
        copyFileSync(f.path, join(dataDir, f.filename));
      }

      // Hub: copy PLAN.md, SUMMARY.md and generate ROUTING.md
      if (project.hub) {
        for (const name of ["PLAN.md", "SUMMARY.md"]) {
          const src = join(OUTPUT_DIR, name);
          if (existsSync(src)) {
            copyFileSync(src, join(dataDir, name));
            console.log(`│  📎 + ${name}`);
          } else {
            console.log(`│  ⚠️  ${name} not found in ${OUTPUT_DIR}`);
          }
        }

        // Generate ROUTING.md — maps PLAN sections → Claude project names
        const routing = generateRouting(projects);
        writeFileSync(join(dataDir, "ROUTING.md"), routing);
        console.log(`│  📎 + ROUTING.md (auto-generated)`);
      }

      // Generate instructions at project root
      const instructions = generateInstructions(project, deduped);
      writeFileSync(join(projectDir, "PROJECT_INSTRUCTIONS.md"), instructions);

      // Generate manifest at project root (skip for hub — it has no tagged docs)
      if (!project.hub) {
        const manifest = generateManifest(project, deduped);
        writeFileSync(join(projectDir, "MANIFEST.md"), manifest);
      }

      console.log(`│  📁 → ${projectDir}`);
    }

    console.log(`└──────────────────────────────────────`);
    console.log();

    grandTotalFiles += deduped.length;
    grandTotalTokens += totalWithHub;
  }

  // Orphan check — files not assigned to any project
  const allAssigned = new Set<string>();
  for (const project of projects) {
    const matched = allFiles.filter((f) => matchesCategory(f.categories, project.categories));
    for (const f of matched) allAssigned.add(f.path);
  }
  const orphans = allFiles.filter((f) => !allAssigned.has(f.path));

  if (orphans.length > 0) {
    console.log(`⚠️  ${orphans.length} file(s) not assigned to any project:`);
    for (const f of orphans.slice(0, 10)) {
      console.log(`   ${f.filename} → categories: [${f.categories.join(", ")}]`);
    }
    if (orphans.length > 10) console.log(`   ... and ${orphans.length - 10} more`);
    console.log();
  }

  // Summary table
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log();
  console.log("  Project                        Files     Tokens    Status");
  console.log("  ─────────────────────────────── ───── ────────── ──────────");

  const summaryRows: { name: string; id: string; files: number; tokens: number; max: number }[] = [];

  for (const project of projects) {
    const minQ = project.min_quality ?? MIN_QUALITY;
    const minQRank = QUALITY_RANK[minQ] ?? 2;
    const matched = allFiles.filter((f) => matchesCategory(f.categories, project.categories));
    const filtered = matched.filter((f) => (QUALITY_RANK[f.quality] ?? 0) >= minQRank);
    const seen = new Set<string>();
    const deduped = filtered.filter((f) => { if (seen.has(f.path)) return false; seen.add(f.path); return true; });
    const totalTokens = deduped.reduce((s, f) => s + f.tokens, 0);

    // Account for hub files
    let hubTokens = 0;
    if (project.hub) {
      for (const name of ["PLAN.md", "SUMMARY.md"]) {
        const p = join(OUTPUT_DIR, name);
        if (existsSync(p)) hubTokens += Math.round(statSync(p).size / 4);
      }
      hubTokens += 500;
    }
    const totalWithHub = totalTokens + hubTokens;

    summaryRows.push({ name: project.name, id: project.id, files: deduped.length, tokens: totalWithHub, max: MAX_TOKENS });

    const tokensK = Math.round(totalWithHub / 1000);
    const maxK = Math.round(MAX_TOKENS / 1000);
    const pct = Math.round((totalWithHub / MAX_TOKENS) * 100);
    const bar = "█".repeat(Math.min(20, Math.round(pct / 5))) + "░".repeat(Math.max(0, 20 - Math.round(pct / 5)));
    const status = totalWithHub > MAX_TOKENS ? `⚠️  ${pct}%` : `✅ ${pct}%`;
    const nameStr = project.name.padEnd(32);
    const filesStr = String(deduped.length).padStart(4);
    const tokensStr = `~${tokensK}k/${maxK}k`.padStart(10);

    console.log(`  ${nameStr} ${filesStr} ${tokensStr} ${bar} ${status}`);
  }

  console.log();
  console.log(`  TOTAL ${" ".repeat(26)} ${String(grandTotalFiles).padStart(4)} ~${Math.round(grandTotalTokens / 1000)}k tokens`);
  console.log();

  if (orphans.length > 0) {
    console.log(`  ⚠️  ${orphans.length} orphan(s) not in any project`);
  }

  if (DRY_RUN) {
    console.log("═══════════════════════════════════════════════════════════════════════════");
    console.log(`  🏜️  Dry run — no files written`);
  } else {
    console.log("═══════════════════════════════════════════════════════════════════════════");
    console.log(`  ✅ Exported → ${BUNDLES_DIR}`);
    console.log();
    console.log("  Structure per project:");
    console.log("    <project-id>/PROJECT_INSTRUCTIONS.md  ← paste into Claude instructions");
    console.log("    <project-id>/MANIFEST.md              ← reference for you");
    console.log("    <project-id>/data/                    ← connect this folder to Claude");
    console.log();
    console.log("  Next steps:");
    console.log("    1. Create a Claude Project on claude.ai/projects");
    console.log("    2. Connect GitHub repo → select exports/<project-id>/data/");
    console.log("       OR drag & drop the files from data/ into project knowledge");
    console.log("    3. Open PROJECT_INSTRUCTIONS.md, copy into 'Set project instructions'");
    console.log("    4. Start chatting!");
  }
  console.log("═══════════════════════════════════════════════════════════════════════════");
}
