# Domain Context — NAMUR Open Architecture (NOA)

NOA is a reference architecture for the process industry that opens the classic automation pyramid via a secure second communication channel, without impacting core process control (CPC).

## Building Blocks (NAMUR Recommendations)

- **NE 175: NOA Concept** — overall architecture, second channel, M+O domain
- **NE 176: NOA Information Model** — OPC UA based, PA-DIM, semantic IDs (IEC 61987)
- **NE 177: NOA Security Zones & Security Gateway** — the "NOA Diode", 3 security zones (CPC, psM+O, M+O), 3 gateway modules (Data Aggregator, One-Way Transfer, Data Provision), protection profiles BASIC/EXTENDED
- **NE 178: NOA Verification of Request (VoR)** — controlled write-back from M+O to CPC, domain transition model
- **NE 179: NOA Aggregating Server** — data unification across M+O domain

## Security & Standards Ecosystem

- **IEC 62443 series**: zones & conduits, security levels (SL1-SL4), foundational requirements, secure development lifecycle
- **NIST SP 800-82**: OT security guide, unidirectional gateways recommendation
- **NIS2, ANSSI, BSI**: regulatory frameworks

## Technology Layer

- **Data diodes / unidirectional gateways**: hardware-enforced one-way transfer (Waterfall, OPSWAT/Fend, genua, Advenica, Hirschmann, Owl)
- **OPC UA**: open interface for NOA, read-only mode as software diode, companion specs
- **PA-DIM**: Process Automation Device Information Model
- **MQTT, HART, PROFIBUS, Modbus**: field protocols
- **MTP (Module Type Package)**: modular plant integration with NOA

## Team Context

This knowledge base is built by an engineering team at a pharmaceutical company to study NOA building blocks in depth. Different team members focus on different areas:
- Security Gateway / NOA Diode (NE 177) — main focus
- Verification of Request (NE 178)
- Information Model (NE 176) / Aggregating Server (NE 179)

The team needs to understand the full stack: NAMUR recommendations → IEC 62443 security framework → concrete data diode products → OPC UA integration → implementation in a biopharma plant context.

<!-- PHASE_LABELS: Foundations, Core Building Blocks, Implementation -->
