---
name: kb-search-docs
description: Search this project's local knowledge base with `llm-wiki search` before answering documentation, schema, table, metric, business-rule, P&L, data warehouse, or project knowledge questions. Use when Codex needs to retrieve relevant files under the configured content directory (`wiki`), cite local document paths and line ranges, compare documentation topics, or inspect project knowledge before editing or explaining docs.
---

# KB Search Docs

Search the local knowledge base before answering questions that depend on project documentation. Treat search previews as pointers and inspect the source files before drawing conclusions.

The content directory named in the description comes from the project's `kb.include` configuration (filled in by `llm-wiki init`). If it still shows the raw placeholder form, read `.llm-wiki/config.json` to resolve the real content directory.

## Search workflow

1. Run the search from the knowledge-base root, using paths injected by the orchestrator (do not guess the root, DB, or config path):

   ```bash
   llm-wiki search "search terms"
   ```

2. Start with the user's exact business terms, table names, field names, metric names, country names, or error phrases.
3. Remove or split punctuation that may interfere with full-text search. For example, try `P L`, `PL`, or surrounding Chinese terms instead of only `P&L`.
4. If results are weak, run two or three focused searches using synonyms, Chinese and English variants, or narrower table and field names.
5. Open the most relevant files and returned line ranges before answering.
6. Cite local file paths and line ranges for findings and recommended edits. When the index carries a source revision, cite it too so the answer is traceable to a specific commit.

## Reading results

- Prefer merged vector and full-text matches when the output exposes the source.
- Prefer exact domain terms in previews for identifiers and operational procedures.
- Treat a lower vector distance as generally better, but prioritize exact identifier matches.
- Search each topic separately when a question spans multiple topics.

## Empty and candidate knowledge

- If search returns no results, state clearly that the knowledge base has no matching content. Do **not** substitute content from a candidate (un-merged) change as if it were established knowledge.
- Content from a merge request that has not yet been merged and re-indexed is candidate knowledge only — label it as such, never present it as fact.

## Before documentation changes

When the task may change files under `wiki`, use `$kb-write-docs` and follow its confirmation and indexing workflow.
