# TCC — Démarrage rapide

[English](./QUICKSTART.md) · **Français**

Faites tourner une base de connaissances chat-ready sur votre machine en **moins de 5 minutes**, avec un workspace pré-construit.

Pour un tour plus complet du projet, voir [README.fr.md](./README.fr.md).

## Prérequis

- **Node.js 20+** et **pnpm 10+**
- Une clé **UPTIMIZE API** valide (proxy interne Merck pour Claude) — ou une clé Anthropic directe
- Un zip de workspace pré-construit (par ex. `noa-<date>.zip`, `industrial-edge-<date>.zip`) partagé par l'équipe

> Pas de workspace pré-construit ? Vous pouvez aussi en construire un depuis vos propres PDFs et vidéos — voir la section *pipeline complet* en bas de page.

## Installation en 4 étapes

```powershell
# 1. Cloner le repo
git clone https://dev.azure.com/Inno-Software/Portfolio-Prioritization-Process/_git/transcript-classify-and-chat
cd transcript-classify-and-chat
pnpm install
# Le premier install builde better-sqlite3, onnxruntime-node et sharp — approuvez quand demandé.

# 2. Configurer l'environnement
copy .env.quickstart .env
# Éditez .env :
#   • collez votre clé UPTIMIZE dans API_KEY=
#   • mettez WORKSPACE=<nom> pour matcher le dossier workspace que vous allez utiliser (défaut : noa)

# 3. Dézipper le workspace dans workspaces/
# Chemin résultant : transcript-classify-and-chat/workspaces/<nom>/
#                                                          ├─ media/
#                                                          ├─ context/
#                                                          ├─ workspace.json
#                                                          └─ workspace.db

# 4. Démarrer TCC
pnpm run chat
```

Puis ouvrez <http://localhost:3000>.

> **Premier démarrage** : TCC télécharge le modèle d'embedding `nomic-local` (~274 MB, une seule fois). Les démarrages suivants sont instantanés.

## Ce que vous obtenez

- **`pnpm run chat`** lance à la fois l'API Hono (`:3001`) et l'UI Vite (`:3000`) en parallèle.
- L'UI web vous laisse switcher entre tous les workspaces présents dans `workspaces/` — la valeur `WORKSPACE` du `.env` n'est que la valeur initiale.
- Les sessions, mémoires et corrections Q&A sont persistées **localement** dans `workspaces/<nom>/workspace.db`. Rien n'est uploadé.
- Le panneau de debug montre exactement quels chunks ont alimenté chaque réponse (top-K, sous-requêtes du deep search, focus mode).

## Configuration du workspace

Deux variables dans `.env` décident où TCC cherche les workspaces :

- **`WORKSPACES_DIR`** — dossier parent contenant tous les workspaces (défaut : `workspaces`, relatif à la racine du repo). À ne changer que si vous gardez vos workspaces hors du repo.
- **`WORKSPACE`** — nom du sous-dossier workspace actif. Doit matcher le nom du dossier dans `WORKSPACES_DIR`.

Le template `.env.quickstart` met `WORKSPACE=noa` par défaut. Si vous avez importé `industrial-edge` à la place, changez-le — ou utilisez simplement le sélecteur de workspace dans l'UI.

## Commandes courantes

```powershell
# Chat web (depuis la racine du repo)
pnpm run chat                  # serveur + client → http://localhost:3000
pnpm run chat:server           # API uniquement sur :3001
pnpm run chat:client           # UI uniquement sur :3000

# Chat terminal contre le workspace actif
pnpm --filter @tcc/core chat

# Stats et utilitaires
pnpm --filter @tcc/core media:stats           # métriques KB : pages, durée, tokens
pnpm --filter @tcc/core media:embed:stats     # vecteurs par modèle / DTYPE
pnpm --filter @tcc/core uptimize:stats        # dépense + statut UPTIMIZE
```

## Partager votre workspace amélioré

Si vous avez ajouté du média, édité des Q&A ou pinné des catégories et que vous voulez partager le résultat :

```powershell
pnpm --filter @tcc/core workspace:clean -- --workspace=<nom> --with-qa
pnpm --filter @tcc/core workspace:zip   -- --workspace=<nom>
# Le zip atterrit dans workspaces/<nom>-<date>.zip — uploadez-le sur le drive d'équipe
```

`workspace:clean --with-qa` supprime les sessions, mémoires, embeddings et corrections Q&A avant le zip, donc le destinataire reçoit un snapshot propre.

## Construire son propre workspace depuis du média brut

Si vous n'avez pas de workspace pré-construit et que vous voulez ingérer vos propres PDFs / vidéos, le pipeline complet est :

```bash
pnpm --filter @tcc/core transcript:setup        # 0. installe runpodctl, yt-dlp, ffmpeg
pnpm --filter @tcc/core transcript              # 1. transcrit PDFs + vidéos → .md
pnpm --filter @tcc/core media:discover          # 2. extrait les topics → DISCOVERY.md
pnpm --filter @tcc/core media:synthesize        # 3. SUMMARY.md + PLAN.md
pnpm --filter @tcc/core media:split             # 4. découpe les documents en chunks
pnpm --filter @tcc/core media:classify          # 5. catégorisation par chunk + INDEX.md
pnpm --filter @tcc/core media:embed             # 6. vecteurs → workspace.db
pnpm run chat                                   # 7. profitez-en
```

Chaque commande est **idempotente et reprenable** — `--force` retraite tout, `--dry-run` prévisualise. Voir [README.fr.md](./README.fr.md) pour le détail de chaque phase.

> **Pourquoi `split → classify` ?** Un chunk peut appartenir à plusieurs catégories différentes (ex : un chapitre "Setup MQTT" relève à la fois de *Protocoles/MQTT* et *Réseau/Topologie*). La classification doit voir les chunks finaux pour pouvoir les catégoriser un par un.

## Dépannage

| Symptôme                                              | Solution                                                            |
|-------------------------------------------------------|---------------------------------------------------------------------|
| `pnpm install` saute le build des modules natifs      | Relancez avec approbation du build ; les modules sont listés dans `pnpm.onlyBuiltDependencies` |
| L'UI web charge mais les réponses disent "no chunks"  | Mauvais `WORKSPACE` dans `.env`, ou `media:embed` n'a jamais tourné |
| `Cannot find .env`                                    | Le `.env` doit être à côté de `pnpm-workspace.yaml`, à la racine    |
| Le premier chat est lent                              | Le modèle d'embedding se télécharge (~274 MB) et chauffe (~5 s)     |
| `workspace:zip` est énorme                            | Utilisez le zip slim par défaut, pas `--full`, pour le partage      |

## Confidentialité

Les sessions de chat, mémoires et corrections Q&A restent **uniquement sur votre machine** dans `workspaces/<nom>/workspace.db`. Les seuls appels réseau que TCC fait sont les requêtes LLM (et optionnellement les requêtes d'embedding si vous choisissez `nomic-uptimize`).

## Questions ?

Pingez Vincent ou consultez le [README](./README.fr.md) pour l'architecture complète.
