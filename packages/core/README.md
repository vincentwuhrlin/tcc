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
mkdir -p ../workspaces/my-project/{media/pdfs,media/videos,context/shared,context/discover,context/classify,context/synthesize,context/export,bundles}

# 3. Edit .env — set WORKSPACE and API keys
WORKSPACE=../workspaces/my-project
```

#### ✍️ Step 0 — Prepare context (only `domain.md` is required)

Copy the template to your workspace:

```bash
cp -r template/* ../workspaces/my-project/context/
```

The only file you **must** write is `context/shared/domain.md` — describe your project, its key concepts, and the team context. Use Claude to help (see **"Adapting the Template"** section below).

The other context files (`source-types.md`, `rules-json-output.md`, `discover/prompt.md`) have sensible defaults and can be refined after the first discover pass.

#### Steps 1–4 — Transcription (automated)

```bash
npm run transcript:setup          # Install tools (once)
npm run gpu:create                # Spin up a GPU pod
npm run transcript                # PDFs → .md, videos → .md
npm run gpu:terminate             # Destroy pod → $0
```

#### Step 5 — Stats (verify your corpus)

```bash
npm run media:stats               # How many docs, how many tokens?
```

#### Step 6 — Discover (the core step)

```bash
npm run media:discover            # Analyze each source → inject frontmatter + DISCOVERY.md
```

This is where the magic happens. For each of the 174 source files, discover:

1. **Parses** `> Source/Pages/Duration/Language` headers from the raw .md
2. **Detects language** via `franc-min` (fallback if whisper didn't set it)
3. **Sends content to the LLM** — small files go as-is, large files (>100k tokens) are split by TOC top-level sections (one LLM call per section, results merged)
4. **Injects YAML frontmatter** into the source file — absorbs the `>` headers + LLM results (title, tags, summary, components, quality, evaluation_step…)
5. **Generates `DISCOVERY.md`** from all frontmatters (aggregation, zero LLM)

**Key properties:**
- **Idempotent**: files with `discovered_at:` in frontmatter are skipped. Safe to re-run after a crash or when adding new files.
- **Force mode**: `npm run media:discover:force` re-processes all files (replaces existing frontmatters).
- **Generic**: the code doesn't know the field names — they come from the prompt. Change `context/discover/prompt.md` to add/remove fields, zero code changes.
- **Smart splitting**: docs >400k chars are split by TOC chapters. If a chapter exceeds the limit, it's split by sub-chapters. Result: ~200 LLM calls for 174 sources instead of 5000+.

**Output example** (injected frontmatter):

```yaml
---
title: "Network Concept for Discrete Manufacturing"
source_type: network_concept
source_file: 109802750_NetworkConcept_FA_V2.0_en.md
source_dir: documents
source_origin: ..\media\pdfs\109802750_NetworkConcept_FA_V2.0_en.pdf
source_pages: 253
source_language: en
components:
  - iem
  - ied
  - ieh
connectors:
  - opcua_connector
  - mqtt_connector
standards:
  - IEC62443
  - PROFINET
topics:
  - industrial network architecture and segmentation
  - IEC 62443 zone and conduit model
tags:
  - network-segmentation-zones-conduits
  - scalance-sc600-cell-firewall
  - dmz-ot-network
quality: high
evaluation_step:
  - 1
  - 2
  - 3
suggested_category: "Network & Firewall Architecture"
summary: "This document introduces a network concept for discrete manufacturing..."
key_facts:
  - "MRP ring redundancy failover time: less than 200 ms"
  - "Industrial Edge device must NOT be dual-homed"
discovered_at: "2026-03-28T03:02:20.846Z"
---
```

The `>` headers are gone from the body — everything is in the frontmatter.

#### Step 6b — Review DISCOVERY.md (optional, recommended)

Open `media/output/DISCOVERY.md`. This is a human-readable report aggregated from all frontmatters — component coverage, evaluation step distribution, suggested categories, tag cloud. Useful for sanity-checking before synthesize.

DISCOVERY.md is **not required** by any downstream command — it's a debug/review tool. It can be regenerated anytime by running discover again.

#### Step 7 — Synthesize (automated + manual review)

```bash
npm run media:synthesize          # Read frontmatters → SUMMARY.md + PLAN.md
```

Produces two files:
- `SUMMARY.md` — A catalog table of all documents with coverage analysis. **Read-only**, don't edit.
- `PLAN.md` — The classification categories derived from your corpus. **This is the key file.**

> Note: `synthesize` reads frontmatters directly from the source files, not from DISCOVERY.md.

#### ✏️ Step 7b — Review PLAN.md (manual)

Open `media/output/PLAN.md` and review the generated categories. You can:
- Rename categories to match your vocabulary
- Merge or split categories
- Add categories the LLM missed
- Remove irrelevant categories
- Reorder by priority

The LLM generates a solid first draft, but **your domain expertise matters here**. This file drives all subsequent classification.

#### Step 8 — Classify (automated)

```bash
npm run media:classify            # Add categories to each source → frontmatter + INDEX.md
```

Uses your (reviewed) PLAN.md to add `categories` to each document's existing frontmatter. Also generates `INDEX.md`. Documents already classified are skipped — safe to re-run.

#### Step 9 — Split (automated, deterministic, zero LLM)

```bash
npm run media:split:dry           # Preview: how many chunks, any oversized?
npm run media:split               # Split sources into RAG-sized chunks
```

Split happens **after** discover and classify so that chunks inherit the full frontmatter (title, tags, components, evaluation_step, categories…).

**How it works:**
- **Documents**: 3-level TOC parser extracts structure (TOC table → body headings → LLM fallback). Each section becomes a chunk with inherited frontmatter and breadcrumb path.
- **Videos**: LLM segments transcript into thematic chunks with title + summary.
- **Oversized sections**: auto-split at paragraph boundaries.
- **Oversized preambles**: split into `Preamble (part 1/N)`.
- **Single-chunk files** (no structure, e.g. `llms.txt`): split into `Chunk (part 1/N)`.
- **Language detection**: `franc-min` on all sources, propagated to chunks via `source_language`.

**Quality metrics from Industrial Edge corpus:**
- 174 sources → 5,035 chunks
- 63 files with TOC at 100% quality
- 0 oversized chunks (all within 200-1500 tokens)
- Zero LLM calls for documents (TOC parser handles everything)

#### Step 10 — Bundle (automated)

```bash
npm run bundle:dry                # Preview: which docs go where?
npm run bundle                    # Export → bundle folders
```

**No manual config needed!** The `bundle` command auto-generates it every time from your `PLAN.md`:
1. Reads PLAN.md sections
2. Calculates tokens per section from tagged files
3. Packs sections into bundles ≤ `BUNDLE_MAX_TOKENS` (default 200k)
4. Creates a hub bundle that routes between sub-bundles

#### Step 11 — Use your knowledge base!

**Option A: Chat locally** (uses your API config)

```bash
npm run chat                      # Interactive terminal chat
```

**Option B: Claude Projects** (Claude.ai UI)

After `bundle`, each bundle folder in `bundles/` contains:
1. `PROJECT_INSTRUCTIONS.md` — copy-paste this into the Claude Project's custom instructions
2. `data/` — upload all files in this folder to the Claude Project

---

## Pipeline Summary

```
transcript    → PDFs/videos → raw .md files
media:discover → LLM analysis → frontmatter YAML injected into each source
                               + DISCOVERY.md (aggregated report, no LLM)
media:synthesize → read frontmatters → SUMMARY.md + PLAN.md
                                       ✏️ review PLAN.md
media:classify → PLAN.md + LLM → add categories to frontmatter + INDEX.md
media:split    → TOC parser → chunks inherit full frontmatter (zero LLM)
bundle         → PLAN.md + tagged files → packed bundles for Claude Projects
chat           → interactive terminal with knowledge base
```

**Key design decisions:**
- Discover runs before split — so chunks inherit rich frontmatter
- DISCOVERY.md is a derived report, not a dependency — regenerable anytime
- Split is deterministic, zero LLM — the TOC parser handles all document structure
- All code is domain-agnostic — field names come from `context/` prompts, not from TypeScript interfaces

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
# API_MODEL=eu.anthropic.claude-sonnet-4-6
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
MEDIA_SPLIT_MAX_CHUNK=6000          # chars — max chunk size (default ~1500 tokens)
MAX_DISCOVER_CHARS=400000           # chars — above this, discover splits by TOC
MAX_SECTION_CHARS=400000            # chars — max section size for discover splitting

# ── Bundle export ─────────────────────────────────────────────────
BUNDLE_MIN_QUALITY=medium           # exclude docs below this quality
BUNDLE_MAX_TOKENS=200000            # warn if bundle exceeds this
```

---

## Workspace Structure

```
repos/
├── tcc/                        ← the tool (git repo, npm install here)
│   ├── src/
│   │   ├── commands/                ← 1 file = 1 npm command
│   │   ├── common/                  ← shared code (llm, media, prompts, toc-parser)
│   │   ├── config.ts                ← env loading, workspace resolution
│   │   └── cli.ts                   ← command router
│   ├── template/                    ← example context (copy to workspace)
│   ├── .env                         ← your config
│   └── package.json
│
└── workspaces/                      ← domain data (NOT in tcc git)
    ├── industrial-edge/             ← WORKSPACE=../workspaces/industrial-edge
    │   ├── media/                   ← source files + output .md
    │   ├── context/                 ← YOUR prompts & domain config
    │   └── bundles/                 ← bundle output
    └── noa/                         ← WORKSPACE=../workspaces/noa
        ├── media/
        ├── context/
        └── bundles/
```

Switch workspace by editing `.env` or per-command:

```bash
npm run chat -- --workspace=../workspaces/noa
```

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
| `npm run media:discover` | Discover topics → inject frontmatter + `DISCOVERY.md` |
| `npm run media:discover:force` | Re-discover all files (overwrite existing frontmatter) |
| `npm run media:synthesize` | Read frontmatters → `SUMMARY.md` + `PLAN.md` |
| | ✏️ Review & tweak `PLAN.md` before continuing |
| `npm run media:classify` | Add categories from PLAN.md → frontmatter + `INDEX.md` |
| `npm run media:index` | Regenerate `INDEX.md` from existing tags (no API) |
| `npm run media:split` | Split sources into RAG-sized chunks (deterministic, no LLM) |
| `npm run media:split:dry` | Preview splits without writing files |
| `npm run media:split:check` | Audit existing chunks |
| `npm run media:split:undo` | Delete all chunks |

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

## Context Directory

### Two folders to understand

- **`tcc/template/`** — A complete working example. Ships with the tool, never loaded at runtime.
- **`{workspace}/context/`** — Your domain-specific context. This is what the tool loads.

```bash
cp -r tcc/template/* ../workspaces/my-project/context/
```

### File map

```
context/
├── shared/
│   ├── domain.md              ← Your domain: concepts, components, team context
│   ├── source-types.md        ← Types of documents in your corpus
│   └── rules-json-output.md   ← Rules for domain-specific JSON fields
├── discover/
│   └── prompt.md              ← JSON schema for per-doc analysis
├── classify/
│   └── prompt.md              ← Same JSON schema + PLAN.md categories
├── synthesize/
│   └── prompt.md              ← How to generate SUMMARY + PLAN
└── export/
    ├── rules-project.md       ← Instructions for each Claude Project bundle
    └── rules-hub.md           ← Instructions for the hub bundle
```

### How files are connected

The **JSON schema** (what fields the LLM returns for each document) is defined entirely in `context/` — the TypeScript code is generic:

```
domain.md          → vocabulary (components, steps, standards…)
discover/prompt.md → JSON schema using that vocabulary
classify/prompt.md → same schema + adds "categories" from PLAN.md
rules-json-output.md → rules for filling each field
```

The code writes whatever the LLM returns — add a `"protocols"` field to your prompt, it appears in the frontmatter automatically.

### Labeled fields (numeric arrays with human-readable labels)

Add a comment in `domain.md` to map numeric values to labels:

```markdown
<!-- LABELED_FIELD: evaluation_step: Technical Assessment, Scalability & Licensing, IT-on-OT Apps -->
```

This makes `DISCOVERY.md` display `1 (Technical Assessment)` instead of just `1`. The field name is generic — works for `evaluation_step`, `project_phase`, `priority_level`, or any numeric array field you define in your prompt.

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
    ├── documents/            ← .md from PDFs (with frontmatter after discover)
    │   └── chunks/           ← split chunks (after media:split)
    ├── videos/               ← .md from transcriptions (with frontmatter after discover)
    │   └── chunks/           ← split chunks (after media:split)
    ├── DISCOVERY.md          ← aggregated report from all frontmatters
    ├── SUMMARY.md            ← catalog + coverage analysis
    ├── PLAN.md               ← classification categories (editable)
    └── INDEX.md              ← classified knowledge base index
```

---

## Split Details

The split command produces RAG-sized chunks from source files. It runs **after** discover and classify so chunks inherit the full frontmatter.

### TOC Parser (3-level strategy for documents)

1. **Level 1**: Parse the TOC table that marker generates from the PDF's own Table of Contents
2. **Level 2**: Fall back to numbered headings in the body (`# **2.1 Title**`)
3. **Level 3**: LLM normalization (last resort, rarely needed)

The parser handles edge cases: multi-page TOCs, `<br>`-compacted cells (15 sections in one cell), broken columns. Orphan sections (sections without titles in `<br>` cells) are filled from body headings.

### Chunk output

Each chunk gets a YAML frontmatter with source metadata + section context:

```yaml
---
source_file: CloudConnectorenUS_en-US.md
source_type: documents
source_pages: 42
source_language: en
chunk_index: 28
chunk_total: 47
section: 4.3.9
path: "Configuring the TIA Portal Cloud Connector / Using certificates / Selecting certificate"
chars: 1898
tokens_approx: 475
---
```

### Oversized content handling

- **Oversized sections** (>6000 chars): split at paragraph boundaries → `Section Title (part 1/N)`
- **Oversized preambles**: split → `Preamble (part 1/N)`
- **Oversized single-chunk files** (no headings, e.g. `llms.txt` at 72k tokens): split → `Chunk (part 1/N)`

### Video chunking

Videos are segmented by the LLM into thematic chunks (5-20 segments per video). Each chunk gets `title` and `summary` from the LLM. Short videos (<2k tokens) stay as single chunks.

---

## API Modes

| | Streaming | Batch |
|---|---|---|
| **How it works** | 1 API call per document, real-time progress | Submit all at once, poll until done |
| **Cost** | Standard pricing | -50% (Anthropic discount) |
| **Providers** | Anthropic ✅, UPTIMIZE ✅ | Anthropic ✅, UPTIMIZE ❌ |
| **Progress** | `[42/174] file.md... 🟢 Title` | `⏳ 150/174 done (52%)` |
| **Resume** | Ctrl+C → relance, skips already tagged | Must restart full batch |
| **Set in .env** | `MEDIA_API_MODE=streaming` | `MEDIA_API_MODE=batch` |

---

## Typical Costs (~174 sources, Claude Sonnet)

| Step | LLM calls | Streaming | Batch (-50%) |
|---|---|---|---|
| GPU pod (1h) | — | ~$2 | ~$2 |
| Discover | ~200-310 | ~$8 | ~$4 |
| Synthesize | 1 | ~$0.20 | ~$0.20 |
| Classify | ~174 | ~$6 | ~$3 |
| Split | 0 (docs) + ~70 (videos) | ~$2 | ~$1 |
| **Total** | | **~$18** | **~$10** |

On UPTIMIZE (corporate): **$0** (streaming only, included in corporate license).

---

## Dependencies

```json
{
  "ai": "^4.0.0",                 // Vercel AI SDK — provider abstraction
  "@ai-sdk/anthropic": "^1.0.0",  // Anthropic provider
  "@ai-sdk/openai": "^1.0.0",     // OpenAI-compatible provider (UPTIMIZE)
  "franc-min": "^6.2.0"           // Language detection (zero deps, ~200 languages)
}
```

No other runtime dependencies. RunPod tools (runpodctl, yt-dlp, ffmpeg) are installed by `transcript:setup`.

---

## Adapting the Template

When starting a new domain, you only need to write **one file manually** (`domain.md`). The other prompts have sensible defaults.

### Step 1 — Write `domain.md` (use Claude to help)

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
5. At the end, add: <!-- LABELED_FIELD: evaluation_step: Step 1 Name, Step 2 Name, Step 3 Name -->
```

Save the result as `context/shared/domain.md`.

### Step 2 — Run discover, review, iterate

```bash
npm run media:discover            # First pass with default prompts
# Review DISCOVERY.md — are the tags/topics relevant?
# Adjust domain.md, rules-json-output.md, or discover/prompt.md if needed
npm run media:discover:force      # Re-run with improved prompts
```

### Step 3 — Continue the pipeline

```bash
npm run media:synthesize          # → SUMMARY.md + PLAN.md
# ✏️ Review PLAN.md
npm run media:classify            # → add categories to frontmatter + INDEX.md
npm run media:split               # → chunks with full frontmatter
npm run bundle                    # → bundle folders
npm run chat                      # 🎉
```

### Quick reference — what you write vs what's automated

| File | Who writes it | When |
|---|---|---|
| `domain.md` | **You** (with Claude's help) | Before anything |
| `source-types.md` | You (rough draft, optional) | Before discover |
| `rules-json-output.md` | You (defines field constraints) | Before discover |
| `discover/prompt.md` | You (JSON schema for analysis) | Before discover |
| `classify/prompt.md` | You (same schema + categories) | Before classify |
| `synthesize/prompt.md` | Keep template default | — |
| `export/rules-*.md` | You (optional) | Before bundle |

### Prompt file format

All prompt files use `{{placeholders}}` replaced at runtime and a `---USER---` separator:

```markdown
You are an expert analyst.

{{DOMAIN}}

Return JSON: { "title": "...", "your_field": [...] }
{{RULES}}

---USER---
Analyze this document:

{{CONTENT}}
```

Available placeholders: `{{DOMAIN}}` (domain.md), `{{SOURCE_TYPES}}` (source-types.md), `{{RULES}}` (rules-json-output.md), `{{PLAN}}` (PLAN.md, classify only), `{{CONTENT}}` (document content, user message).
