# EmbeddingZotero

A Zotero plugin with an integrated Streamable HTTP MCP server and semantic search. This repository is a modified fork of [cookjohn/zotero-mcp](https://github.com/cookjohn/zotero-mcp), distributed under the [MIT license](LICENSE). The upstream authors retain credit for the original project.

[简体中文](README-zh.md)

## Current release

The plugin package version is **1.6.4**. Changes in this fork include:

- Send the configured output dimensions for `qwen3.7-text-embedding`, and verify the dimensions returned by the embedding API.
- Inspect every stored embedding dimension, show counts by dimension, and selectively re-embed live library items with mismatched dimensions. Existing vectors remain until replacement succeeds.
- Configure item indexing concurrency from **1 to 1000** (default **5**) in the plugin preferences. A changed value takes effect on the next batch.
- Reconcile the displayed indexed reference count with current Zotero items instead of counting stale index rows as live references.

The concurrent item setting does **not** impose a global cap on embedding API request rate. A document is divided into many text chunks, and several documents can send embedding requests at once. If the provider returns HTTP 429, lower concurrency and check the provider's current request and token limits.

## Install

1. Download the [latest `.xpi`](https://github.com/Max101Johnston/EmbeddingZotero/releases/latest/download/zotero-mcp-plugin.xpi), or build it from source as shown below.
2. In Zotero, open **Tools → Add-ons**, install the `.xpi`, and restart Zotero.
3. Open **Settings → Zotero MCP Plugin**. Enable the MCP server if needed. The default Streamable HTTP endpoint is `http://127.0.0.1:23120/mcp`.
4. Configure the embedding API and use **Test Connection**. Confirm the actual output dimensions before building or repairing an index.
5. In the **Index** section, use **Check Dimensions** to inspect the stored vectors. Use **Re-embed Mismatched Items** only when you intend to replace vectors produced at other dimensions. The operation calls the embedding API and may incur usage charges.

This fork keeps the upstream Zotero add-on ID, so installing its `.xpi` replaces an installed copy of the original plugin. Back up your Zotero profile before changing versions.

## Build from source

Requirements: Zotero 7–10, Node.js 18 or newer, and npm.

```sh
cd zotero-mcp-plugin
npm ci
npm run build
```

The installer is generated at `zotero-mcp-plugin/.scaffold/build/zotero-mcp-plugin.xpi` relative to the repository root. Build output, local databases, API keys, and environment files are excluded from Git. Configure secrets inside Zotero rather than in source files.

## Notes on vector accuracy

Int8 is an approximate representation used for local similarity search. Float32 vectors are also retained in `vectors_f32`; a 100% Int8 indicator means all stored vectors have an Int8 copy, not that every reference is indexed or that all dimensions match. The current search path normally ranks directly by Int8 similarity and does not rerank all candidates with Float32. Dimension checks also cannot detect a change between two different models that produce the same number of dimensions.

## Upstream and license

Based on [Zotero MCP](https://github.com/cookjohn/zotero-mcp) by cookjohn and contributors. See [LICENSE](LICENSE) for the original MIT license. This repository contains source modifications and does not imply endorsement by the upstream project.
