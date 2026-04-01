# Synthèse Vendeurs — NOA Security Gateway / NOA Diode

**Umbrella Corporation · Équipe Innovation · Phase Screening**
**Date :** 01/04/2026

---

## Grille de lecture

Le NOA Security Gateway (NE 177 §7.1) se décompose en **3 modules fonctionnels** :

- **Module 1** — Read/Listen : agrégation des données depuis le CPC (écoute passive ou lecture active)
- **Module 2** — One-Way Transfer : interface unidirectionnelle pure, **jamais configurable**, cœur du principe de non-rétroaction
- **Module 3** — Data Provisioning : mise à disposition des données vers le M+O via OPC UA / PA-DIM

Cette synthèse couvre principalement les **vendeurs de Module 2** (data diodes), mais positionne aussi les acteurs complémentaires (Module 1, Module 3, NOA Aggregating Server).

---

## 1. Vendeurs testés dans un contexte NOA

Ces vendeurs ont été directement impliqués dans le NOA Implementation Project ou des démonstrateurs NOA documentés.

### 1.1 genua (Allemagne – Groupe Bundesdruckerei)

**Rôle NOA :** Partenaire officiel du NOA Implementation Project 2025 (NAMUR/ZVEI). La cyber-diode est le produit déployé comme NE 177 Security Gateway Module 2 sur la plateforme IDEA (Bilfinger).

**Gamme pertinente :**

| Produit | Type | Certification | Protocoles clés | Débit | Usage |
|---|---|---|---|---|---|
| **cyber-diode** | Software diode (L4 microkernel + OpenBSD) | Composants CC EAL 4+, technologie approuvée BSI | OPC UA, Modbus TCP, FTP(S), SMTP, HTTP, syslog, IPSec VPN | 1 Gbit/s (UDP), 400 Mbit/s (TCP) | Industriel / KRITIS |
| **vs-diode** | Software diode (microkernel) | Approuvée DE SECRET, EU SECRET, NATO SECRET | FTP(S), SMTP(S), SFTP, TCP, UDP, Lumberjack, HTTP(S)-PUT | > 8 Gbit/s | Classifié / défense |
| **genugate data diode** | Firewall bidirectionnel en mode diode (ALG-PFL-ALG) | CC EAL 4+ / AVA_VAN.5 ("Highly Resistant") | SMTP, FTP, TCP, UDP | 600 Mbit/s | Red/black transition militaire |

**Architecture interne (cyber-diode) :** 4 compartiments isolés sur microkernel L4 — GS black, GS red, Update, Oneway Task. Séparation hardware via Intel VT-d IOMMU. Chaque côté exécute un OpenBSD durci (genuscreen). Un bit de statut feedback assure la garantie de livraison (différenciateur vs. diodes fibre passive).

**Retour terrain NOA Blueprint (nov. 2025) :**
- Déployée avec succès sur Siemens PCS7 / ~31 instruments HART
- **Problèmes d'interopérabilité OPC UA** : timestamps incorrects (la diode relaye le ServerTimestamp du serveur source, mais la spec OPC UA impose que chaque serveur génère son propre ServerTimestamp), types PA-DIM non entièrement supportés par les clients OPC UA en aval
- **Constat du projet :** "les problèmes ne viennent pas des diodes NE177 elles-mêmes, mais de leurs implémentations OPC UA"
- Résultat : la genua cyber-diode n'a pas pu être utilisée en l'état pour le transfert OPC UA complet → workaround via Phoenix Contact firewall

**Sources :** [WP_de_genua-datendiode.md §6], [cyber-diode-technical-information-en.md §1-3], [cyber-diode-facts-features.md], [vs-diode-flyer-en.md], [vs-diode-facts-features.md], [genugate-data-diode.md §1-6], [WS_HH_17-30_DE.md §NOA Blueprint, §NE177 Gateway Internals]

---

### 1.2 Waterfall Security (Israël)

**Rôle NOA :** Testé comme alternative court terme dans le NOA Blueprint quand la genua cyber-diode a rencontré des problèmes OPC UA.

| Produit | Type | Certification | Protocoles clés | Résultat NOA |
|---|---|---|---|---|
| **Unidirectional Cloud Gateway** (generic OPC data diode) | Hardware diode | À confirmer (non détaillé dans le corpus) | OPC UA, MQTT (intégration AWS IoT SiteWise documentée) | "Bons résultats en test court" |

**Point notable :** Waterfall a une intégration documentée avec AWS IoT SiteWise / IoT Core pour le streaming OPC/MQTT vers le cloud — pertinent pour les use cases M+O off-premises.

**Sources :** [WS_HH_17-30_DE.md §Actual Setting], [Securely sending industrial data to AWS IoT.md]

---

### 1.3 Phoenix Contact (Allemagne)

**Rôle NOA :** Double positionnement — Module 1 (NOA Server / HART gateway) et workaround Module 2 (firewall industriel en mode "software-based NE177 gateway").

| Produit | Rôle NOA | Description |
|---|---|---|
| **AXCF3152** (NOA Server) | Module 1 | Agrégateur de données CPC, utilisé dans le NOA Blueprint pour exposer les données HART/Profibus en OPC UA/PA-DIM |
| **GW-PL-ETH/BASIC-BUS** (HART Gateway) | Module 1 | Jusqu'à 40 capteurs HART, serveur OPC UA intégré, sans DD/DTM nécessaire |
| **FL mGuard** (firewall industriel) | Workaround Module 2 | Utilisé en remplacement pragmatique de la data diode quand les gateways NE177 du pentest 2023 ne fonctionnaient pas pour l'OPC UA |

**Attention :** Un firewall industriel n'est **pas** une data diode au sens NE 177. C'est un workaround accepté dans le cadre du projet IDEA pour débloquer la situation, mais il ne satisfait pas l'exigence d'unidirectionnalité physique/logique du Module 2. Phoenix Contact le présente d'ailleurs comme une étape transitoire ("security routers" en attendant les produits data diode matures).

**Sources :** [WS_HH_17-30_DE.md §NOA Blueprint, §Actual Setting], [8141.md §HART gateway], [8075.md §Recommendation]

---

## 2. Vendeurs data diode du marché (non testés en contexte NOA)

Ces vendeurs proposent des produits data diode qui pourraient théoriquement servir de Module 2, mais n'ont pas été testés dans un démonstrateur NOA à notre connaissance. L'enjeu clé pour Umbrella Corp : **la compatibilité OPC UA/PA-DIM n'est pas garantie** — c'est la leçon principale du NOA Blueprint.

### 2.1 Fox-IT / Fox Crypto (Pays-Bas)

| Produit | Type | Certification | Débit |
|---|---|---|---|
| **Fort Fox FFHDD** | Hardware pure (fibre optique, aucun firmware/software) | CC EAL 4+ / AVA_VAN.5 + ALC_DVS.2 | Dépend du transceiver (couche physique OSI) |
| **Fox DataDiode** | Hardware | CC EAL 7+ (seule data diode au monde à ce niveau selon OPSWAT) | 1 Gbps et 10 Gbps |

**Particularité FFHDD :** Le TOE (Target of Evaluation) ne contient strictement **aucune logique, aucun firmware, aucun software** — l'unidirectionnalité est garantie physiquement par des transceivers fibre optique (photocellule → signal électrique → source lumineuse). Le port de sortie unidirectionnel est physiquement incapable de recevoir un signal lumineux. C'est le niveau de garantie physique le plus élevé du marché.

**Limite :** Aucun support protocolaire natif (OPC UA, etc.) — nécessite des proxy/agents en amont et en aval, ce qui déporte la complexité OPC UA hors de la diode.

**Sources :** [Fort Fox Hardware Data Diode Security Target - sertit.md §1.3, §1.4.2, §5.1-5.2]

---

### 2.2 Advenica (Suède)

| Produit | Type | Certification | Protocoles |
|---|---|---|---|
| **DD1G** | Hardware pure (Gigabit Ethernet, aucun software) | — | Aucun (diode passive) |
| **DD1000i** | Hardware + proxies intégrés | Approuvé TOP SECRET (SE), SECRET (FI, AT) | Via Data Diode Engine |
| **DD1000A** | Hardware haute assurance | Approuvé TOP SECRET (SE), SECRET (FI, AT) | Via Data Diode Engine |
| **Industrial Data Diode** (annoncé 2025) | Hardware petit format, optimisé installations industrielles | À confirmer | À confirmer |
| **Data Diode Engine** | Software proxy compagnon | — | OPC UA, MQTT, fichiers, syslog |

**Point notable pour NOA :** Advenica a un proxy OPC UA dédié dans sa bibliothèque de services (Data Diode Engine). L'Industrial Data Diode annoncée en 2025 avec son form factor industriel pourrait être intéressante pour le brownfield process.

**Sources :** [21309v1-0productsheet_datadiodeproductcollection.md]

---

### 2.3 INFODAS (Allemagne)

| Produit | Type | Certification | Débit |
|---|---|---|---|
| **SDoT Diode** | Software sur hardware dédié | DE/EU/NATO SECRET, CC EAL 4+ | 9,1 Gbps |
| **SDoT Security Gateway** | Bidirectionnel configurable en mode diode | DE/EU/NATO SECRET, CC EAL 4+ | 6 Gbps |

**Particularité :** Supporte le filtrage de données structurées (XML, Profibus, protocole S7, Modbus). Pertinent si Umbrella Corp a des besoins de filtrage fin au-delà du simple transfert unidirectionnel.

**Sources :** [OPSWAT_DataDiode_ComparisonGuide_2021.md §INFODAS]

---

### 2.4 Siemens (Allemagne)

| Produit | Type | Certification | Technologie |
|---|---|---|---|
| **CoreShield DCU** (Data Capture Unit) | Hardware industrielle | **IEC 62443 SL3** + safety assessment | Induction électromagnétique |

**Point notable :** Décrit comme la "première data diode de grade industriel au monde avec certification IEC 62443 SL3 et évaluation de sûreté". La technologie à induction électromagnétique est un différenciateur.  Pertinence NOA élevée du fait du positionnement industriel natif de Siemens et de l'alignement direct avec IEC 62443.

**Sources :** [OPSWAT_DataDiode_ComparisonGuide_2021.md §Siemens CoreShield]

---

### 2.5 Owl Cyber Defense (USA)

| Produit | Type | Certification | Débit |
|---|---|---|---|
| **OPDS-100** | DualDiode (isolateur digital) 1U rack | CC EAL certifié | 104 Mbps |
| **OPDS-100D** | DualDiode DIN-rail (environnements industriels durs) | CC EAL certifié | 104 Mbps |
| **Gamme modulaire** | Configurable jusqu'à rack complet | CC EAL certifié | Variable |

**Particularité :** Protocol break complet + suppression des informations d'en-tête IP. La version DIN-rail (OPDS-100D) est conçue pour les environnements industriels difficiles (température, vibrations). Supporte OPC UA, MQTT.

**Sources :** [OPSWAT_DataDiode_ComparisonGuide_2021.md §Owl Cyber Defense]

---

### 2.6 OPSWAT (USA)

| Produit | Type | Certification | Débit |
|---|---|---|---|
| **NetWall USG** | Unidirectional Security Gateway | IEC 62443-4-1 SVV-1 à SVV-5 | Jusqu'à 10 Gbps |

**Particularité :** Écosystème intégré avec MetaDefender (multiscanning malware, CDR, DLP) — pertinent si la data diode est couplée à un contrôle de contenu en entrée.

**Sources :** [OPSWAT_DataDiode_ComparisonGuide_2021.md §OPSWAT NetWall]

---

### 2.7 Autres vendeurs identifiés (corpus OPSWAT)

| Vendeur | Produit | Technologie | Certification | Particularité |
|---|---|---|---|---|
| **Rovenma** (Turquie) | Kindi DataDiode | Électrique (chip-based) | CC EAL 4 (en cours) | 10 Gbps, insensible aux zero-day par design |
| **Terafence** (Israël) | MBsecure+ / A4Gate | Hardware propriétaire | CC, CE | Orienté Industry 4.0, protocoles SCADA |
| **DataFlowX** | Divers | — | — | — |
| **Arbit** | Divers | — | — | — |

**Sources :** [OPSWAT_DataDiode_ComparisonGuide_2021.md]

---

## 3. Approches recherche / hyperviseur (Module 2 par virtualisation)

Ces approches implémentent le Module 2 non pas par une diode physique, mais par isolation logicielle forte (partitions hyperviseur, queuing ports FIFO unidirectionnels).

### 3.1 SYSGO PikeOS (Allemagne)

| Approche | Technologie | Certification | Contexte |
|---|---|---|---|
| **PikeOS Hypervisor** (Type I) | Queuing ports FIFO unidirectionnels entre partitions isolées | Common Criteria (IEC 15408) | Démonstrateur RWTH Aachen (projet SIoT-Gateway, financé BMBF) |

4 partitions sur un même hardware : process control, gateway, digital twin/simulation, cloud interface. La diode NOA est réalisée par les queuing ports unidirectionnels entre la partition CPC et la partition gateway.

**Sources :** [A_Secure_Gateway.md §V.A], [An_Architecture_of_a_NOA-Based_Secure_IoT_Edge_Gateway.md §III]

---

### 3.2 KasperskyOS

| Approche | Technologie | Contexte |
|---|---|---|
| **Cyber Immune approach** | Microkernel + IPC enforcement + security policies | Article SPS-Magazin nov. 2023 / ARC Advisory Group |

Le concept "Cyber Immunity" de Kaspersky (microkernel avec contrôle IPC par politiques de sécurité) est présenté comme naturellement compatible avec les exigences d'unidirectionnalité du NOA Security Gateway. Pas de produit NOA spécifique à date — c'est une approche architecturale.

**Sources :** [Namur Architecture (NOA) for increasing production efficiency _ KasperskyOS.md]

---

## 4. Vendeurs complémentaires (Modules 1 & 3, NOA Aggregating Server)

Ces acteurs ne font **pas** de data diode mais jouent un rôle dans la chaîne NOA complète.

| Vendeur | Rôle NOA | Produit/Service |
|---|---|---|
| **Phoenix Contact** | Module 1 (NOA Server) | AXCF3152, GW-PL-ETH HART Gateway |
| **Endress+Hauser** | Module 1 (interface Profibus) | SFG500 Profibus Interface (utilisé dans le NOA Blueprint) |
| **Leikon** | Outil complémentaire | "NOA Exporter" — lecture des valeurs PA-DIM et export XML/JSON (alternative au transfert OPC UA direct) |
| **Softing** | Module 1 / Aggregating Server | Gamme dataFEED, edgeConnector — connectivité OPC UA et agrégation de données multi-protocoles |
| **Aveva/Schneider** | M+O (consommateur données) | Aveva PI — PIMS cible du NOA Blueprint, workgroup conjoint lancé Q2/Q3 2025 |

---

## 5. Tableau comparatif — Critères clés pour Umbrella Corporation

| Critère | genua cyber-diode | Waterfall | Fort Fox FFHDD | Advenica DD1000i | Siemens CoreShield DCU | INFODAS SDoT |
|---|---|---|---|---|---|---|
| **Testé en contexte NOA** | ✅ Oui (IDEA) | ✅ Court test | ❌ | ❌ | ❌ | ❌ |
| **OPC UA natif** | ✅ (relay client/server) | ✅ (generic OPC) | ❌ (proxy externe) | ✅ (Data Diode Engine) | À vérifier | ❌ (S7/Modbus oui) |
| **Certification max** | CC EAL 4+ (composants) | À confirmer | CC EAL 4+ / AVA_VAN.5 | TOP SECRET (SE, FI, AT) | IEC 62443 SL3 | CC EAL 4+, NATO SECRET |
| **Grade industriel** | ✅ | ✅ | ❌ (militaire/défense) | ✅ (Industrial DD 2025) | ✅ | ❌ (défense) |
| **Garantie de livraison** | ✅ (bit de statut) | ✅ | ❌ (fibre passive) | ✅ (proxies) | À vérifier | ✅ |
| **Origine** | DE (Bundesdruckerei) | IL | NL (Fox-IT) | SE | DE | DE |

---

## 6. Enseignements clés pour la phase Screening

**1. L'interopérabilité OPC UA/PA-DIM est LE critère différenciateur en contexte NOA.**
Le NOA Blueprint a montré que la certification seule ne suffit pas : des produits ayant passé un pentest en 2023 n'ont pas pu transférer correctement les données OPC UA en production. Tout PoC chez Umbrella Corp devra inclure un test de bout en bout avec les types de données PA-DIM réels.

**2. Le marché data diode est mature pour la défense/classifié, mais immature pour le process industriel NOA.**
La plupart des produits viennent du monde militaire/gouvernemental. L'adaptation aux contraintes process (brownfield, Profibus/HART, PA-DIM avec 20 000+ éléments) est en cours mais pas aboutie.

**3. genua est le partenaire de référence NOA, mais avec des limitations OPC UA connues.**
Leur implication directe dans le NOA Implementation Project en fait l'acteur le mieux positionné, mais les problèmes rencontrés sont un signal d'alerte. La roadmap OPC UA de genua est à suivre de près.

**4. Deux alternatives crédibles à court terme :**
- **Waterfall** : résultats positifs en test court, intégration cloud AWS documentée
- **Advenica** : proxy OPC UA dédié, Industrial Data Diode annoncée 2025, certifications européennes fortes

**5. Siemens CoreShield est à investiguer pour sa certification IEC 62443 SL3 native.**
C'est le seul produit avec une certification directement alignée sur le standard de référence NOA (IEC 62443). Son positionnement industriel natif est un avantage pour le process.

**6. L'approche hyperviseur (PikeOS) reste académique mais conceptuellement intéressante.**
Elle permettrait de virtualiser les 3 modules du Security Gateway sur un seul hardware. À surveiller pour le moyen terme, pas pour un déploiement immédiat.

→ **Point à valider avec les architectes OT d'Umbrella Corp :** quel est le niveau de sécurité cible (BASIC = SL1-2 ou EXTENDED = SL3-4) ? Cela conditionne directement le type de produit à retenir (software diode vs. hardware diode).

---

## 📚 Sources

- **WS_HH_17-30_DE.md** — NOA Implementation Projects 2025 (Bilfinger, nov. 2025) : retours terrain NOA Blueprint, problèmes OPC UA, workarounds genua/Phoenix Contact/Waterfall
- **WP_de_genua-datendiode.md** — Whitepaper genua cyber-diode : architecture L4 microkernel, support OPC UA, rôle dans NOA Implementation Project 2025
- **cyber-diode-technical-information-en.md** — Détails sécurité cyber-diode : compartiments, IOMMU, certifications BSI/CC
- **cyber-diode-facts-features.md** — Fiche produit cyber-diode : protocoles, cas d'usage
- **vs-diode-flyer-en.md / vs-diode-facts-features.md** — Fiche produit vs-diode : débits, certifications SECRET
- **genugate-data-diode.md** — Fiche technique genugate : architecture ALG-PFL-ALG, certification CC EAL 4+/AVA_VAN.5
- **Fort Fox Hardware Data Diode Security Target - sertit.md** — Security Target CC EAL 4+ FFHDD : description physique, SFR, assurance requirements
- **OPSWAT_DataDiode_ComparisonGuide_2021.md** — Guide comparatif 30+ produits data diode : spécifications, certifications, débits
- **21309v1-0productsheet_datadiodeproductcollection.md** — Gamme Advenica : DD1G, DD1000i/A, Industrial Data Diode, Data Diode Engine
- **8141.md** — Phoenix Contact HART Gateway OPC UA : description produit, brownfield NOA
- **8075.md** — Phoenix Contact : recommandation security routers comme étape transitoire vers data diodes
- **NE177_2021-04-08_en__s7.1_Overview.md** — NE 177 §7.1-7.5 : définition des 3 modules, exigences fonctionnelles
- **A_Secure_Gateway.md** — RWTH Aachen : architecture PikeOS, VoR par Digital Twin
- **An_Architecture_of_a_NOA-Based_Secure_IoT_Edge_Gateway.md** — RWTH/HS Emden : architecture 4 partitions PikeOS, VoR NE 178
- **Namur Architecture (NOA) KasperskyOS.md** — Approche Cyber Immune microkernel pour NOA Security Gateway
- **NA - What is Data Diode Technology.md** — Fondamentaux data diode, niveaux de sécurité IEC 62443, sizing
- **Securely sending industrial data to AWS IoT.md** — Intégration Waterfall + AWS IoT SiteWise
