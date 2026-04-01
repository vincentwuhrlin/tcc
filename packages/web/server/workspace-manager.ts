/**
 * Workspace Manager — orchestrates workspace hot-reload.
 *
 * Manages the lifecycle of switching between workspaces:
 *   1. Close current DB connection
 *   2. Point DB to new workspace path
 *   3. Reload instructions.md + domain.md + PLAN.md headers
 *   4. Reload RAG index from new workspace.db
 *   5. Persist selection in .tcc-state.json
 *   6. Return updated workspace info + stats
 */
import { readFileSync, existsSync, readdirSync, openSync, readSync, closeSync } from "fs";
import { join, resolve } from "path";
import { MONOREPO_ROOT } from "./env.js";
import { resetDb, getDb, getDbStats } from "@tcc/core/src/common/db.js";
import { clearIndex, loadIndex } from "@tcc/core/src/common/rag.js";
import { getChatEmbedEngine } from "@tcc/core/src/common/embed/index.js";
import { CHAT_MIN_SCORE, CHAT_TOP_K } from "@tcc/core/src/config.js";
import { loadWorkspace, scanAllWorkspaces, type WorkspaceInfo } from "./workspace.js";
import { getActiveWorkspaceName, setActiveWorkspace } from "./state.js";
import { COMPACT_THRESHOLD, SLIDING_WINDOW_SIZE, COMPACT_INTERVAL } from "./sessions.js";

// ── Mutable state ───────────────────────────────────────────────────

let _current: WorkspaceInfo;
let _allWorkspaces: WorkspaceInfo[];
let _instructionsContent = "";
let _domainContent = "";
let _planHeaders = "";
let _ragReady = false;
let _ragChunkCount = 0;

// ── Cached workspace stats ──────────────────────────────────────────

export interface CachedWorkspaceStats {
  workspace: { id: string; name: string; title: string };
  engine: { engine: string; model: string; dimensions: number; mode: string };
  rag: { ready: boolean; total: number; documents: number; qa: number; minScore: number; topK: number };
  sources: { source: string; cnt: number }[];
  qaList: { id: string; source: string; chars: number }[];
  categories: string[];
  categoryDistribution: { category: string; count: number }[];
  context: { hasInstructions: boolean; instructionsChars: number; hasDomain: boolean; domainChars: number; hasPlan: boolean; planChars: number; categoriesCount: number };
  sessions: { total: number; messages: number };
  compaction: { threshold: number; windowSize: number; interval: number };
  computedAt: string;
}

let _cachedStats: CachedWorkspaceStats | null = null;

// ── Accessors ───────────────────────────────────────────────────────

export function currentWorkspace(): WorkspaceInfo { return _current; }
export function currentWorkspacePath(): string { return _current.path; }
export function allWorkspaces(): WorkspaceInfo[] { return _allWorkspaces; }
export function instructionsContent(): string { return _instructionsContent; }
export function domainContent(): string { return _domainContent; }
export function planHeaders(): string { return _planHeaders; }
export function ragReady(): boolean { return _ragReady; }
export function ragChunkCount(): number { return _ragChunkCount; }
export function workspaceStats(): CachedWorkspaceStats | null { return _cachedStats; }

/** Reload RAG index from DB (call after inserting new embeddings). */
export async function reloadRagIndex(): Promise<number> {
  await loadRagIndex();
  return _ragChunkCount;
}

/** Refresh cached workspace stats (call after QA save, workspace switch, etc.). */
export async function refreshStats(): Promise<CachedWorkspaceStats> {
  _cachedStats = await computeWorkspaceStats();
  return _cachedStats;
}

// ── Resolve workspace path ──────────────────────────────────────────

function resolveWorkspacePath(workspaceId: string): string {
  const wsDir = resolve(MONOREPO_ROOT, process.env.WORKSPACES_DIR ?? "workspaces");
  return join(wsDir, workspaceId);
}

// ── Extract PLAN.md headers only ────────────────────────────────────
// Keeps ## and ### headings (categories + subcategories) as a compact
// table of contents. Drops body text to save tokens.

function extractPlanHeaders(planContent: string): string {
  const lines = planContent.split("\n");
  const headers: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Match ## A. Category or ### A.1 Subcategory
    if (/^#{2,3}\s+[A-Z][\.\d]*/.test(trimmed)) {
      const depth = trimmed.startsWith("### ") ? "  " : "";
      const text = trimmed.replace(/^#{2,3}\s+/, "");
      headers.push(`${depth}${text}`);
    }
  }

  return headers.join("\n");
}

// ── Load context files ──────────────────────────────────────────────

function loadContextFiles(wsPath: string): void {
  const outputDir = join(wsPath, "media", "output");

  // instructions.md — chat behavior rules (audience, citations, language)
  const instructionsPath = join(wsPath, "context", "chat", "instructions.md");
  if (existsSync(instructionsPath)) {
    _instructionsContent = readFileSync(instructionsPath, "utf-8");
    console.log(`  📜 instructions.md loaded (${Math.round(_instructionsContent.length / 1000)}k chars)`);
  } else {
    _instructionsContent = "";
    console.log(`  📜 instructions.md not found (context/chat/instructions.md)`);
  }

  // domain.md — domain knowledge, vocabulary, team context
  const domainPath = join(wsPath, "context", "shared", "domain.md");
  if (existsSync(domainPath)) {
    _domainContent = readFileSync(domainPath, "utf-8");
    console.log(`  🌐 domain.md loaded (${Math.round(_domainContent.length / 1000)}k chars)`);
  } else {
    _domainContent = "";
    console.log(`  🌐 domain.md not found`);
  }

  // PLAN.md — extract headers only (compact category map)
  const planPath = join(outputDir, "PLAN.md");
  if (existsSync(planPath)) {
    const raw = readFileSync(planPath, "utf-8");
    _planHeaders = extractPlanHeaders(raw);
    const catCount = _planHeaders.split("\n").filter((l) => !l.startsWith("  ")).length;
    console.log(`  📋 PLAN.md → ${catCount} categories extracted (headers only)`);
  } else {
    _planHeaders = "";
    console.log(`  📋 PLAN.md not found`);
  }
}

// ── Compute workspace stats (cached) ────────────────────────────────

async function computeWorkspaceStats(): Promise<CachedWorkspaceStats> {
  const t0 = Date.now();
  const ws = _current;
  const dbStats = getDbStats();

  // Embed engine info
  let engineInfo = { engine: "unknown", model: "unknown", dimensions: 0, mode: "unknown" as string };
  try {
    const engine = await getChatEmbedEngine();
    engineInfo = engine.info();
  } catch { /* ignore */ }

  const db = getDb();
  const currentModel = engineInfo.model;

  const totalChunks = (db.prepare(
    "SELECT COUNT(*) as cnt FROM embeddings WHERE model = ?"
  ).get(currentModel) as { cnt: number })?.cnt ?? 0;

  const qaCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM embeddings WHERE model = ? AND id LIKE 'QA__%'"
  ).get(currentModel) as { cnt: number })?.cnt ?? 0;

  const docCount = totalChunks - qaCount;

  const topSources = db.prepare(
    "SELECT source, COUNT(*) as cnt FROM embeddings WHERE model = ? GROUP BY source ORDER BY cnt DESC LIMIT 30"
  ).all(currentModel) as { source: string; cnt: number }[];

  const qaList = db.prepare(
    "SELECT id, source, LENGTH(content) as chars FROM embeddings WHERE model = ? AND id LIKE 'QA__%' ORDER BY created_at DESC"
  ).all(currentModel) as { id: string; source: string; chars: number }[];

  // Categories from PLAN.md
  const categories = _planHeaders
    .split("\n")
    .filter((l) => !l.startsWith("  ") && l.trim())
    .map((l) => l.trim());

  // Category distribution — scan chunk file frontmatter on disk
  const categoryCounts: Record<string, number> = {};
  const outputDir = join(ws.path, "media", "output");
  for (const sub of ["documents", "videos"]) {
    const chunksDir = join(outputDir, sub, "chunks");
    if (!existsSync(chunksDir)) continue;
    const files = readdirSync(chunksDir).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      try {
        const fd = openSync(join(chunksDir, f), "r");
        const buf = Buffer.alloc(2048);
        const bytesRead = readSync(fd, buf, 0, 2048, 0);
        closeSync(fd);
        const head = buf.toString("utf-8", 0, bytesRead);

        // Extract frontmatter between --- markers
        const fmMatch = head.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;
        const fmLines = fmMatch[1].split("\n");

        // Parse YAML: find "categories:" then collect "  - value" lines
        let currentField = "";
        let mainCat = "";

        for (const line of fmLines) {
          if (/^\w/.test(line)) {
            currentField = line.split(":")[0];
          } else if (/^\s+-\s/.test(line) && currentField === "categories" && !mainCat) {
            mainCat = line.replace(/^\s+-\s*"?/, "").replace(/"?\s*$/, "");
          }
        }

        if (mainCat) {
          categoryCounts[mainCat] = (categoryCounts[mainCat] ?? 0) + 1;
        }
      } catch { /* skip */ }
    }
  }

  // Build lookup map from PLAN.md: code → full name
  // _planHeaders only has ## headings (main categories A–K)
  // We also need subcategories from list items: "- A.1 Name (tags)"
  const planLookup = new Map<string, string>();

  // 1. Main categories from headers: "A. Platform Overview..."
  for (const line of _planHeaders.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const codeMatch = trimmed.match(/^([A-Z][\.\d]*)\s/);
    if (codeMatch) {
      planLookup.set(codeMatch[1], trimmed);
    }
  }

  // 2. Subcategories from full PLAN.md file: "- A.1 Name (tags)"
  const planPath = join(outputDir, "PLAN.md");
  if (existsSync(planPath)) {
    const planContent = readFileSync(planPath, "utf-8");
    for (const line of planContent.split("\n")) {
      const trimmed = line.trim();
      // Match "- A.1 Platform architecture and component overview (tags)"
      const subMatch = trimmed.match(/^-\s+([A-Z]\.\d+)\s+(.+?)(?:\s*\(.*\))?\s*$/);
      if (subMatch) {
        planLookup.set(subMatch[1], `${subMatch[1]} ${subMatch[2]}`);
      }
    }
  }

  // Enrich codes with full names, sort by code
  // Fallback: if exact code not found, try main category letter (A.1 → A.)
  const categoryDistribution = Object.entries(categoryCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => {
      const full = planLookup.get(code)
        ?? planLookup.get(code.replace(/\.$/, ""))
        ?? planLookup.get(code.replace(/\.\d+$/, "."))
        ?? code;
      return { category: full, count };
    });

  console.log(`  📊 Workspace stats computed in ${Date.now() - t0}ms`);

  return {
    workspace: { id: ws.id, name: ws.name, title: ws.title },
    engine: engineInfo,
    rag: { ready: _ragReady, total: totalChunks, documents: docCount, qa: qaCount, minScore: CHAT_MIN_SCORE, topK: CHAT_TOP_K },
    sources: topSources,
    qaList,
    categories,
    categoryDistribution,
    context: {
      hasInstructions: !!_instructionsContent, instructionsChars: _instructionsContent.length,
      hasDomain: !!_domainContent, domainChars: _domainContent.length,
      hasPlan: !!_planHeaders, planChars: _planHeaders.length,
      categoriesCount: categories.length,
    },
    sessions: { total: dbStats.sessions, messages: dbStats.messages },
    compaction: { threshold: COMPACT_THRESHOLD, windowSize: SLIDING_WINDOW_SIZE, interval: COMPACT_INTERVAL },
    computedAt: new Date().toISOString(),
  };
}

// ── Load RAG index ──────────────────────────────────────────────────

async function loadRagIndex(): Promise<void> {
  try {
    clearIndex();
    const engine = await getChatEmbedEngine();
    const info = engine.info();
    _ragChunkCount = loadIndex(info.model);
    _ragReady = _ragChunkCount > 0;
    console.log(`  🧠 RAG index: ${_ragChunkCount} chunks (${info.engine}, ${info.dimensions}d)`);
  } catch (err) {
    _ragReady = false;
    _ragChunkCount = 0;
    console.error(`  ❌ RAG init failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Initialize (called once at startup) ─────────────────────────────

export async function init(): Promise<void> {
  const t0 = Date.now();

  // Scan all available workspaces
  _allWorkspaces = scanAllWorkspaces();

  // Determine active workspace: .tcc-state.json → .env → "default"
  const activeName = getActiveWorkspaceName();
  const wsPath = resolveWorkspacePath(activeName);

  // Load workspace info
  if (existsSync(wsPath)) {
    _current = loadWorkspace(wsPath);
  } else {
    console.warn(`  ⚠️  Workspace "${activeName}" not found at ${wsPath}`);
    // Fallback to first available workspace
    if (_allWorkspaces.length > 0) {
      _current = _allWorkspaces[0];
      console.log(`  📂 Falling back to: ${_current.name}`);
    } else {
      _current = { id: activeName, name: activeName, title: "Not found", description: "", path: wsPath, stats: { documents: 0, indexed: false, planCategories: 0, hasDomainContext: false } };
    }
  }

  // Point DB to the active workspace
  resetDb(_current.path);

  // Load context files
  loadContextFiles(_current.path);

  // Load RAG index
  await loadRagIndex();

  // Compute and cache workspace stats
  _cachedStats = await computeWorkspaceStats();

  console.log(`  ⏱️  Init: ${Date.now() - t0}ms`);
}

// ── Switch workspace (hot-reload) ───────────────────────────────────

export async function switchWorkspace(workspaceId: string): Promise<WorkspaceInfo | null> {
  // Find the workspace
  const found = _allWorkspaces.find((ws) => ws.id === workspaceId);
  if (!found) return null;

  console.log();
  console.log(`  🔄 Switching workspace: ${_current.name} → ${found.name}`);
  const t0 = Date.now();

  // Update current
  _current = found;

  // Point DB to new workspace
  resetDb(_current.path);

  // Reload context files
  loadContextFiles(_current.path);

  // Reload RAG index
  await loadRagIndex();

  // Persist selection
  setActiveWorkspace(workspaceId);

  // Recompute cached stats
  _cachedStats = await computeWorkspaceStats();

  console.log(`  ✅ Switched to ${_current.name} in ${Date.now() - t0}ms`);
  console.log();

  return _current;
}
