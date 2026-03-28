/**
 * Prompt loader — loads and interpolates templates from context/ directory.
 *
 * Each prompt file can contain a system prompt and optionally a user message
 * template, separated by "---USER---". The user template uses {{CONTENT}}
 * as a placeholder for the document content.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { CONTEXT_DIR } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────

export interface PromptPair {
  system: string;
  userTemplate: string;  // contains {{CONTENT}} placeholder
}

// ── File loading ────────────────────────────────────────────────────

export function loadContextFile(filename: string): string {
  const path = join(CONTEXT_DIR, filename);
  if (!existsSync(path)) {
    console.error(`❌ Context file not found: ${path}`);
    console.error(`   Create it or set CONTEXT_DIR in .env`);
    process.exit(1);
  }
  return readFileSync(path, "utf-8").trim();
}

/** Write a context file back to the workspace (used by refine) */
export function writeContextFile(filename: string, content: string): void {
  const path = join(CONTEXT_DIR, filename);
  writeFileSync(path, content);
}

export function interpolate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * Load a prompt file and split into system + user template.
 * If no ---USER--- separator, the entire file is the system prompt
 * and userTemplate defaults to "{{CONTENT}}".
 */
function loadPromptFile(filename: string, vars: Record<string, string>): PromptPair {
  const raw = loadContextFile(filename);
  const separator = "---USER---";
  const idx = raw.indexOf(separator);

  if (idx === -1) {
    return {
      system: interpolate(raw, vars),
      userTemplate: "{{CONTENT}}",
    };
  }

  return {
    system: interpolate(raw.slice(0, idx).trim(), vars),
    userTemplate: raw.slice(idx + separator.length).trim(),
  };
}

// ── Domain context ──────────────────────────────────────────────────

export function loadDomain(): string {
  return loadContextFile("shared/domain.md");
}

export function loadSourceTypes(): string {
  return loadContextFile("shared/source-types.md");
}

/**
 * Parse phase labels from domain.md.
 * Looks for: <!-- PHASE_LABELS: Phase 1, Phase 2, Phase 3 -->
 * Returns ["", "Phase 1", "Phase 2", "Phase 3"] (index 0 unused).
 */
export function loadPhaseLabels(): string[] {
  const domain = loadDomain();
  const match = domain.match(/<!--\s*PHASE_LABELS:\s*(.+?)\s*-->/);
  if (!match) return [""];
  return ["", ...match[1].split(",").map((s) => s.trim())];
}

/** Load shared JSON output rules */
export function loadRules(): string {
  return loadContextFile("shared/rules-json-output.md");
}

// ── Prompt builders ─────────────────────────────────────────────────

/** Build discover prompt pair (system + user template) */
export function buildDiscoverPrompt(): PromptPair {
  return loadPromptFile("discover/prompt.md", {
    DOMAIN: loadDomain(),
    SOURCE_TYPES: loadSourceTypes(),
    RULES: loadRules(),
  });
}

/** Build classify prompt pair (system + user template) */
export function buildClassifyPrompt(plan: string): PromptPair {
  return loadPromptFile("classify/prompt.md", {
    DOMAIN: loadDomain(),
    SOURCE_TYPES: loadSourceTypes(),
    PLAN: plan,
    RULES: loadRules(),
  });
}

/** Build synthesize prompt pair (system + user template) */
export function buildSynthesizePrompt(): PromptPair {
  return loadPromptFile("synthesize/prompt.md", {
    DOMAIN: loadDomain(),
    SOURCE_TYPES: loadSourceTypes(),
  });
}

/** Fill user template with actual content */
export function fillUserMessage(template: string, content: string): string {
  return template.replaceAll("{{CONTENT}}", content);
}

