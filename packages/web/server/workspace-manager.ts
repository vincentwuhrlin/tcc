/**
 * Workspace Manager — orchestrates workspace hot-reload.
 *
 * Manages the lifecycle of switching between workspaces:
 *   1. Close current DB connection
 *   2. Point DB to new workspace path
 *   3. Reload PLAN.md + INDEX.md
 *   4. Reload RAG index from new workspace.db
 *   5. Persist selection in .tcc-state.json
 *   6. Return updated workspace info + stats
 */
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { MONOREPO_ROOT } from "./env.js";
import { resetDb } from "@tcc/core/src/common/db.js";
import { clearIndex, loadIndex } from "@tcc/core/src/common/rag.js";
import { getEmbedEngine } from "@tcc/core/src/common/embed/index.js";
import { loadWorkspace, scanAllWorkspaces, type WorkspaceInfo } from "./workspace.js";
import { getActiveWorkspaceName, setActiveWorkspace } from "./state.js";

// ── Mutable state ───────────────────────────────────────────────────

let _current: WorkspaceInfo;
let _allWorkspaces: WorkspaceInfo[];
let _planContent = "";
let _indexContent = "";
let _ragReady = false;
let _ragChunkCount = 0;

// ── Accessors ───────────────────────────────────────────────────────

export function currentWorkspace(): WorkspaceInfo { return _current; }
export function allWorkspaces(): WorkspaceInfo[] { return _allWorkspaces; }
export function planContent(): string { return _planContent; }
export function indexContent(): string { return _indexContent; }
export function ragReady(): boolean { return _ragReady; }
export function ragChunkCount(): number { return _ragChunkCount; }

// ── Resolve workspace path ──────────────────────────────────────────

function resolveWorkspacePath(workspaceId: string): string {
  const wsDir = resolve(MONOREPO_ROOT, process.env.WORKSPACES_DIR ?? "workspaces");
  return join(wsDir, workspaceId);
}

// ── Load PLAN.md + INDEX.md ─────────────────────────────────────────

function loadContextFiles(wsPath: string): void {
  const outputDir = join(wsPath, "media", "output");

  // PLAN.md
  const planPath = join(outputDir, "PLAN.md");
  if (existsSync(planPath)) {
    _planContent = readFileSync(planPath, "utf-8");
    console.log(`  📋 PLAN.md loaded (${Math.round(_planContent.length / 1000)}k chars)`);
  } else {
    _planContent = "";
    console.log(`  📋 PLAN.md not found`);
  }

  // INDEX.md (truncate if too large)
  const indexPath = join(outputDir, "INDEX.md");
  if (existsSync(indexPath)) {
    const raw = readFileSync(indexPath, "utf-8");
    const maxChars = 60_000;
    _indexContent = raw.length > maxChars
      ? raw.slice(0, maxChars) + `\n\n[... INDEX.md truncated ...]`
      : raw;
    console.log(`  📑 INDEX.md loaded (${Math.round(raw.length / 1000)}k chars)`);
  } else {
    _indexContent = "";
    console.log(`  📑 INDEX.md not found`);
  }
}

// ── Load RAG index ──────────────────────────────────────────────────

async function loadRagIndex(): Promise<void> {
  try {
    clearIndex();
    const engine = await getEmbedEngine();
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
