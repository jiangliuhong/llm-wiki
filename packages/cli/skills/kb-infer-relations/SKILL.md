---
name: kb-infer-relations
description: Infer evidence-backed relationships between documents in a local llm-wiki-cli project and submit them for human review. Use when asked to discover document dependencies, implementations, extensions, references, or related concepts that are not already declared in Markdown links or frontmatter.
---

# Infer Wiki Relations

Create auditable proposal JSON for `llm-wiki-cli relations propose`. Never write SQLite directly and never publish a relation without review.

## Workflow

1. Confirm `.llm-wiki/config.json` exists. Run `llm-wiki-cli index` only when the user authorized indexing and the index is stale or absent.
2. Read the documents in the configured `kb.include` roots. Treat existing links and frontmatter as context, not new inferred proposals.
3. Compare documents for explicit architectural or semantic evidence. Propose only relationships supported by a source line range.
4. Prefer `depends_on`, `implements`, `extends`, `references`, or `related_to`. Use a concise `snake_case` custom type only when none fits.
5. Assign confidence independently: `0.85-1.0` for direct statements and `0.65-0.84` for strong contextual evidence. Omit weaker guesses.
6. Write one versioned JSON file using the schema below, then run `llm-wiki-cli relations propose --input <file>`.
7. Report imported proposal IDs. Do not approve them; a human must review them in the Wiki or with `llm-wiki-cli relations approve <id>`.

## Proposal schema

```json
{
  "version": 1,
  "proposals": [
    {
      "source": "{{KB_INCLUDE}}/architecture.md",
      "target": "{{KB_INCLUDE}}/storage.md",
      "type": "depends_on",
      "confidence": 0.91,
      "rationale": "The architecture explicitly requires the storage contract.",
      "evidence": {
        "path": "{{KB_INCLUDE}}/architecture.md",
        "startLine": 18,
        "endLine": 20,
        "text": "The indexing layer persists every document in the local storage contract."
      }
    }
  ]
}
```

`{{KB_INCLUDE}}` is a placeholder filled by `llm-wiki-cli init` from the project's `kb.include` configuration. Replace it with the real content root when constructing actual proposal paths.

## Guardrails

- Use repository-relative POSIX paths matching indexed `files.path` values.
- Do not infer from shared keywords, the same directory, or vague topical similarity alone.
- Do not duplicate a relation already expressed by a Markdown link or frontmatter.
- Do not invent evidence, line numbers, targets, or confidence.
- Omit ambiguous or missing targets and report the ambiguity.
- Treat every generated proposal as untrusted input awaiting human approval.
