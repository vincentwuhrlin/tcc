# Query : Tu peux me faire une synthèse sur les vendors, vis à vis de la security gateway / NOA Diode ?


# Synthèse des vendors — Security Gateway / NOA Diode

## Cadre de référence : ce que NE 177 attend

Avant de passer aux vendors, rappel rapide du cadre normatif pour évaluer les solutions :

**Les 3 modules obligatoires** [NE177_2021-04-08_en.pdf §7.4] :
- **Module 1** — Data Aggregator (côté CPC) : collecte passive ou active des données terrain (HART, PROFIBUS, Modbus, OPC UA)
- **Module 2** — One-Way Transfer : interface strictement unidirectionnelle, **non configurable**, aucun retour possible
- **Module 3** — Data Provision (côté M+O) : exposition en OPC UA, push vers applications M+O ou NOA Aggregating Server

**Les 2 profils de protection** [NE177_2021-04-08_en.pdf §7.6] :
- **NOA BASIC** → IEC 62443-4-2 SL1+SL2 (logiciel, unidirectionnel logique)
- **NOA EXTENDED** → IEC 62443-4-2 SL3+SL4 (hardware diode, garantie physique)

---

## Vue d'ensemble des vendors

### 1. Phoenix Contact — *Solution modulaire NOA-native*

**Positionnement :** vendor le plus explicitement aligné NOA dans la documentation projet.

**Produits clés :**
- **PLCnext Controller** + **HART Gateway GW PL ETH/UNI** : combinaison qui couvre les fonctions du NOA Security Gateway [Security solutions for the process industry.pdf]
- Le HART Gateway intègre un serveur OPC UA, connecte jusqu'à 40 capteurs HART [8141.pdf §Flexible connection]
- Développement produit certifié IEC 62443-4-1 (secure development lifecycle) [Security solutions for the process industry.pdf]

**Forces :**
- Approche "blueprint" : concepts génériques IEC 62443 réutilisables, réduction du temps de conception [Security solutions for the process industry.pdf]
- Couverture complète Extract → Transport → Expose (Module 1 + 3 natifs)
- Présence forte dans la process industry

**Limites / questions ouvertes :**
- Le Module 2 (one-way transfer) est-il implémenté en hardware ou software ? La documentation projet ne le précise pas explicitement → **à valider avec Phoenix Contact**
- Profil BASIC ou EXTENDED ? Non spécifié dans les sources disponibles

---

### 2. genua (Bundesdruckerei-Gruppe) — *Data diode software haute sécurité*

**Positionnement :** vendor allemand spécialisé sécurité, partenaire officiel du **NOA Implementation Project 2025** (NAMUR + ZVEI) [WP_de_genua-datendiode-fuer-kritische-anlagen-und-prozesse.pdf]

**Produit clé : cyber-diode**
- Diode logicielle basée sur un **microkernel L4 sécurisé** (séparation kernel) [cyber-diode-facts-features.pdf]
- Composants **certifiés BSI** (Bundesamt für Sicherheit in der Informationstechnik) [cyber-diode-facts-features.pdf]
- Protocoles supportés : **OPC UA, Modbus TCP**, FTP/FTPS/SFTP, SMTP, TCP/UDP, syslog, HTTP, IPSec VPN [cyber-diode-facts-features.pdf]
- Mécanisme d'acquittement pour fiabilité de livraison (contrairement aux diodes purement physiques) [cyber-diode-facts-features.pdf]

**Forces :**
- Partenaire actif du projet NOA Implementation 2025 → alignement normatif fort
- Certifications BSI régulières depuis 1992
- Gestion centralisée via **genucenter** ou interface browser locale
- Adapté aux zones critiques (KRITIS) et environnements industriels

**Limites :**
- Solution **software** (microkernel) → profil **NOA BASIC** probable, pas EXTENDED hardware
- Pas de certification EAL ou SL explicitement mentionnée dans les sources projet → ⚠️ à vérifier

---

### 3. Kaspersky (KasperskyOS) — *Cyber Immunity / approche microkernel*

**Positionnement :** approche différenciante basée sur le concept **Cyber Immunity** [Namur Architecture (NOA) for increasing production efficiency. Practical implementation §KasperskyOS.pdf]

**Produits :** IoT Secure Gateway, KasperskyOS

**Architecture :**
- Microkernel minimaliste → surface d'attaque réduite
- Séparation stricte des fonctions (même principe que genua mais approche propriétaire)
- Alignement revendiqué avec les 3 zones NOA et les modules du Security Gateway

**Forces :**
- Concept Cyber Immunity potentiellement très robuste pour Module 2 (isolation physique des flux)
- Adapté brownfield (pas de modification du CPC)

**Limites / points de vigilance :**
- Vendor russe → **contraintes géopolitiques et réglementaires** à évaluer sérieusement dans le contexte Merck (biopharma, données sensibles, réglementations EU)
- Maturité NOA-compliance non certifiée dans les sources disponibles
- ⚠️ Recommandation : à traiter avec prudence dans le contexte d'un site pharmaceutique européen

---

### 4. OPSWAT (NetWall) — *Unidirectional Security Gateway*

**Positionnement :** vendor américain, guide de comparaison des data diodes [OPSWAT_DataDiode_ComparisonGuide_2021.pdf]

**Produit :** NetWall Unidirectional Security Gateway
- Combinaison hardware + software
- Intégration avec MetaDefender (scan malware, CDR, DLP) avant passage de la diode
- Couverture de 30+ produits data diode dans leur guide comparatif

**Forces :**
- Approche "defense in depth" : inspection du contenu avant transfert unidirectionnel
- Bonne documentation comparative du marché

**Limites :**
- Alignement NOA/NE 177 non explicitement documenté dans les sources projet
- Focus historique défense/gouvernement → adaptation process industry à évaluer

---

### 5. Softing — *Edge Connectivity NOA-orientée*

**Positionnement :** vendor spécialisé connectivité OT, produits orientés NOA Extract + Transport

**Produits :** smartLink HW-DP (PROFIBUS), edgeConnector, edgeAggregator

**Forces :**
- Couverture protocoles terrain (PROFIBUS, OPC UA)
- edgeAggregator = fonction proche NE 179 (Aggregating Server)

**Limites :**
- Peu de documentation dans la base projet sur le Security Gateway spécifiquement
- ⚠️ Non couvert en détail dans la documentation projet — basé sur connaissances générales pour cette partie

---

### 6. Siemens — *CoreShield + SINEC*

⚠️ **Non couvert dans la documentation projet** — basé sur mes connaissances générales

- **CoreShield** : solution data diode Siemens, positionnée sur le marché process/énergie
- **SINEC** : infrastructure réseau industrielle avec capacités de segmentation
- Siemens mentionne un **NOA AccessPoint** dans certaines communications

---

## Tableau comparatif synthétique

| Vendor | Produit | Type | Profil NOA | Certification | Protocoles clés | Statut NOA |
|--------|---------|------|-----------|---------------|-----------------|------------|
| Phoenix Contact | PLCnext + HART GW | SW/HW combo | BASIC (probable) | IEC 62443-4-1 (dev) | HART, OPC UA | Aligné NE 177 |
| genua | cyber-diode | SW (microkernel L4) | BASIC | BSI certifié | OPC UA, Modbus TCP | Partenaire NOA 2025 |
| Kaspersky | IoT Secure GW | SW (microkernel) | BASIC | Non précisé | Non précisé | Aligné concept |
| OPSWAT | NetWall | HW+SW | Non précisé | Non précisé | Multiple | Non précisé |
| Softing | edgeConnector/Aggregator | SW | Partiel | Non précisé | PROFIBUS, OPC UA | Partiel |

---

## Points clés pour Merck

### 🔴 Questions critiques à résoudre
1. **Profil BASIC vs EXTENDED** : le choix dépend d'une **risk assessment** formelle [NE177_2021-04-08_en.pdf §2]. Pour un site biopharma avec données de production sensibles, EXTENDED peut être requis → restreint significativement le marché
2. **Certification IEC 62443-4-2** : exiger des vendors une preuve de conformité SL1/SL2 (BASIC) ou SL3/SL4 (EXTENDED) — pas seulement des déclarations marketing
3. **Module 2 hardware vs software** : pour EXTENDED, le Module 2 doit être une diode hardware physique → vérifier que le vendor propose bien cette option

### 🟡 Points de vigilance
- **Kaspersky** : à écarter ou traiter avec extrême prudence dans le contexte réglementaire EU/pharma
- **"NOA-inside" marketing** : NE 177 lui-même avertit contre les faux alignements NOA [2021-11_Joint_Status_Report_MTP_NOA.pdf §2.4]
- La plupart des vendors couvrent bien Module 1 et 3, mais **Module 2 (one-way strict)** est le point différenciant réel

### 🟢 Recommandation screening
Pour la phase actuelle, approfondir en priorité :
1. **Phoenix Contact** : le plus documenté NOA-native, présence process industry
2. **genua** : partenaire officiel NOA 2025, certifications BSI solides, made in Germany (pertinent pour conformité EU)
3. **Waterfall Security** : ⚠️ non couvert dans la documentation projet mais référence mondiale hardware data diode — à ajouter au screening

---

## 📚 Sources

| Document | Ce qui en a été extrait |
|----------|------------------------|
| `NE177_2021-04-08_en.pdf` | Architecture complète NE 177 : 3 modules, 2 profils, exigences fonctionnelles, mapping IEC 62443-4-2 |
| `Security solutions for the process industry.pdf` | Phoenix Contact : PLCnext + HART Gateway, approche blueprint IEC 62443, certification 4-1 |
| `8141.pdf` | Phoenix Contact HART Gateway OPC UA : détails techniques, 40 capteurs, serveur OPC UA embarqué |
| `WP_de_genua-datendiode-fuer-kritische-anlagen-und-prozesse.pdf` | genua cyber-diode : partenariat NOA 2025, positionnement NAMUR, cas d'usage industriels |
| `cyber-diode-facts-features.pdf` | genua cyber-diode : specs techniques, protocoles, certifications BSI, microkernel L4 |
| `Namur Architecture (NOA) for increasing production efficiency. Practical implementation §KasperskyOS.pdf` | Kaspersky : concept Cyber Immunity, alignement NOA Security Gateway |
| `OPSWAT_DataDiode_ComparisonGuide_2021.pdf` | OPSWAT NetWall : positionnement marché, intégration MetaDefender, guide comparatif 30+ produits |
| `2021-11_Joint_Status_Report_MTP_NOA.pdf` | Avertissement anti-marketing NOA, état des NAMUR Recommendations publiées |
| `NE175_2020-07-09_en.pdf` | Définition NOA Diode dans NE 175 : concept, pas de solution technique imposée |