# Getting Started

Welcome to the LLLM Wiki. This page explains how to bootstrap a new wiki
project from the command line.

## Initialize

Run `llm-wiki-cli init` in an empty directory. It creates a `.llm-wiki`
folder with a `config.json`, plus a `wiki/` directory for your content.

## Index content

After adding Markdown files to `wiki/`, run `llm-wiki-cli index` to chunk
and embed them into the local knowledge base at `.llm-wiki/index.db`.
