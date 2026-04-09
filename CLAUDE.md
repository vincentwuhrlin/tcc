# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**TCC** (Transcript, Classify & Chat) is a monorepo for processing media (PDFs, videos) into searchable knowledge bases with RAG-powered chat. It runs a multi-stage pipeline: transcribe media → discover topics → synthesize summaries → classify with YAML frontmatter → split into chunks → embed vectors → chat via terminal or web UI.

## Prerequisites

- **Node** ≥ 20 (see root `package.json` `engines`)
- **pnpm** 10.33.0 (pinned via `packageManager`)
- Native modules that need build approval on first install: `better-sqlite3`, `onnxruntime-node`, `sharp` (listed in root `pnpm.onlyBuiltDependencies`)
- `.env` at the monorepo root — `config.ts` walks up to find `pnpm-workspace.yaml` and loads `.env` from there. A starter file exists at `.env.quickstart`.
- There is **no test suite, linter, or formatter configured** in this repo — do not invent `pnpm test`/`pnpm lint` commands. TypeScript is executed directly via `tsx` (no build step for `@tcc/core`).

## Monorepo Structure

- **`packages/core`** (`@tcc/core`) — CLI tool with 25+ commands for the media processing pipeline and terminal chat. Entry point: `src/cli.ts` (command registry). Subdirs: `commands/`, `common/` (shared modules: `db`, `llm`, `rag`, `embed/`, `prompts`, `history`, `media`, `toc-parser`), `scripts/` (one-off maintenance scripts), plus `config.ts`, `preflight.ts`, `state.ts`, `runpod.ts`/`runpodctl.ts`/`ssh.ts` (GPU pod automation).
- **`packages/web`** (`@tcc/web`) — Full-stack web UI. React 19 frontend (Vite) + Hono API server (Node.js). `server/` has `index.ts`, `sessions.ts`, `workspace.ts`, `workspace-manager.ts`, `state.ts`, `env.ts`. Depends on `@tcc/core` for shared modules (config, db, rag, llm, embed).
- **`templates/context/`** — Prompt templates grouped by pipeline stage: `discover/`, `synthesize/`, `classify/`, `split/`, `chat/`, `shared/`. Uses `{{PLACEHOLDER}}` interpolation and `---USER---` separator for system/user message split. A workspace may override any template via its own `context/` directory.
- **`workspaces/`** — Isolated knowledge bases. Each workspace has `media/`, `context/` (optional overrides), `workspace.json`, `workspace.db` (SQLite), and pipeline outputs (`DISCOVERY.md`, `SUMMARY.md`, `PLAN.md`, `INDEX.md`, etc.).

## Commands

Root scripts (`package.json`) only cover the web app. All pipeline/CLI commands live in `packages/core/package.json` and must be run from `packages/core/` **or** via `pnpm --filter @tcc/core <script>`.

```bash
# Install dependencies (first run will build better-sqlite3, onnxruntime-node, sharp)
pnpm install

# ── Web chat (from repo root) ──────────────────────────────────────
pnpm chat                        # server + client concurrently → http://localhost:3000
pnpm chat:server                 # Hono API on :3001
pnpm chat:client                 # Vite dev on :3000
pnpm chat:build                  # Vite production build

# ── Transcription (local tools: yt-dlp, ffmpeg, runpodctl) ─────────
pnpm --filter @tcc/core transcript:setup       # install the local tools
pnpm --filter @tcc/core transcript             # documents + videos → Markdown
pnpm --filter @tcc/core transcript:documents   # PDFs only
pnpm --filter @tcc/core transcript:videos      # videos only

# ── Media pipeline (run in this order after transcription) ─────────
pnpm --filter @tcc/core media:discover         # 1. topics → DISCOVERY.md
pnpm --filter @tcc/core media:synthesize       # 2. SUMMARY.md + PLAN.md
pnpm --filter @tcc/core media:classify         # 3. YAML frontmatter + INDEX.md
pnpm --filter @tcc/core media:split            # 4. chunk docs (supports --dry-run, split:check, split:undo)
pnpm --filter @tcc/core media:embed            # 5. vector embeddings → workspace.db
pnpm --filter @tcc/core media:embed:gpu        # embed on a RunPod GPU pod end-to-end
pnpm --filter @tcc/core media:embed:bench      # benchmark engines on a query set
pnpm --filter @tcc/core media:embed:import     # import embeddings from another workspace.db
pnpm --filter @tcc/core media:embed:stats      # stats per model/DTYPE
pnpm --filter @tcc/core media:stats            # KB metrics (pages, duration, tokens)

# ── GPU pod lifecycle (RunPod) ─────────────────────────────────────
pnpm --filter @tcc/core gpu:create | gpu:status | gpu:ssh | gpu:start | gpu:stop | gpu:terminate

# ── Workspace management (these commands require --workspace=<name>) ──
pnpm --filter @tcc/core workspace:clean -- --workspace=<name>          # strip dynamic data
pnpm --filter @tcc/core workspace:clean:dry -- --workspace=<name>      # preview
pnpm --filter @tcc/core workspace:clean:with-qa -- --workspace=<name>  # also wipe QA + embeddings
pnpm --filter @tcc/core workspace:zip -- --workspace=<name>            # slim zip for sharing
pnpm --filter @tcc/core workspace:zip:full -- --workspace=<name>       # include raw media

# ── Interactive / utilities ────────────────────────────────────────
pnpm --filter @tcc/core chat                   # terminal chat against the active workspace
pnpm --filter @tcc/core uptimize:stats         # UPTIMIZE API spend + status
```

**Workspace selection**: every CLI command resolves the active workspace as `WORKSPACES_DIR/WORKSPACE` from `.env`, and the `--workspace=<name>` flag overrides `WORKSPACE` for a single invocation. When passing the flag through `pnpm --filter`, remember the `--` separator so pnpm forwards the arg: `pnpm --filter @tcc/core media:embed -- --workspace=industrial-edge`.

**Flags**: commands are idempotent/resumable where possible (e.g. `embed` skips already-embedded chunks). `--force` re-processes everything; `--dry-run` previews without writing. `discover`, `classify`, `embed`, `workspace:clean` all expose `:force`/`:dry` script variants.

All core CLI scripts invoke `tsx src/cli.ts <command>`; the command registry is in `packages/core/src/cli.ts`. A few commands are registered in `cli.ts` but have no pnpm script wrapper (e.g. `export`) — invoke them directly with `pnpm --filter @tcc/core exec tsx src/cli.ts <command>`.

## Architecture

### Configuration (`packages/core/src/config.ts`)

Central config loaded from `.env` at monorepo root (found by walking up to `pnpm-workspace.yaml`). Key env vars: `WORKSPACES_DIR` (default `workspaces/`), `WORKSPACE` (active workspace name; overridden by `--workspace=<name>`), plus the `API_*` / `CHAT_API_*` / `MEDIA_EMBED_*` / `CHAT_EMBED_*` credential sets. Uses a fallback chain:
- `CHAT_API_*` → `API_*` (chat LLM falls back to media pipeline LLM)
- `CHAT_EMBED_*` → `MEDIA_EMBED_*` (chat embedding falls back to media embedding)
- `MEDIA_EMBED_API_*` → `API_*` (embedding API creds fall back to main API creds)

The `.env.quickstart` file at the repo root is a starter template — copy to `.env` and fill in credentials.

### LLM (`packages/core/src/common/llm.ts`)

Uses Vercel AI SDK. Supports two providers: `anthropic` (direct, supports batch mode at -50% cost) and `uptimize` (OpenAI-compatible proxy). The `llmCall()` function handles provider selection, streaming/batch modes, and token usage tracking. Chat and media pipeline can use independent LLM configs.

### Embedding (`packages/core/src/common/embed/`)

Factory pattern with dual singletons (one for media corpus, one for chat queries). Three engines: `nomic-uptimize` (API), `nomic-local` (ONNX CPU), `jina-local` (ONNX CPU). Local models have ~5s warmup on first load. DTYPE suffix stored in model name so different quantizations coexist in DB.

### RAG (`packages/core/src/common/rag.ts`)

Loads all embeddings into memory from SQLite. Cosine similarity search with top-K filtering and minimum score threshold. Supports "deep search" (LLM generates sub-queries for multi-pass retrieval) and "focus mode" (load all chunks from a category).

### Database (`packages/core/src/common/db.ts`)

SQLite via `better-sqlite3` with WAL mode. Singleton per workspace. Tables: `embeddings`, `sessions`, `messages`, `token_usage`, `memories`, `app_settings`, `message_embeddings`. Has a migration system for schema upgrades.

### Prompt Templates (`packages/core/src/common/prompts.ts`)

Loads Markdown templates from `templates/context/` (or workspace-local `context/` overrides). Templates use `{{PLACEHOLDER}}` interpolation. The `---USER---` marker splits system vs user message content.

### Web Server (`packages/web/server/index.ts`)

Hono API with SSE streaming for chat responses. Multi-layer system prompt: instructions → domain → memories → plan categories → RAG chunks → session summary → recent messages. Session compaction summarizes old messages when history exceeds a configurable token threshold.

### Web Frontend (`packages/web/src/`)

React 19 SPA. Key components: `App.tsx` (workspace/session management), `Chat.tsx` (chat interface with streaming), `Sidebar.tsx` (session list), `SettingsModal.tsx` (preferences), `DebugPanel.tsx` (RAG debug info).

## Key Conventions

- All packages use ESM (`"type": "module"`).
- TypeScript with `tsx` for direct execution (no separate build step for core).
- pnpm workspaces managed via `pnpm-workspace.yaml`.
- YAML frontmatter on Markdown files is the standard metadata format throughout the pipeline.
- Commands are idempotent/resumable where possible (e.g., `embed` skips already-embedded chunks).
- The `--force` flag re-processes all files; `--dry-run` previews without writing.