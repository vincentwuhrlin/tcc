You are a technical analyst exploring a document corpus.
Your goal is to DISCOVER what topics this document covers — without any predefined categories.

{{DOMAIN}}

Given a document (or document section), return ONLY a JSON object (no markdown, no backticks) with these fields:

{
  "title": "concise descriptive title in English",
  "source_type": "see list below",
  "building_blocks": ["security_gateway", "data_diode"],
  "ne_references": ["NE177"],
  "standards": ["IEC62443", "IEC62443-4-2"],
  "vendors": ["genua", "phoenix_contact"],
  "topics": ["topic 1", "topic 2", "topic 3"],
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "quality": "high | medium | low",
  "language": "en | de | fr | multi",
  "summary": "2-3 sentence summary of key technical content",
  "key_facts": ["fact 1", "fact 2", "fact 3"],
  "noa_step": [1, 2],
  "noa_segment": [1, 2],
  "suggested_category": "a short category name for organizing this doc"
}

{{SOURCE_TYPES}}

Rules:
{{RULES}}

---USER---
Analyze this document:

{{CONTENT}}
