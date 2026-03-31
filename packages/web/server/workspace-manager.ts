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
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { MONOREPO_ROOT } from "./env.js";
import { resetDb } from "@tcc/core/src/common/db.js";
import { clearIndex, loadIndex } from "@tcc/core/src/common/rag.js";
import { getChatEmbedEngine } from "@tcc/core/src/common/embed/index.js";
import { loadWorkspace, scanAllWorkspaces, type WorkspaceInfo } from "./workspace.js";
import { getActiveWorkspaceName, setActiveWorkspace } from "./state.js";

// ── Mutable state ───────────────────────────────────────────────────

let _current: WorkspaceInfo;
let _allWorkspaces: WorkspaceInfo[];
let _instructionsContent = "";
let _domainContent = "";
let _planHeaders = "";
let _ragReady = false;
let _ragChunkCount = 0;

// ── Accessors ───────────────────────────────────────────────────────

export function currentWorkspace(): WorkspaceInfo { return _current; }
export function allWorkspaces(): WorkspaceInfo[] { return _allWorkspaces; }
export function instructionsContent(): string { return _instructionsContent; }
export function domainContent(): string { return _domainContent; }
export function planHeaders(): string { return _planHeaders; }
export function ragReady(): boolean { return _ragReady; }
export function ragChunkCount(): number { return _ragChunkCount; }

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

  console.log(`  ✅ Switched to ${_current.name} in ${Date.now() - t0}ms`);
  console.log();

  return _current;
}
