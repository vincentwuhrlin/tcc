# tcc — Transcript, Classify, Chat

**Lots of media files → Transcription → Classified knowledge base → Chat!**

Turn a pile of PDFs and YouTube videos into a tagged, classified knowledge base — then export it as Claude Projects bundles or chat with it locally. Domain-agnostic: swap the `context/` folder in your workspace to adapt to any topic without touching code.

---

## Quickstart

### A) I already have data — let me chat

If someone has already run the pipeline and shared a workspace (a folder with `media/`, `context/`, `bundles/`):

```bash
# 1. Clone and install
git clone <repo> && cd tcc
npm install
cp .env.example .env

# 2. Point to the workspace
#    Edit .env:
WORKSPACE=../workspaces/industrial-edge

# 3. Configure API (Anthropic or corporate UPTIMIZE)
#    Edit .env:
API_PROVIDER=anthropic
API_KEY=sk-ant-XXXXXXXXXX
API_MODEL=claude-sonnet-4-6-20250514

# 4. Chat!
npm run chat
```

That's it — you're chatting with the knowledge base. Type `/docs` to list documents, `/load filename.md` to pull a specific doc into the conversation.

### B) I need to build the data from scratch

Full pipeline — from raw PDFs/videos to a tagged knowledge base. Steps marked ✍️ require manual work.

```bash
# ─── SETUP ────────────────────────────────────────────────────────────

# 1. Clone and install
git clone <repo> && cd tcc
npm install
cp .env.example .env

# 2. Create your workspace structure
mkdir -p ../workspaces/my-project/{media/pdfs,media/videos,context/shared,context/discover,context/classify,context/synthesize,context/split,context/export,projects}

# 3. Edit .env — set WORKSPACE and API keys
WORKSPACE=../workspaces/my-project
```

#### ✍️ Step 0 — Prepare context (only `domain.md` is required)

Copy the template to your workspace:

```bash
cp -r template/* ../workspaces/my-project/context/
```

The only file you **must** write is `context/shared/domain.md` — describe your project, its key concepts, and the team context. Use Claude to help (see **"Adapting the Template"** section for a copy-paste prompt).

The other prompts are generic by default and can be **refined after the first discover pass** — `media:discover` prints a helper prompt at the end (see Step 7b).

#### Steps 1–4 — Transcription (automated)

```bash
npm run transcript:setup          # Install tools (once)
npm run gpu:create                # Spin up a GPU pod
npm run transcript                # PDFs → .md, videos → .md
npm run gpu:terminate             # Destroy pod → $0
```

#### Steps 5–6 — Processing (automated)

```bash
npm run media:stats               # Verify: how many docs, how many tokens?
npm run media:split:dry           # Preview large doc splits
npm run media:split               # Split large docs (LLM-assisted)
```

#### Step 7 — Discover (first pass)

```bash
npm run media:discover            # Analyze each doc → DISCOVERY.md
```

Produces `media/output/DISCOVERY.md` — a per-document analysis with topics, tags, quality, and suggested categories. **You don't need to edit this file**, but reading it helps understand your corpus.

#### Step 7b — Refine the discover prompt (recommended for new domains)

At the end of `media:discover`, a **refine helper prompt** is printed to the console. To use it:

1. **Copy** the printed prompt (between the `COPY FROM HERE` / `COPY TO HERE` markers)
2. **Open Claude** (claude.ai or any chat)
3. **Paste** the prompt, then **add your DISCOVERY.md** content below it
4. Claude analyzes the patterns and returns an **improved `discover/prompt.md`** with domain-specific fields
5. **Save** Claude's output as `context/discover/prompt.md`
6. **Re-run** discover:

```bash
npm run media:discover            # Pass 2 with enriched prompt → DISCOVERY.md v2
```

> 💡 **Optional but recommended.** The generic prompt works, but domain-specific fields make everything downstream more accurate.
>
> 💰 **Cost.** Each discover pass costs ~$3 per 100 docs (Sonnet, batch). The refine itself is free (Claude chat).

#### Step 7c — Align classify and synthesize prompts (optional, manual)

After enriching discover, the classify and synthesize prompts should match. Open Claude and ask:

> "Here is my new discover/prompt.md: [paste it]. Now rewrite my classify/prompt.md with the same JSON schema, but keep the `categories` field and the `{{PLAN}}` placeholder. Also keep `{{DOMAIN}}`, `{{SOURCE_TYPES}}`, `{{RULES}}`, `---USER---`, `{{CONTENT}}`."

Save the result as `context/classify/prompt.md`.

Then:

> "Here is my new discover/prompt.md: [paste it]. Rewrite my synthesize/prompt.md so the SUMMARY.md table columns and coverage analysis sections match the domain-specific fields. Keep the `===SPLIT===` marker and `{{DOMAIN}}`, `{{CONTENT}}`, `---USER---` placeholders."

Save as `context/synthesize/prompt.md`.

> 💡 This is only needed once per domain. If you skip it, synthesize and classify still work — they just won't have the enriched domain-specific fields in their output.

#### Step 8 — Synthesize (automated + manual review)

```bash
npm run media:synthesize          # Synthesize → SUMMARY.md + PLAN.md
```

Produces two files:
- `SUMMARY.md` — A catalog table of all documents with coverage analysis. **Read-only**, don't edit.
- `PLAN.md` — The classification categories derived from your corpus. **This is the key file.**

#### ✏️ Step 8b — Review PLAN.md (manual)

Open `media/output/PLAN.md` and review the generated categories. You can:
- Rename categories to match your vocabulary
- Merge or split categories
- Add categories the LLM missed
- Remove irrelevant categories
- Reorder by priority

The LLM generates a solid first draft, but **your domain expertise matters here**. This file drives all subsequent classification.

#### Step 9 — Classify (automated)

```bash
npm run media:classify            # Classify all docs → frontmatter + INDEX.md
```

Uses your (reviewed) PLAN.md to tag each document with YAML frontmatter (categories, quality, tags, summary). Also generates `INDEX.md`. Documents already tagged are skipped — safe to re-run.

#### Step 10 — Index (automated, optional)

```bash
npm run media:index               # Regenerate INDEX.md from existing tags
```

Only needed if you manually edited frontmatter. Otherwise `classify` already generates it.

#### Step 10b — (Optional) Prepare export rules

If you plan to use `bundle` to export for Claude Projects, edit these files in your workspace's `context/export/`:
- `rules-project.md` — instructions injected into each Claude Project
- `rules-hub.md` — instructions for the hub/router bundle

These are optional if you only use `npm run chat`.

#### Step 11 — Bundle (automated with auto-generation)

```bash
npm run bundle:dry                # Preview: which docs go where?
npm run bundle                    # Export → bundle folders
```

**No manual config needed!** The `bundle` command auto-generates it every time from your `PLAN.md`:
1. Reads PLAN.md sections (A, B, C...)
2. Calculates tokens per section from tagged files
3. Packs sections into bundles ≤ `BUNDLE_MAX_TOKENS` (default 200k)
4. Creates a hub bundle that routes between sub-bundles

To change the grouping, adjust `BUNDLE_MAX_TOKENS` in `.env` and re-run `bundle`.

#### Step 12 — Use your knowledge base!

**Option A: Chat locally** (uses your API config)

```bash
npm run chat                      # Interactive terminal chat
```

**Option B: Claude Projects** (Claude.ai UI)

After `bundle`, each bundle folder in `bundles/` contains:
1. `PROJECT_INSTRUCTIONS.md` — copy-paste this into the Claude Project's custom instructions
2. `data/` — upload all files in this folder to the Claude Project

For each bundle:
1. Go to [claude.ai](https://claude.ai) → Create a new Project
2. Open the project settings
3. Copy the content of `PROJECT_INSTRUCTIONS.md` into the "Custom instructions" field
4. Click "Add content" → upload all files from the `data/` folder
5. Start chatting!

Start with the **Hub** project — it routes you to the right sub-project based on your question.

---

## .env Configuration

```env
# ── Workspace ─────────────────────────────────────────────────────
WORKSPACE=../workspaces/industrial-edge
# Override per-command: npm run chat -- --workspace=../workspaces/noa

# ── Claude API ────────────────────────────────────────────────────
# Anthropic direct:
API_PROVIDER=anthropic
API_KEY=sk-ant-XXXXXXXXXX
API_MODEL=claude-sonnet-4-6-20250514
MEDIA_API_MODE=streaming            # streaming | batch (-50% cost, Anthropic only)

# Corporate UPTIMIZE (alternative):
# API_PROVIDER=uptimize
# API_BASE_URL=https://api.nlp.p.uptimize.merckgroup.com
# API_KEY=YOUR_UPTIMIZE_TOKEN
# API_MODEL=eu.anthropic.claude-sonnet-4-20250514-v1:0
# MEDIA_API_MODE=streaming          # batch NOT supported with uptimize

# ── GPU pod (RunPod) — only needed for transcript commands ────────
GPU_RUNPOD_API_KEY=rpa_XXXXXXXXXX
GPU_RUNPOD_POD_NAME=tcc
GPU_RUNPOD_SSH_KEY=~/.ssh/runpod_ed25519
GPU_RUNPOD_TYPES=NVIDIA RTX A4000,NVIDIA L4,NVIDIA GeForce RTX 3090
GPU_RUNPOD_DATACENTERS=EU-RO-1,EU-SE-1,EU-CZ-1,EU-NL-1
GPU_RUNPOD_CLOUD_TYPE=COMMUNITY

# ── Media processing ─────────────────────────────────────────────
MEDIA_FILE_MODE=full                # full | summary (cheaper, uses head+mid+tail)
MEDIA_SPLIT_THRESHOLD=200000        # chars — split docs above this
MEDIA_SPLIT_MAX_CHUNK=100000        # chars — max chunk size after split

# ── Projects export ──────────────────────────────────────────────
BUNDLE_MIN_QUALITY=medium         # exclude docs below this quality
BUNDLE_MAX_TOKENS=200000          # warn if bundle exceeds this
```

---

## Workspace Structure

```
repos/
├── tcc/                        ← the tool (git repo, npm install here)
│   ├── src/
│   │   ├── commands/                ← 1 file = 1 npm command
│   │   ├── common/                  ← shared code (llm, media, prompts)
│   │   ├── config.ts                ← env loading, workspace resolution
│   │   └── cli.ts                   ← command router
│   ├── template/                    ← example context based on NOA (copy to workspace)
│   ├── .env                         ← your config
│   └── package.json
│
└── workspaces/                      ← domain data (NOT in tcc git)
    ├── industrial-edge/             ← WORKSPACE=../workspaces/industrial-edge
    │   ├── media/                   ← source files + output .md
    │   ├── context/                 ← YOUR prompts & domain config (from template/)
    │   └── bundles/                ← bundle output (for Claude Projects or local chat)
    └── noa/                         ← WORKSPACE=../workspaces/noa
        ├── media/
        ├── context/
        └── bundles/
```

Switch workspace by editing `.env` or per-command:

```bash
npm run chat -- --workspace=../workspaces/noa
npm run media:discover -- --workspace=../workspaces/noa
```

All commands derive `media/`, `context/`, `bundles/` from `WORKSPACE` automatically. Individual overrides (`MEDIA_DIR`, `CONTEXT_DIR`, `BUNDLES_DIR`) are available in `.env` for special cases.

---

## All Commands

### Transcription (GPU-powered)

| Command | Description |
|---|---|
| `npm run transcript:setup` | Install runpodctl, yt-dlp, ffmpeg |
| `npm run transcript` | Transcribe all (documents + videos) |
| `npm run transcript:documents` | PDFs → Markdown (via marker on GPU) |
| `npm run transcript:videos` | Videos → Markdown (via whisper on GPU) |

### GPU Pod (RunPod)

| Command | Description |
|---|---|
| `npm run gpu:create` | Create GPU pod |
| `npm run gpu:status` | Check pod status |
| `npm run gpu:ssh` | Connect to pod |
| `npm run gpu:ssh -- pull` | Pull transcribed files from pod |
| `npm run gpu:start` | Resume stopped pod |
| `npm run gpu:stop` | Pause billing |
| `npm run gpu:terminate` | Destroy pod → $0 |

### Media Processing

| Command | Description |
|---|---|
| `npm run media:stats` | Show KB stats (pages, duration, tokens) |
| `npm run media:split` | Split large .md into chapters (LLM-assisted) |
| `npm run media:split:dry` | Preview splits without writing files |

### Media Tagging (Claude API)

| Command | Description |
|---|---|
| `npm run media:discover` | Discover with current prompts → `DISCOVERY.md` |
| `npm run media:synthesize` | Synthesize → `SUMMARY.md` + `PLAN.md` |
| | ✏️ Review & tweak `PLAN.md` before continuing |
| `npm run media:classify` | 3. Classify all docs → YAML frontmatter + `INDEX.md` |
| `npm run media:index` | Regenerate `INDEX.md` from existing tags (no API) |

### Bundle (export)

| Command | Description |
|---|---|
| `npm run bundle` | Export tagged docs → bundle folders |
| `npm run bundle:dry` | Preview export, no files written |

### Interactive

| Command | Description |
|---|---|
| `npm run chat` | Chat with your knowledge base |
| `npm run chat -- --workspace=...` | Chat with a different workspace |

---

## Manual Intervention Points

The pipeline is mostly automated, but there are **two required** and **one optional** moment where you step in:

| When | What | Why |
|---|---|---|
| **Before starting** | Write `context/shared/domain.md` (use Claude to help!) | The LLM needs to understand your domain |
| **After `media:synthesize`** | Review and edit `PLAN.md` | The LLM proposes categories, but you know your domain better |
| **Before `bundle`** *(optional)* | Edit `context/export/rules-*.md` | Customize instructions for Claude Projects bundles |

Everything else is auto-generated:

| File | Generated by |
|---|---|
| `discover/prompt.md`, `classify/prompt.md`, `synthesize/prompt.md`, `rules-json-output.md` | `media:discover` prints refine prompt + Claude chat |
| `DISCOVERY.md` | `media:discover` |
| `SUMMARY.md`, `PLAN.md` | `media:synthesize` |
| `INDEX.md`, YAML frontmatter | `media:classify` |
| `bundles.json` | `bundle` |

---

## Pipeline Detail

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │  PHASE 1 — Transcription (gpu:* + transcript:*)                     │
 │                                                                     │
 │  PDFs ──→ marker (GPU) ──→ .md                                     │
 │  Videos ──→ whisper (GPU) ──→ .md                                  │
 ├─────────────────────────────────────────────────────────────────────┤
 │  PHASE 2 — Processing (media:split, media:stats)                    │
 │                                                                     │
 │  Large docs → LLM analyzes structure → splits into chapters         │
 │  Prompt in context/split/prompt.md (customizable)                   │
 ├─────────────────────────────────────────────────────────────────────┤
 │  PHASE 3 — Tagging (Claude API: discover → synthesize → classify)   │
 │                                                                     │
 │  ┌──────────┐  discover   ┌──────────────┐                         │
 │  │  N .md   │ ──────────→ │ DISCOVERY.md │  per-doc JSON analysis   │
 │  │  (raw)   │  (pass 1)   │              │  topics, tags, quality   │
 │  └──────────┘             └──────┬───────┘                          │
 │                                  │ refine (manual, Claude chat)     │
 │                                  ▼                                  │
 │                           ┌──────────────┐                         │
 │                           │ 4 prompts ✨ │  enriched with domain    │
 │                           │ rewritten    │  fields from patterns    │
 │                           └──────┬───────┘                         │
 │                                  │ discover (pass 2)               │
 │                                  ▼                                  │
 │                           ┌──────────────┐                         │
 │                           │ DISCOVERY.md │  enriched version        │
 │                           └──────┬───────┘                         │
 │                                  │ synthesize                       │
 │                                  ▼                                  │
 │                           ┌──────────────┐                         │
 │                           │ SUMMARY.md   │  coverage analysis       │
 │                           │ PLAN.md      │  derived categories      │
 │                           └──────┬───────┘                         │
 │                                  │ ✏️ you review PLAN.md            │
 │                                  │ classify                         │
 │                                  ▼                                  │
 │                           ┌──────────────┐                         │
 │                           │ N .md with   │  YAML frontmatter       │
 │                           │ INDEX.md     │  knowledge base index    │
 │                           └──────────────┘                         │
 ├─────────────────────────────────────────────────────────────────────┤
 │  PHASE 4 — Export (bundle)                               │
 │                                                                     │
 │  Reads PLAN.md + tagged files → packs into bundles ≤ token budget:   │
 │  • Hub bundle (routes users to sub-bundles)                         │
 │  • Topic-specific bundles with relevant docs + instructions        │
 ├─────────────────────────────────────────────────────────────────────┤
 │  PHASE 5 — Chat (npm run chat)                                      │
 │                                                                     │
 │  Interactive terminal: loads domain.md + PLAN.md + INDEX.md         │
 │  Commands: /docs, /load filename.md, quit                           │
 └─────────────────────────────────────────────────────────────────────┘
```

---

## Context Directory

### Two folders to understand

- **`tcc/template/`** — A complete working example based on the NOA (NAMUR Open Architecture) project. Ships with the tool, never loaded at runtime.
- **`{workspace}/context/`** — Your domain-specific context. This is what the tool loads. Created by copying and adapting the template.

```bash
cp -r tcc/template/* ../workspaces/my-project/context/
```

### File map

```
context/
├── shared/
│   ├── domain.md              ← Your domain: concepts, components, phases
│   ├── source-types.md        ← Types of documents in your corpus
│   └── rules-json-output.md   ← Rules for domain-specific JSON fields
├── discover/
│   └── prompt.md              ← JSON schema for per-doc analysis
├── classify/
│   └── prompt.md              ← Same JSON schema + PLAN.md categories
├── synthesize/
│   └── prompt.md              ← How to generate SUMMARY + PLAN
├── split/
│   └── prompt.md              ← Generic (usually no changes needed)
└── export/
    ├── rules-project.md       ← Instructions for each Claude Project bundle
    └── rules-hub.md           ← Instructions for the hub bundle
```

### How files are connected

The **JSON schema** (what fields the LLM returns for each document) is shared across 3 files:

```
domain.md          → defines the vocabulary (components, phases, references...)
discover/prompt.md → uses that vocabulary in a JSON schema
classify/prompt.md → same JSON schema + adds "categories" from PLAN.md
rules-json-output.md → rules for filling the schema fields
```

**Example — NOA template:**
- `domain.md` defines: building blocks (NE175-179), standards (IEC62443...), components (security_gateway, data_diode...)
- `discover/prompt.md` has JSON field `"building_blocks": ["security_gateway"]`
- `rules-json-output.md` says: `pick from [noa_concept, security_gateway, information_model, ...]`

**Example — Industrial Edge (different domain):**
- `domain.md` would define: 3 components (IEH, IEM, IED), 3 project phases
- `discover/prompt.md` would have JSON field `"components": ["IEM", "IED"]`
- `rules-json-output.md` would say: `pick from [IEH, IEM, IED]`

---

## Adapting the Template (step-by-step guide)

When starting a new domain, you only need to write **one file manually** (`domain.md`). The prompts are then refined iteratively — `media:discover` prints a refine prompt at the end.

### Step 1 — Write `domain.md` (the only manual step, use Claude to help)

This is the foundation — it tells the LLM what your project is about. Open Claude and paste:

```
I'm building a knowledge base about [YOUR TOPIC].

My corpus contains [DESCRIBE: ~50 PDFs about X, YouTube videos about Y, etc.].

The key concepts / components / building blocks of this domain are:
- [list what you know]

The team using this KB needs to understand:
- [list the goals]

Write me a domain.md file that describes this domain for an LLM that will analyze documents about it. Include:
1. The main concepts and their relationships
2. The key components/modules/building blocks (with short descriptions)
3. The relevant standards, frameworks, or references
4. The team context (who uses this, what they need)
5. At the end, add: <!-- PHASE_LABELS: Phase 1 Name, Phase 2 Name, Phase 3 Name -->
```

Save the result as `context/shared/domain.md`.

### Step 2 — (Optional) Rough `source-types.md`

Start with a rough list of document types in your corpus. Doesn't need to be perfect — the default template works for most cases. Refine after the first discover pass.

### Step 3 — First discover pass

```bash
npm run media:discover
```

Run discover with the generic prompts. This produces DISCOVERY.md with basic fields (title, topics, tags, quality, summary).

### Step 4 — Refine your prompts (with Claude's help)

At the end of `media:discover`, a **refine helper prompt** is printed to the console. Use it:

1. **Copy** the printed prompt (between `COPY FROM HERE` / `COPY TO HERE`)
2. **Open Claude** (claude.ai)
3. **Paste** the prompt + your DISCOVERY.md
4. Claude analyzes the patterns and **generates an improved prompt** with domain-specific fields (e.g. `"components": ["IEM", "IED"]` or `"building_blocks": ["security_gateway"]`)
5. **Save** Claude's output as `context/discover/prompt.md`

Then align classify and synthesize by asking Claude directly (see Step 7c in Quickstart):

> "Here is my new discover/prompt.md: [paste]. Rewrite classify/prompt.md with the same JSON schema + keep categories and {{PLAN}}."

> "Here is my new discover/prompt.md: [paste]. Rewrite synthesize/prompt.md so SUMMARY columns match the new fields."

> 💡 **Why manual instead of automated?** You know your domain better than any LLM. The refine helper pre-builds 90% of the prompt — you just review Claude's output before saving it.

### Step 5 — Second discover pass

```bash
npm run media:discover            # Re-analyze with enriched prompts → DISCOVERY.md v2
```

### Step 6 — Continue the pipeline

```bash
npm run media:synthesize          # → SUMMARY.md + PLAN.md
# ✏️ Review PLAN.md
npm run media:classify            # → frontmatter + INDEX.md
npm run bundle                    # → bundle folders
npm run chat                      # 🎉
```

### Step 7 — Export rules (before `bundle`, optional)

Only needed if you use Claude Projects bundles:

| File | What to write |
|---|---|
| `export/rules-project.md` | Citation rules, language preference, how Claude should use the docs |
| `export/rules-hub.md` | How the hub routes between sub-bundles |

### Quick reference — what you write vs what's automated

| File | Who writes it | When |
|---|---|---|
| `domain.md` | **You** (with Claude's help) | Before anything |
| `source-types.md` | You (rough draft) | Before discover |
| `discover/prompt.md` | **You** (discover prints helper prompt + Claude) | After first discover |
| `classify/prompt.md` | **You** (ask Claude to align with discover) | After refining discover |
| `synthesize/prompt.md` | **You** (ask Claude to align with discover) | After refining discover |
| `rules-json-output.md` | **You** (Claude generates it during discover refine) | After first discover |
| `split/prompt.md` | Keep template default | — |
| `export/rules-*.md` | You | Before bundle |

### Prompt file format

All prompt files use `{{placeholders}}` replaced at runtime and a `---USER---` separator between the system prompt and user message:

```markdown
You are an expert analyst.

{{DOMAIN}}

Return JSON: { "title": "...", "your_field": [...] }
{{RULES}}

---USER---
Analyze this document:

{{CONTENT}}
```

---

## Tagging Schema

Each tagged document gets a YAML frontmatter:

```yaml
---
title: "Edge Device Runtime Architecture"
source_type: technical_manual
components:
  - IED
  - IEM
project_phases:
  - 1
  - 2
quality: high
language: en
categories:
  - A.2
  - B.1
tags:
  - docker-runtime
  - databus-mqtt
  - app-deployment
summary: "Describes the IED runtime architecture including Docker containers, Databus..."
key_facts:
  - "Apps run as Docker containers managed by IEM"
  - "Databus uses MQTT for inter-app communication"
tagged_at: "2025-03-26T14:30:00.000Z"
---
```

Fields like `categories`, `components`, `project_phases` are defined in your `context/` — they adapt to your domain.

---

## Media Directory Structure

```
media/
├── pdfs/                     ← source PDFs (input)
├── videos/
│   └── videos.md             ← YouTube URLs with [x] checkboxes
├── cookies/                  ← optional YouTube cookies for private videos
├── audio/                    ← downloaded mp3s (intermediate)
└── output/
    ├── documents/            ← .md from PDFs (small docs stay here)
    │   ├── splits/           ← split chunks from large docs
    │   └── originals/        ← backup of large docs before split
    ├── videos/               ← .md from audio transcriptions
    ├── DISCOVERY.md          ← per-doc topic exploration (step 7)
    ├── SUMMARY.md            ← catalog + coverage analysis (step 8)
    ├── PLAN.md               ← classification categories (step 8, editable)
    └── INDEX.md              ← classified knowledge base index (step 9)
```

---

## API Modes

| | Streaming | Batch |
|---|---|---|
| **How it works** | 1 API call per document, real-time progress | Submit all at once, poll until done |
| **Cost** | Standard pricing | -50% (Anthropic discount) |
| **Providers** | Anthropic ✅, UPTIMIZE ✅ | Anthropic ✅, UPTIMIZE ❌ |
| **Timeout risk** | None (streaming keeps connection alive) | None (async processing) |
| **Progress** | `[42/287] file.md... 🟢 Title` | `⏳ 150/287 done (52%)` |
| **Resume** | Ctrl+C → relance, skips already tagged | Must restart full batch |
| **Set in .env** | `MEDIA_API_MODE=streaming` | `MEDIA_API_MODE=batch` |

---

## Typical Costs (~100 docs, Claude Sonnet)

| Step | Tool | Streaming | Batch (-50%) |
|---|---|---|---|
| GPU pod (1h) | RunPod | ~$2 | ~$2 |
| Discover | Claude API | ~$6 | ~$3 |
| Synthesize | Claude API | ~$0.20 | ~$0.20 |
| Classify | Claude API | ~$6 | ~$3 |
| Split (LLM) | Claude API | ~$0.50 | ~$0.50 |
| **Total** | | **~$15** | **~$9** |

On UPTIMIZE (corporate): **$0** (streaming only, included in corporate license).

---

## Dependencies

```json
{
  "ai": "^4.0.0",              // Vercel AI SDK — provider abstraction
  "@ai-sdk/anthropic": "^1.0.0",  // Anthropic provider
  "@ai-sdk/openai": "^1.0.0",     // OpenAI-compatible provider (UPTIMIZE)
  "tsx": "^4.19.0",                // TypeScript execution
  "typescript": "^5.7.0"
}
```

No other runtime dependencies. RunPod tools (runpodctl, yt-dlp, ffmpeg) are installed by `transcript:setup`.
