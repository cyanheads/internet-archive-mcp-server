# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-10-28

Publish an Internet Archive research guide over MCP and preserve SDK runtime modules in desktop bundles.

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-10-24

Text continuation and complete capture paging

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-10-12 · ⚠️ Breaking · 🛡️ Security

Upstream failures on every tool surface as declared errors; ia_get_text reads one page at a time with a capped max_chars; over-cap rows, max_files, and limit are served at the cap; search rows drop fav- lists and cap creators; the hosted endpoint is listed.

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-10-07

Refresh the framework and container build; tool errors now include a request ID.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-09-24 · 🛡️ Security

Snapshot text extraction rewritten for linear time, correct decoding, and a 4 MiB read limit; snapshots report the capture Wayback served, closest lookups fall back to CDX, and blank inputs, unknown mediatype values, and upstream failures surface as declared errors

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-09-24

ia_get_item pages its file manifest (50 files by default) with max_files, file_offset, and a format filter, accepts multi-language items, and service-thrown errors now forward their declared recovery hints

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-09-19

MCP_SESSION_MODE defaults to stateless everywhere, ia_find_snapshots history-mode pagination surfaces its resume key instead of two fabricated snapshots, and mcp-ts-core ^0.12.3 to ^0.13.6 lands the skill-tree move, a sessionMode option, and error severity/thrownBy metadata

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-08-21

ia_get_text restricted downloads consistently throw the declared download_forbidden contract with recovery hint on the wire (#7, #12); mcp-ts-core ^0.10.6 → ^0.12.3 (SDK v2 dual-era serving, strict tool inputs, supply-chain guard, Bun 1.4 Docker, TypeScript 7); smoke/integration/fuzz suites + community health files

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-12

mcp-ts-core ^0.10.6 adoption — ia_find_snapshots truncation enrichment, explicit name/title identity, MCPB bundle agent-doc stripping, Docker healthcheck and version label

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-06

SSRF guard fix for http:// Wayback URLs, dark-item error for ia_get_item, exact-timestamp 404 → no_snapshot_available contract, resolved_status description clarification

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-05 · 🛡️ Security

Initial public release — 5 tools, 1 resource over the Wayback Machine CDX/Availability and IA Search/Metadata APIs, with Solr injection prevention, Wayback SSRF guard, and output cap
