---
name: kb-search-docs
description: Search this project's local knowledge base with `llm-wiki-cli search` before answering documentation, schema, table, metric, business-rule, P&L, data warehouse, or project knowledge questions. Use when Codex needs to retrieve relevant files under `wiki`, cite local document paths and line ranges, compare documentation topics, or inspect project knowledge before editing or explaining docs.
---

# KB Search Docs

Search the local knowledge base before answering questions that depend on project documentation. Treat search previews as pointers and inspect the source files before drawing conclusions.

## Search workflow

1. Run the search from the knowledge-base root:

   ```bash
   llm-wiki-cli search "search terms"
   ```

2. Start with the user's exact business terms, table names, field names, metric names, country names, or error phrases.
3. Remove or split punctuation that may interfere with full-text search. For example, try `P L`, `PL`, or surrounding Chinese terms instead of only `P&L`.
4. If results are weak, run two or three focused searches using synonyms, Chinese and English variants, or narrower table and field names.
5. Open the most relevant files and returned line ranges before answering.
6. Cite local file paths and line ranges for findings and recommended edits.

## Reading results

- Prefer merged vector and full-text matches when the output exposes the source.
- Prefer exact domain terms in previews for identifiers and operational procedures.
- Treat a lower vector distance as generally better, but prioritize exact identifier matches.
- Search each topic separately when a question spans multiple topics.

## Before documentation changes

When the task may change files under `wiki`, use `$kb-write-docs` and follow its confirmation and indexing workflow.
