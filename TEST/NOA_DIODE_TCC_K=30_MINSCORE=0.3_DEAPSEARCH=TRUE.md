# Query : Tu peux me faire une synthèse sur les vendors, vis à vis de la security gateway / NOA Diode ?

# Synthèse des vendors — Security Gateway / NOA Diode

## Vue d'ensemble

La documentation projet couvre plusieurs angles : les produits hardware data diode, les solutions edge/gateway NOA-compliant, et les retours d'expérience terrain. Voici une synthèse structurée.

---

## 1. Rappel du cadre NE 177 : ce qu'on évalue

Avant de parler produits, il faut rappeler les deux profils de protection définis par NE 177 [NE177_2021-04-08_en.pdf §7.1] :

| Critère | NOA BASIC | NOA EXTENDED |
|---|---|---|
| Mécanisme | Logiciel (unidirectionnel logique) | Hardware (diode physique) |
| Garantie | Forte si certifié IEC 62443 | Absolue — physiquement impossible de remonter |
| Coût | Moyen | Élevé |
| Cas d'usage | Brownfield standard | Environnements critiques, haute sécurité |

**Point important :** NE 177 ne demande pas de certification obligatoire [NE177_2021-04-08_en.pdf §1.4]. C'est au propriétaire du système ou au fabricant de décider s'il certifie. Cela signifie que les claims "NOA-compliant" sur le marché sont à vérifier au cas par cas.

---

## 2. Vendors identifiés dans la documentation

### 🔴 Hardware Data Diodes (profil EXTENDED)

#### **Waterfall Security — WF-600**
- Produit : Unidirectional Security Gateway WF-600
- Positionnement : "unbreachable security with deep visibility into operations" [youtube WF-600]
- Retour terrain (NOA Blueprint, Bilfinger 2025) : *"Generic OPC data diode from Waterfall in a short test showed good results"* [WS_HH_17-30_DE.pdf]
- Contexte : testé en remplacement de gateways NE 177 logicielles qui avaient des problèmes de transfert OPC UA
- ⚠️ Niveau de certification (EAL/SL) : **non précisé dans la documentation projet**

#### **Genua — Cyberdiode**
- Retour terrain direct (NOA Blueprint, Bilfinger 2025) : *"NE177 Gateway (Genua Cyberdiode) has been put into operation and connected to the Aveva PI system"* [WS_HH_17-30_DE.pdf]
- Contexte : déployé sur un site réel avec Siemens PCS7, 31 field devices HART, connexion vers Aveva PI
- Statut au moment du rapport : en attente de commissioning côté Aveva PI
- ⚠️ Niveau de certification : **non précisé dans la documentation projet**

> 💡 **Point notable** : Waterfall et Genua sont les deux seuls produits avec un retour d'expérience terrain documenté dans la base. Ce sont des références concrètes pour Merck.

---

### 🟡 Solutions Edge/Gateway NOA (profil BASIC ou hybride)

#### **Phoenix Contact — PLCnext + HART Gateway GW PL ETH/UNI**
- Architecture : combinaison PLCnext (contrôleur) + HART Gateway pour implémenter les 3 modules NE 177 [Security solutions for the process industry.pdf]
- Les 3 modules couverts :
    - Module 1 (Data Aggregator) : HART Gateway pour acquisition terrain
    - Module 2 (One-Way Transfer) : logique de diode implémentée dans PLCnext
    - Module 3 (Data Provision) : exposition OPC UA vers M+O
- Certification : *"composants conçus selon un processus de développement certifié conforme à IEC 62443"* [Security solutions for the process industry.pdf]
- Approche blueprint : Phoenix Contact propose des blueprints sécurité IEC 62443 génériques adaptables [Security solutions for the process industry.pdf]
- ⚠️ Profil NE 177 : BASIC (software-enforced), pas hardware diode

#### **Softing — edgeConnector + edgeAggregator**
- Mentionné dans la documentation comme solution NOA edge
- Softing est membre du groupe de travail NOA Implementation Project [youtube Softing]
- Positionnement : connectivité OPC UA, agrégation de données process
- ⚠️ Détail produit limité dans les extraits disponibles

#### **Siemens — NOA AccessPoint / SINEC**
- Démonstrateur NOA présenté par Siemens [youtube Siemens NOA]
- Positionnement : second canal de données sécurisé depuis tous les niveaux de la pyramide d'automatisation
- ⚠️ Détail produit et profil NE 177 : **non précisé dans les extraits**

---

### 🟢 Solutions académiques / recherche (non-produit)

#### **ABB — Architecture VoR cloud-native**
- Démonstrateur validé avec DCS product-grade + infrastructure Kubernetes [A_Cloud-Native_Software_Architecture...]
- Utilise OPC UA PubSub over MQTT pour le flux CPC → M+O
- Feedback positif d'experts en automatisation de procédés chez ABB
- ⚠️ Statut : démonstrateur de recherche, pas encore produit commercial

---

## 3. Problèmes terrain identifiés — points critiques pour Merck

Le retour d'expérience Bilfinger 2025 [WS_HH_17-30_DE.pdf] est particulièrement riche. Il documente des obstacles concrets :

### Problèmes OPC UA (indépendants de la diode elle-même)
| Problème | Impact |
|---|---|
| Clients OPC UA incapables de lire tous les types PA-DIM | Perte d'information |
| Clients ne gérant pas les références CDD IRDIs | Perte de sémantique |
| Clients traitant tous les "BadXxx" comme "BAD" | Perte de statuts importants |
| Clients incapables de "browsing" OPC UA | Configuration manuelle de 20 000+ éléments PA-DIM |
| Timestamps incorrects côté "Red" de la diode | Non-conformité OPC Spec |

> *"Lots of inappropriate OPC UA implementations on the market"* [WS_HH_17-30_DE.pdf]

### Problèmes spécifiques aux gateways NE 177 logicielles
- Les gateways NE 177 software testées lors d'un pentest 2023 **ne pouvaient pas être utilisées** : problèmes de transfert OPC UA, pas de produits finaux disponibles [WS_HH_17-30_DE.pdf]
- C'est précisément pour cette raison que Waterfall (hardware) a été testé en remplacement

### Implication pour Merck
> ⚠️ **Signal fort** : la maturité des implémentations NE 177 software (BASIC) est encore insuffisante en 2025. Les produits hardware (EXTENDED) semblent plus fiables en pratique, mais au prix d'une complexité et d'un coût plus élevés.

---

## 4. Tableau de synthèse vendors

| Vendor | Produit | Profil NE 177 | Retour terrain | Certification |
|---|---|---|---|---|
| **Waterfall** | WF-600 | EXTENDED (hardware) | ✅ Test positif (Bilfinger 2025) | ⚠️ Non précisé |
| **Genua** | Cyberdiode | EXTENDED (hardware) | ✅ Déployé en production (Bilfinger 2025) | ⚠️ Non précisé |
| **Phoenix Contact** | PLCnext + HART GW | BASIC (software) | 🔶 Référencé, pas de retour terrain direct | IEC 62443 (dev process) |
| **Softing** | edgeConnector/Aggregator | BASIC (software) | 🔶 Membre WG NOA | ⚠️ Non précisé |
| **Siemens** | NOA AccessPoint | Non précisé | 🔶 Démonstrateur | ⚠️ Non précisé |
| **ABB** | Architecture VoR | N/A (recherche) | 🔬 Démonstrateur validé | N/A |

---

## 5. Ce que ça implique pour la phase de screening Merck

**Questions à poser aux vendors :**
1. Quel profil NE 177 exact (BASIC ou EXTENDED) ? Quelle garantie d'unidirectionnalité ?
2. Quelle certification IEC 62443 (composant 4-2, système 3-3) ? Quel Security Level ?
3. Comment le produit gère-t-il PA-DIM / OPC UA browsing côté "Red" ?
4. Quel est le comportement sur les timestamps OPC UA (problème documenté) ?
5. Existe-t-il des références en biopharma / pharma ?

**Points à valider avec les architectes OT internes :**
- Le profil BASIC est-il acceptable pour le contexte réglementaire Merck (FDA, GMP) ?
- L'infrastructure DPI existante est-elle compatible avec une diode hardware (impact sur la topologie réseau) ?

---

## 📚 Sources

| Document | Ce qui en a été extrait |
|---|---|
| `NE177_2021-04-08_en.pdf` | Définition des profils BASIC/EXTENDED, 3 modules, exigences de certification, cycle de vie |
| `WS_HH_17-30_DE.pdf` | Retour terrain Bilfinger 2025 : Genua Cyberdiode déployé, Waterfall testé, problèmes OPC UA documentés |
| `Security solutions for the process industry.pdf` | Architecture Phoenix Contact (PLCnext + HART GW), approche IEC 62443 blueprint |
| `A_Cloud-Native_Software_Architecture...pdf` | Démonstrateur ABB VoR, architecture OPC UA PubSub over MQTT |
| `youtube WF-600` | Présentation Waterfall WF-600 Unidirectional Security Gateway |
| `youtube Siemens NOA` | Démonstrateur Siemens NOA, second canal sécurisé |
| `data-diode-industrial-asset-security.pdf` | Principes généraux data diode hardware vs firewall |