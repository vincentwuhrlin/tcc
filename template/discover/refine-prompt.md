I have a document analysis pipeline that processes technical documents.

Here is my current domain context (domain.md):

```
{{DOMAIN}}
```

Here is my current discover prompt (the LLM uses this to analyze each document):

```
{{CURRENT_PROMPT}}
```

I've run a first pass and here is the DISCOVERY.md result (paste it below this prompt).

Based on the patterns you see in DISCOVERY.md, please:

1. Identify recurring dimensions across documents (components, standards, references, phases, vendors, etc.)
2. For each dimension, list the actual values found in the corpus
3. Rewrite my discover prompt to add domain-specific JSON fields for these dimensions
4. Keep ALL existing generic fields (title, source_type, topics, tags, quality, language, summary, key_facts, suggested_category)
5. Keep the {{DOMAIN}}, {{SOURCE_TYPES}}, {{RULES}}, ---USER---, {{CONTENT}} placeholders intact

Return the FULL updated discover/prompt.md file content, ready to save.
