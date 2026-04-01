


deep research" dans TCC qui fait 2-3 passes de retrieval successives, mais c'est un chantier. En attendant, k=30 et score=0.3 est un bon compromis — ça a quasi doublé la qualité.




- Changement workspace, long, lag/ Spinner ? Backjgroiund foncé avec loading...
- Workspace en cours : dans le local storage, comme le theme ?

La molette

- La consommation de token hyper précise, par sessions, par jour, par query
  - Table spécifique ?
  - API / endpoint ?
✓ Compacting session history


Nickel ! Les blocs de code avec les arbres ASCII sont bien préservés en white-space:
pre, les blockquotes teal ressortent bien, et le bold/emoji passent proprement.
Content que ça marche du premier coup !
Si à l'usage tu trouves qu'il manque la coloration syntaxique
dans les blocs de code (genre pour du Python, YAML, JSON...),
la prochaine étape serait d'ajouter rehype-highlight + un thème highlight.js —
mais vu que c'est surtout du texte structuré et des schémas ASCII
dans le contexte Industrial Edge, c'est probablement pas prioritaire pour l'instant.


Discover
Le seul point cosmétique : la vidéo 41 (Performance Insight) 
a source_language: km (Khmer) — c'est franc-min qui détecte le contenu
corrompu comme du khmer. Pas grave, le discover l'a correctement marquée quality: 
low. Elle sera filtrée par le bundle si tu mets BUNDLE_MIN_QUALITY=medium.

