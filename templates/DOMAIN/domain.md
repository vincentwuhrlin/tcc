

============================================================
* On avait travaillé hier sur exporter les data récupérées et créer différent projets Claude, dont un projet hub pour aider à aiguiller l'utilisateur vers
  le bon projet
* L'idée tout de générer un projects.json et un export.ts comme ceux que tu verras en piece jointe, mais pour industrial edge
  (ceux en piece jointe sont pour NOA - Namur Open architecture) en te basant sur les 3 fichiers SUMMARY.md, CLASSIFY.md propre à industrial edge (aussi en pièce jointe).
  [DISCOVERY.md](../namur-open-architecture/media/output/DISCOVERY.md)
* Pour les instructions communes :
    * Il faut impérativement passer en revue TOUS les documents (j'ai peur que Claude rate un document important)
    * Il faut anonymiser "Merck" et remplacer par un autre nom : "Umbrella"
    * Il faut anonymiser tous les noms des personnes que tu trouveras
* Tu es dans une équipe innovation qui explore la technologie Siemens - Industrial Edge en collaboration avec les architectes IT et OT
* On a défini un ordre d'exploration :
* Deep dive infra & architecture SIE : c'est ma mission principale avec l'équipe. L'idée est d'en savoir plus que ce que Siemens partagera, et de préparer des questions pour la réunion avec eux.
* Use cases avec la Franchise (Architectes) — identifier des cas d'usage minimaux pour les étapes 1/2/3.
* 1ère réunion Siemens — consolider les questions des étapes 1 et 2, envoyer des pre-reads.
* Focus applications
* 2ème réunion Siemens.
* Pour cela, on a prévu 3 steps :
    * Step 1 — Tech assessment (Denis lead) : déjà démarré, fin mai. Approche "fail fast", sponsor update fin mai.
    * Step 2 — Modularité, scalabilité, sécu (Loïc F.) : mai → juillet.
    * Step 3 — Applications, services, licensing (Philippe) : mai → juillet.
    * Fin d'activité globale : décembre 2026.
* Le périmètre Step 1 se découpe en deux volets :
    * MVP (à implémenter sur un bench de test) : installation from scratch, faisabilité, limitations techniques, connectivité entre composants, modèle coûts/licences pour Merck.
    * Au-delà du MVP : localisation possible des composants SIE (IEM, IEH…), licences complémentaires indispensables, exploration avec Siemens des bénéfices et impacts, etc...
* Côté applications hébergées : on a identifié 3 axes :
    * l'Edge Device comme hôte d'apps (archi logicielle, containerisation, échange de données inter-apps),
    * l'Edge comme Virtual PLC (héberger un S7-1500, portabilité, dev/deploy/run),
    * L'Edge comme SCADA. La scalabilité est explicitement repoussée au Step 2, et la avec un certain cadrage politique : les interactions Siemens sont séquencées,
      et l'objectif est d'arriver armé aux réunions avec eux plutôt que de découvrir en live.
* Vu que c'est un nouveau projet pour moi, je n'ai pas beaucoup d'expérience sur ces archi "OT", et que meme certains de ces architectes doivent comprendre cerains points pour avancer,
  il va falloir aider les architectes à se poser les bonnes questions. Dans ce cadre la, tu peux m'aider à imaginer et formaliser ces questions que l'on posera aux architectes.
* De plus, il va falloir à la fin s'assurer que tout ce que a présenté Siemens existe réellement. La aussi, il faut m'aider à imaginer et formaliser des questions que l'on pourrait poser à Siemens
  pour valider des points techniques ou structurants.
  ============================================================  

