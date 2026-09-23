# Changelog

## 1.6.5 — Reconcile semantic index with Zotero library

- Remove vector rows, index status and cached content when items are trashed or permanently deleted.
- Reconcile the index with all active Zotero items at startup, every ten minutes and during full indexing, including when automatic embedding is disabled.
- Avoid restoring vectors for an item deleted while its embedding request is in flight.

## 1.6.4 — First installable GitHub Release

- Publish the plugin XPI and its matching update manifest from this repository.
- Validate the manifest download link and SHA-512 hash against the built XPI before release.
- Keep stable and beta update channels within the EmbeddingZotero repository.

## 1.6.3 — Initial EmbeddingZotero source release

- Support configurable output dimensions for `qwen3.7-text-embedding` and validate API responses.
- Audit stored vector dimensions and selectively re-embed affected Zotero items.
- Expose item indexing concurrency in preferences, from 1 to 1000.
- Align the indexed reference count with live Zotero library items.
- Move project and update links to the EmbeddingZotero repository.

This repository builds on the MIT-licensed [Zotero MCP](https://github.com/cookjohn/zotero-mcp) project.
