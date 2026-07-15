---
name: kb-write-docs
description: Inspect source material, split it into retrieval-focused documents, and write confirmed content into this project's `wiki` directory. Use when Codex needs to import, copy, move, rename, merge, split, overwrite, or reorganize local knowledge-base documentation while protecting existing files and asking before indexing.
---

# KB Write Docs

Organize documentation under `wiki/` by business domain. Stage new source material in `temp/` and never write it into `wiki/` until the user confirms the proposed operation.

## Workflow

1. If new source material is not already under `temp/`, place a copy there before processing it. Do not alter the original.
2. Inspect the complete staged source and the relevant existing `wiki/` structure.
3. Identify topic boundaries that improve `llm-wiki-cli search` retrieval quality.
4. Present a confirmation request containing:
   - source path under `temp/`;
   - proposed destination paths under `wiki/`;
   - operation type: copy, move, rename, merge, split, or overwrite;
   - split or no-split decision, criteria, proposed outputs, and rationale;
   - a brief content summary;
   - directories to create;
   - existing files that may be modified or overwritten.
5. Wait for explicit confirmation of the directory, names, split plan, and write details.
6. Perform only the confirmed writes and preserve the confirmed structure and names.
7. Ask whether to run `llm-wiki-cli index`. Do not index without explicit confirmation.

## Splitting rules

- Split long documents that mix distinct retrieval topics, such as architecture, business tables, warehouse tables, lifecycle operations, and troubleshooting.
- Keep closely related tables, field lists, and short subsections together when users are likely to search for them as one topic.
- Prefer semantically coherent, topic-focused files over source-shaped files.
- Explain how the proposed boundaries improve search result accuracy and previews.
- Prioritize retrieval accuracy over minimizing file count unless the user asks to optimize index size or runtime.

## Safety rules

- Ask for the target business-domain directory when the correct location is unclear.
- Do not copy an entire staged file into `wiki/` by default; always analyze whether it should be split.
- Do not modify or overwrite existing documentation unless the confirmation names it explicitly.
- Do not run the index command automatically after documentation changes.
