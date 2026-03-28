## Résumé RAG — À reprendre dans un nouveau chat

### Architecture décidée

```
Question FR → /nomic embedding → cosine similarity en mémoire → top-K chunks → /model UPTIMIZE Claude → réponse FR
```

Un seul appel Claude par question. Le RAG est un filtre mathématique (embedding + vector search), pas un intermédiaire LLM.

### Endpoint UPTIMIZE /nomic validé

```
URL:    https://api.nlp.p.uptimize.merckgroup.com/nomic/v1/embeddings
Model:  nomic-embed-text-v1  (pas v1.5 — seul modèle disponible)
Input:  { "input": "texte", "model": "nomic-embed-text-v1" }
Output: [{ index: 0, embedding: [768 floats], object: "embedding" }]
```

Test PowerShell réussi. Cross-lingue limité (v1 = principalement EN) mais suffisant car corpus ~90% anglais et vocabulaire technique identique FR/EN.

### Décisions techniques

- **Pas de Qdrant/VectorDB managé** — trop de validation corporate. 4 360 chunks tiennent en mémoire.
- **Fichier JSON local** — `embeddings.json` (~15 MB pour 4 360 vecteurs × 768 dims). Cosine similarity en mémoire (<50ms pour 4k vecteurs).
- **Pas de LlamaIndex** — trop de dépendances, conflits avec Vercel AI SDK. On reste simple.
- **Vercel AI SDK gardé** — pour les appels LLM (déjà en place dans llmCall).

### Commandes à implémenter

1. **`media:embed`** (~100 lignes) — appeler `/nomic` pour chaque chunk → sauver dans `embeddings.json`. ~10 min pour 4 360 chunks.

2. **`chat` mis à jour** (~50 lignes de delta) — le flow devient :
    - Embed la question via `/nomic` (1 appel)
    - Cosine similarity en mémoire sur les 4 360 vecteurs
    - Top-K chunks pertinents (~20-30 chunks, ~20-30k tokens)
    - Assembler context : system prompt + PLAN.md/INDEX.md en contexte permanent + top-K chunks + question
    - Appeler UPTIMIZE Claude → réponse

### Atténuation du risque de perte de contexte

- **K élevé** (20-30 chunks) pour maximiser la couverture
- **PLAN.md + INDEX.md en contexte permanent** — Claude sait ce qui existe et peut dire "il y a aussi un document sur le Network Concept qui pourrait être pertinent"
- **Hybrid search** (embedding + BM25 mots-clés) — pour ne pas rater les termes techniques exacts comme "port 9443" ou "IEM Virtual"
- **Fallback traduction query FR→EN** — si la qualité de retrieval déçoit sur des questions en français naturel

### Données disponibles pour le RAG

- **4 360 chunks** avec frontmatter propre : `source_origin`, `source_type`, `path`, `section`, `chunk_index/total`, `categories` (hérité), `chunk_categories` (propre)
- **PLAN.md** — 11 catégories A-K avec keywords
- **SUMMARY.md** — analyse de couverture, gaps, reading order
- **INDEX.md** — sources groupées par catégorie

### Variables d'environnement à prévoir

```bash
# ── RAG (embed + chat) ─────────────────────────────────────────────
MEDIA_EMBED_MODEL=nomic-embed-text-v1
MEDIA_EMBED_BATCH_SIZE=50          # chunks par appel (si batch supporté)
MEDIA_RAG_TOP_K=20                 # nombre de chunks retournés
MEDIA_RAG_SYSTEM_PROMPT=context/chat/system.md  # prompt système du chat
```

### Ce qui est prêt

- ✅ Pipeline complet : discover → synthesize → split → classify
- ✅ 4 360 chunks avec frontmatter, categories, chunk_categories
- ✅ Endpoint `/nomic` testé et validé
- ✅ `llmCall` pour UPTIMIZE/Anthropic
- ⏳ `media:embed` à coder
- ⏳ `chat` RAG à coder