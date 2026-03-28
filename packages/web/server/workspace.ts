/**
 * Workspace reader — loads workspace metadata and computes stats.
 *
 * Convention:
 *   WORKSPACES_DIR = directory containing all workspaces (default: "workspaces")
 *   WORKSPACE      = active workspace name / subdirectory  (default: "default")
 *   Full path      = resolve(MONOREPO_ROOT, WORKSPACES_DIR, WORKSPACE)
 *
 * Reads workspace.json from each workspace root, then scans for:
 * - Document count (*.md in media/output)
 * - INDEX.md presence
 * - PLAN.md category count
 * - Domain context presence
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, basename } from "path";
import { MONOREPO_ROOT } from "./env.js";

export interface WorkspaceInfo {
  id: string;          // directory name (e.g. "industrial-edge")
  name: string;        // display name from workspace.json (e.g. "IE")
  title: string;       // full title (e.g. "Siemens Industrial Edge")
  description: string;
  path: string;        // absolute path on disk
  stats: {
    documents: number;
    indexed: boolean;
    planCategories: number;
    hasDomainContext: boolean;
  };
}

// ── Paths ────────────────────────────────────────────────────────────

function resolveFromRoot(p: string): string {
  return resolve(MONOREPO_ROOT, p);
}

function getWorkspacesDir(): string {
  return resolveFromRoot(process.env.WORKSPACES_DIR ?? "workspaces");
}

function getActiveWorkspaceName(): string {
  return process.env.WORKSPACE ?? "default";
}

// ── Scanning ─────────────────────────────────────────────────────────

function countMarkdownFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "INDEX.md" && entry.name !== "PLAN.md") {
      count++;
    } else if (entry.isDirectory()) {
      count += countMarkdownFiles(join(dir, entry.name));
    }
  }
  return count;
}

function countPlanCategories(planPath: string): number {
  if (!existsSync(planPath)) return 0;
  const content = readFileSync(planPath, "utf-8");
  const matches = content.match(/^#{1,3}\s+[A-Z]\.\d+/gm);
  return matches?.length ?? 0;
}

// ── Load a single workspace ──────────────────────────────────────────

export function loadWorkspace(wsPath: string): WorkspaceInfo {
  const id = basename(wsPath);

  // Read workspace.json
  const wsJsonPath = join(wsPath, "workspace.json");
  let name = id;
  let title = id;
  let description = "";

  if (existsSync(wsJsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(wsJsonPath, "utf-8"));
      name = raw.name ?? name;
      title = raw.title ?? title;
      description = raw.description ?? description;
    } catch {
      console.warn(`⚠️  Could not parse ${wsJsonPath}`);
    }
  }

  // Compute stats
  const outputDir = join(wsPath, "media", "output");
  const indexPath = join(outputDir, "INDEX.md");
  const planPath = join(outputDir, "PLAN.md");
  const domainPath = join(wsPath, "context", "shared", "domain.md");

  const stats = {
    documents: countMarkdownFiles(outputDir),
    indexed: existsSync(indexPath),
    planCategories: countPlanCategories(planPath),
    hasDomainContext: existsSync(domainPath),
  };

  return { id, name, title, description, path: wsPath, stats };
}

// ── Load active workspace ────────────────────────────────────────────

export function loadActiveWorkspace(): WorkspaceInfo {
  const wsPath = join(getWorkspacesDir(), getActiveWorkspaceName());

  if (!existsSync(wsPath)) {
    console.warn(`⚠️  Workspace directory not found: ${wsPath}`);
    console.warn(`   Check WORKSPACES_DIR and WORKSPACE in .env`);
  }

  return loadWorkspace(wsPath);
}

// ── Scan all workspaces ──────────────────────────────────────────────

export function scanAllWorkspaces(): WorkspaceInfo[] {
  const dir = getWorkspacesDir();

  if (!existsSync(dir)) {
    console.warn(`⚠️  Workspaces directory not found: ${dir}`);
    return [];
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const workspaces: WorkspaceInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wsPath = join(dir, entry.name);
    // Only include directories that have a workspace.json
    if (existsSync(join(wsPath, "workspace.json"))) {
      workspaces.push(loadWorkspace(wsPath));
    }
  }

  return workspaces.sort((a, b) => a.name.localeCompare(b.name));
}
