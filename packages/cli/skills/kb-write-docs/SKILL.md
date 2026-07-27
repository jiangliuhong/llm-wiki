---
name: kb-write-docs
description: Inspect source material, split it into retrieval-focused documents, and write confirmed content into this project's configured knowledge-base directory (`{{KB_INCLUDE}}`). Use when Codex needs to import, copy, move, rename, merge, split, overwrite, or reorganize local knowledge-base documentation while protecting existing files and asking before indexing.
---

# KB Write Docs

Organize documentation under `{{KB_INCLUDE}}/` by business domain. Stage new source material in `{{KB_STAGING}}/` and never write it into `{{KB_INCLUDE}}/` until the user confirms the proposed operation.

The directories named above come from the project's `kb.include` configuration (filled in by `llm-wiki-cli init`). If they still show the raw placeholder form, read `.llm-wiki/config.json` to resolve the real content directory before writing.

## Workflow

1. If new source material is not already under `{{KB_STAGING}}/`, place a copy there before processing it. Do not alter the original.
2. Inspect the complete staged source and the relevant existing `{{KB_INCLUDE}}/` structure.
3. Identify topic boundaries that improve `llm-wiki-cli search` retrieval quality.
4. Present a confirmation request containing:
   - source path under `{{KB_STAGING}}/`;
   - proposed destination paths under `{{KB_INCLUDE}}/`;
   - operation type: copy, move, rename, merge, split, or overwrite;
   - split or no-split decision, criteria, proposed outputs, and rationale;
   - a brief content summary;
   - directories to create;
   - existing files that may be modified or overwritten.
5. Wait for explicit confirmation of the directory, names, split plan, and write details.
6. Perform only the confirmed writes and preserve the confirmed structure and names.
7. Show a diff of every change after writing.
8. Ask whether to run `llm-wiki-cli index`. Do not index without explicit confirmation.

## Splitting rules

- Split long documents that mix distinct retrieval topics, such as architecture, business tables, warehouse tables, lifecycle operations, and troubleshooting.
- Keep closely related tables, field lists, and short subsections together when users are likely to search for them as one topic.
- Prefer semantically coherent, topic-focused files over source-shaped files.
- Explain how the proposed boundaries improve search result accuracy and previews.
- Prioritize retrieval accuracy over minimizing file count unless the user asks to optimize index size or runtime.

## Safety rules

- Only modify files under the configured content directory (`{{KB_INCLUDE}}`). Never write outside it.
- Search and read existing related content before editing, so changes stay consistent with the rest of the knowledge base.
- Ask for the target business-domain directory when the correct location is unclear.
- Do not copy an entire staged file into `{{KB_INCLUDE}}/` by default; always analyze whether it should be split.
- Do not modify or overwrite existing documentation unless the confirmation names it explicitly.
- Do not run the index command automatically after documentation changes.

## Boundary with the merge pipeline

- Until the orchestrator (e.g. pi-agents) merges the change into the target branch and rebuilds the index, these edits are **candidate knowledge only** — never present them as established facts.
- Do not `git push`, create a GitLab/GitHub merge request, merge a request, or swap the active index. Those steps belong to the orchestrator, not this skill.
- Wait for explicit user confirmation before any write, and again before indexing.
