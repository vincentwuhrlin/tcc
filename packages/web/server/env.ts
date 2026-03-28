/**
 * Load .env from monorepo root.
 *
 * pnpm --filter changes cwd to the package dir (packages/web/),
 * so we walk up until we find pnpm-workspace.yaml = monorepo root.
 *
 * Import this file for its side-effects before anything else:
 *   import "./env.js";
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";

function findMonorepoRoot(from: string): string {
  let dir = resolve(from);
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from; // reached filesystem root, fallback to cwd
    dir = parent;
  }
}

const root = findMonorepoRoot(process.cwd());
const envPath = join(root, ".env");

if (existsSync(envPath)) {
  let loaded = 0;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      let value = match[2].trim();
      if (!value.startsWith('"') && !value.startsWith("'")) {
        value = value.replace(/\s+#.*$/, "");
      }
      process.env[match[1].trim()] = value;
      loaded++;
    }
  }
  console.log(`📄 Loaded ${loaded} vars from ${envPath}`);
} else {
  console.warn(`⚠️  No .env found at ${envPath}`);
  console.warn(`   Create one with at least: WORKSPACE=../workspaces/noa`);
}

/** Monorepo root directory — use this to resolve relative paths from .env */
export const MONOREPO_ROOT = root;
