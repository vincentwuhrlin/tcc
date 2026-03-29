/**
 * State manager — persists user preferences across server restarts.
 *
 * Stored in .tcc-state.json at the monorepo root.
 * Currently only tracks the active workspace.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { MONOREPO_ROOT } from "./env.js";

const STATE_FILE = join(MONOREPO_ROOT, ".tcc-state.json");

interface TccState {
  activeWorkspace: string;
}

/** Load state from disk. Returns null if no state file. */
export function loadState(): TccState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/** Save state to disk. */
export function saveState(state: TccState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/** Get active workspace name: state file → .env WORKSPACE → "default" */
export function getActiveWorkspaceName(): string {
  const state = loadState();
  if (state?.activeWorkspace) return state.activeWorkspace;
  return process.env.WORKSPACE ?? "default";
}

/** Persist workspace switch. */
export function setActiveWorkspace(workspaceName: string): void {
  const state = loadState() ?? { activeWorkspace: workspaceName };
  state.activeWorkspace = workspaceName;
  saveState(state);
}
