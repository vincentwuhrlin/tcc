# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**TCC** (Transcript, Classify & Chat) is a monorepo for processing media (PDFs, videos) into searchable knowledge bases with RAG-powered chat. It runs a multi-stage pipeline: ingest media → discover topics → synthesize summaries → classify with YAML frontmatter → split into chunks → embed vectors → chat via terminal or web UI.

## Monorepo Structure

- **`packages/core`** (`@tcc/core`) — CLI tool with 25+ commands for the media processing pipeline and terminal chat. Entry point: `src/cli.ts`.
- **`packages/web`** (`@tcc/web`) — Full-stack web UI. React 19 frontend (Vite) + Hono API server (Node.js). Depends on `@tcc/core` for shared modules (config, db, rag, llm, embed).
- **`templates/context/`** — Prompt templates used by pipeline commands and chat. Uses `{{PLACEHOLDER}}` interpolation and `---USER---` separator for system/user message split.
- **`workspaces/`** — Isolated knowledge bases. Each workspace has `media/`, `context/`, `bundles/`, and `workspace.db` (SQLite).

## Commands

```bash
# Install dependencies
pnpm install

# Run web chat (server + client concurrently)
pnpm chat                        # opens at http://localhost:3000

# Run individual web servers
pnpm chat:server                 # Hono API on :3001
pnpm chat:client                 # Vite dev on :3000

# Core CLI commands (run from packages/core/)
pnpm media:discover              # Extract topics from media files → DISCOVERY.md
pnpm media:synthesize            # Generate SUMMARY.md + PLAN.md
pnpm media:classify              # Add YAML frontmatter + INDEX.md
pnpm media:split                 # Chunk documents for RAG
pnpm media:split --dry-run       # Preview chunking without writing
pnpm media:embed                 # Generate vector embeddings → workspace.db
pnpm media:embed:stats           # Show embedding stats per model
pnpm media:stats                 # Show KB metrics (pages, duration, tokens)

# Terminal chat
pnpm --filter @tcc/core chat
```

All core CLI scripts invoke `tsx src/cli.ts <command>`. The `--workspace=<name>` flag overrides the `WORKSPACE` env var.

## Architecture

### Configuration (`packages/core/src/config.ts`)

Central config loaded from `.env` at monorepo root (found by walking up to `pnpm-workspace.yaml`). Uses a fallback chain:
- `CHAT_API_*` → `API_*` (chat LLM falls back to media pipeline LLM)
- `CHAT_EMBED_*` → `MEDIA_EMBED_*` (chat embedding falls back to media embedding)
- `MEDIA_EMBED_API_*` → `API_*` (embedding API creds fall back to main API creds)

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