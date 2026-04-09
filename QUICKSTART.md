# TCC — Quickstart

**English** · [Français](./QUICKSTART.fr.md)

Get a chat-ready knowledge base running on your machine in **under 5 minutes**, using a pre-built workspace.

For a deeper tour of the project, see [README.md](./README.md).

## Prerequisites

- **Node.js 20+** and **pnpm 10+**
- A valid **UPTIMIZE API key** (Merck internal proxy for Claude) — or an Anthropic direct key
- A pre-built workspace zip (e.g. `noa-<date>.zip`, `industrial-edge-<date>.zip`) shared by the team

> Don't have a pre-built workspace? You can also build your own from PDFs and videos — see the *full pipeline* section at the bottom.

## Install in 4 steps

```powershell
# 1. Clone the repo
git clone https://dev.azure.com/Inno-Software/Portfolio-Prioritization-Process/_git/transcript-classify-and-chat
cd transcript-classify-and-chat
pnpm install
# First install builds better-sqlite3, onnxruntime-node and sharp — approve when prompted.

# 2. Configure environment
copy .env.quickstart .env
# Edit .env:
#   • paste your UPTIMIZE key in API_KEY=
#   • set WORKSPACE=<name> to match the workspace folder you'll use (default: noa)

# 3. Unzip the workspace into workspaces/
# Resulting path: transcript-classify-and-chat/workspaces/<name>/
#                                                          ├─ media/
#                                                          ├─ context/
#                                                          ├─ workspace.json
#                                                          └─ workspace.db

# 4. Start TCC
pnpm run chat
```

Then open <http://localhost:3000>.

> **First boot**: TCC downloads the embedding model `nomic-local` (~274 MB, one-time). Subsequent starts are instant.

## What you get

- **`pnpm run chat`** runs both the Hono API (`:3001`) and the Vite UI (`:3000`) concurrently.
- The web UI lets you switch between any workspaces present in `workspaces/` — `.env`'s `WORKSPACE` value is just the initial default.
- Sessions, memories, and Q&A edits are persisted **locally** in `workspaces/<name>/workspace.db`. Nothing is uploaded.
- The debug panel shows you exactly which chunks fed each answer (top-K, deep search sub-queries, focus mode).

## Workspace configuration

Two variables in `.env` decide where TCC looks for workspaces:

- **`WORKSPACES_DIR`** — parent directory containing all workspaces (default: `workspaces`, relative to the repo root). Only change this if you keep workspaces outside the repo.
- **`WORKSPACE`** — name of the active workspace subdirectory. Must match the folder name inside `WORKSPACES_DIR`.

The `.env.quickstart` template defaults to `WORKSPACE=noa`. If you imported `industrial-edge` instead, change it accordingly — or just switch from the workspace dropdown in the UI.

## Common commands

```powershell
# Web chat (from repo root)
pnpm run chat                  # server + client → http://localhost:3000
pnpm run chat:server           # API only on :3001
pnpm run chat:client           # UI only on :3000

# Terminal chat against the active workspace
pnpm --filter @tcc/core chat

# Stats and utilities
pnpm --filter @tcc/core media:stats           # KB metrics: pages, duration, tokens
pnpm --filter @tcc/core media:embed:stats     # vectors per model / DTYPE
pnpm --filter @tcc/core uptimize:stats        # UPTIMIZE spend + status
```

## Sharing your improved workspace

If you've added media, edited Q&A, or pinned categories and want to share the result:

```powershell
pnpm --filter @tcc/core workspace:clean -- --workspace=<name> --with-qa
pnpm --filter @tcc/core workspace:zip   -- --workspace=<name>
# Zip lands in workspaces/<name>-<date>.zip — upload it to the team drive
```

`workspace:clean --with-qa` strips sessions, memories, embeddings and QA edits before zipping, so the recipient gets a clean snapshot.

## Building your own workspace from raw media

If you don't have a pre-built workspace and want to ingest your own PDFs / videos, the full pipeline is:

```bash
pnpm --filter @tcc/core transcript:setup        # 0. install runpodctl, yt-dlp, ffmpeg
pnpm --filter @tcc/core transcript              # 1. transcribe PDFs + videos → .md
pnpm --filter @tcc/core media:discover          # 2. extract topics → DISCOVERY.md
pnpm --filter @tcc/core media:synthesize        # 3. SUMMARY.md + PLAN.md
pnpm --filter @tcc/core media:split             # 4. chunk documents
pnpm --filter @tcc/core media:classify          # 5. category frontmatter + INDEX.md
pnpm --filter @tcc/core media:embed             # 6. vectors → workspace.db
pnpm run chat                                   # 7. enjoy
```

Each command is **idempotent and resumable** — `--force` re-processes everything, `--dry-run` previews. See [README.md](./README.md) for what each phase does in detail.

## Troubleshooting

| Symptom                                              | Fix                                                                 |
|------------------------------------------------------|---------------------------------------------------------------------|
| `pnpm install` skips native module builds            | Re-run with build approval; modules are listed in `pnpm.onlyBuiltDependencies` |
| Web UI loads but answers say "no chunks found"       | Wrong `WORKSPACE` in `.env`, or `media:embed` was never run         |
| `Cannot find .env`                                   | The `.env` must sit next to `pnpm-workspace.yaml` at the repo root  |
| First chat is slow                                   | Embedding model is downloading (~274 MB) and warming up (~5 s)      |
| `workspace:zip` is huge                              | Use the default (slim) zip, not `--full`, when sharing              |

## Privacy

Chat sessions, memories, and Q&A edits stay **on your machine only** in `workspaces/<name>/workspace.db`. The only network calls TCC makes are LLM requests (and optionally embedding requests if you choose `nomic-uptimize`).

## Questions?

Ping Vincent or check the [README](./README.md) for the full architecture.
