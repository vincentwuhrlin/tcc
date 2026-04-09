# Domain Context — NAMUR Open Architecture (NOA)

NAMUR Open Architecture is a reference architecture for the process industry defined by the NAMUR association (Normenarbeitsgemeinschaft für Mess- und Regeltechnik in der Chemischen Industrie). Its core idea: a secure second communication channel that extracts data from the field level for Monitoring & Optimization (M+O) without touching or endangering the Core Process Control (CPC).

## Building Blocks (NAMUR Recommendations)

NOA is defined across a series of NAMUR Recommendations (NE = NAMUR-Empfehlung):

- **NE 175 — NOA Concept**: foundational recommendation — second channel, M+O domain, separation from CPC. Prescribes OPC UA as base interface. Does NOT mandate a specific transport protocol.
- **NE 176 — Information Model**: OPC UA-based. Defines PA-DIM (Process Automation Device Information Model), IEC 61987 semantic IDs, vendor-neutral device data exchange.
- **NE 177 — Security Zones & Security Gateway (NOA Diode)**: the most critical building block. 3 security zones (CPC, psM+O, M+O), 3 functional modules (Data Aggregator → One-Way Transfer → Data Provision), 2 protection profiles (BASIC = software-enforced, EXTENDED = hardware data diode). Based on IEC 62443 zones & conduits.
- **NE 178 — Verification of Request (VoR)**: the ONLY authorized write-back path from M+O to CPC. Six-step process: authentication → authorization → verification → mapping → propagation → acceptance. Domain transition model.
- **NE 179 — Aggregating Server**: unified OPC UA access point for all M+O data. Single namespace consolidation.
- **NE 183 — M+O Sensors**: requirements for add-on sensors in process plants.
- **NE 184 — MTP Diagnostics**: diagnostics concept for modular plants with NOA integration.
- **NE 198 — Production Data Contextualization**: contextualization of production data in process industry.

## Data Flow — The 3 Steps

1. **Extract** — get data from field level
   - Smart instruments: HART, PROFIBUS, OPC UA direct read
   - Non-smart: parallel contactless extraction (Fieldport SWA50, EtherCAT EL6184)
   - From DCS/PLC: OPC UA read-only access (software diode principle)

2. **Transport** — move data from field to M+O applications
   - Edge Gateway: protocol conversion (south: OPC UA, HART-IP, Modbus → north: MQTT, AMQP, OPC UA PubSub)
   - NOA Diode materialized here (NE 177) — unidirectional guarantee
   - Pub/sub pattern: MQTT (dominant IIoT), AMQP (Azure-native), Kafka (streaming), OPC UA PubSub
   - Semantic layer: OPC UA PubSub, Sparkplug B, proprietary

3. **Consume** — structure and use data
   - MQTT broker as central distribution point
   - Unified Namespace (UNS): ISA-95 hierarchy for topic organization
   - PA-DIM / NE 176 for semantic meaning
   - M+O applications: dashboards, predictive maintenance, analytics, digital twins

## Architectural Segments

| Segment | Location | Role | Key tech |
|---------|----------|------|----------|
| Field | Shop floor, instruments | Data extraction | HART, PROFIBUS, 4-20mA, OPC UA |
| Edge Gateway | Plant network boundary | Protocol conversion + NOA Diode | Docker, OPC UA, NE 177 |
| Broker | Plant or cloud | Data distribution + UNS | MQTT broker, topic hierarchy |
| Cloud/On-prem | IT infrastructure | M+O applications | Dashboards, ML, analytics |

## Security & Standards

- **IEC 62443 series**: zones & conduits (NOA gateway = conduit), security levels SL1–SL4, foundational requirements FR1–FR7, secure development lifecycle (4-1), component security (4-2)
- **NIST SP 800-82**: OT security guide, unidirectional gateways recommendation
- **NIS2 Directive**: EU regulatory framework for critical infrastructure
- **NA 169**: NAMUR automation security management in process industry
- **ISO 27001**: information security management (ISMS transition to OT)

## NOA Diode — BASIC vs EXTENDED vs Firewall

| Criteria | Firewall | NOA BASIC (software) | NOA EXTENDED (hardware) |
|----------|----------|----------------------|------------------------|
| Direction | Bidirectional filtered | Unidirectional logical | Unidirectional physical |
| Bypass risk | Yes (misconfig, exploit) | Low if IEC 62443 certified | None — physical guarantee |
| NE 177 compliant | Insufficient alone | Yes (BASIC profile) | Yes (EXTENDED profile) |
| Cost | Medium | Medium | High |

## Vendor Landscape

### Data Diodes (hardware)
Waterfall Security, OPSWAT/Fend, genua (cyber-diode, vs-diode, genugate), Advenica (DD1G, DD1000i, DD1000A), Hirschmann (EAGLE), Owl Cyber Defense, Siemens CoreShield, Fox-IT (FFHDD), INFODAS SDoT

### NOA Gateway / Edge solutions
Phoenix Contact (PLCnext + HART Gateway GW PL ETH/UNI), Softing (smartLink HW-DP, edgeConnector, edgeAggregator), Kaspersky (IoT Secure Gateway, KasperskyOS Cyber Immunity), Siemens (SINEC, NOA AccessPoint)

### Field extraction
Endress+Hauser (Fieldport SWA50), Beckhoff (EtherCAT EL6184), Turck (cabinet monitoring)

## Related Concepts

- **MTP (Module Type Package)**: VDI/VDE/NAMUR 2658, modular plant integration (PEA/POL), complementary to NOA
- **Bio4C**: Merck modular bioprocessing platform, MTP-driven
- **Unified Namespace (UNS)**: ISA-95 MQTT topic hierarchy — key enabler for the Consume step
- **OPC UA PubSub**: OPC UA extension for pub/sub over MQTT or UDP
- **PA-DIM**: OPC 30081 companion specification, PADIMType, IAdministrationType, ISignalSetType
- **AAS (Asset Administration Shell)**: IDTA digital twin standard, submodel templates, data spaces (Manufacturing-X, ProcessX)
- **OPA (Open Process Automation)**: ExxonMobil-driven open architecture, complementary to NOA

## Team Context

This knowledge base is built by the KTSO (Agentic) team at a pharmaceutical company evaluating NOA for biopharma plant deployment. The team includes a digital innovation architect (screening new technologies, building POC architectures), OT/automation engineers, and IT architects.

**Project trajectory:**
1. **Screening** (current phase) — understanding, competence build-up, evaluation of standard maturity and market products
2. **Gap analysis** — confrontation of the existing OT/DPI architecture with NOA recommendations, identification of gaps and convergence points
3. **Architecture proposal** — NOA-compliant target architecture adapted to the biopharma context, with realistic implementation path (products, steps, priorities)

**Key evaluation axes:**
- Security Gateway / NOA Diode: feasibility, performance/latency impact, market products
- Verification of Request: maturity, existing implementations (limited material available)
- Link with existing DPI (Digital Plant Infrastructure): gap analysis, convergence
- Screening of NOA-compliant OT vendors and industrial success stories

**Structural questions the team seeks to resolve:**
1. Understand NOA building blocks in depth
2. Identify the gap between current OT/DPI architecture and a NOA-compliant target
3. Evaluate products, vendors, and realistic implementation paths
4. Determine concrete added value for the company (as integrator) and for its customers
5. Explore whether NOA compliance could simplify IT-SEC processes with suppliers and customers

The team needs to understand the full stack: NAMUR recommendations → IEC 62443 security framework → data diode products → OPC UA integration → brownfield implementation — and arrive prepared for structured evaluations.

<!-- LABELED_FIELD: noa_step: Extract, Transport, Consume -->
<!-- LABELED_FIELD: noa_segment: Field, Edge Gateway, Broker, Cloud/On-prem -->
