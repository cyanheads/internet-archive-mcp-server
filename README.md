<div align="center">
  <h1>@cyanheads/internet-archive-mcp-server</h1>
  <p><b>Search the Wayback Machine and IA library (40M+ items), fetch archived snapshots, retrieve item metadata and full text via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/internet-archive-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/internet-archive-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/internet-archive-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/internet-archive-mcp-server/releases/latest/download/internet-archive-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=internet-archive-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaW50ZXJuZXQtYXJjaGl2ZS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22internet-archive-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Finternet-archive-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://internet-archive.caseyjhand.com/mcp](https://internet-archive.caseyjhand.com/mcp)

</div>

---

## Overview

The Wayback Machine and Internet Archive library (40M+ items). Find and fetch archived snapshots of any URL, search the library by keyword and metadata, and retrieve item metadata, file manifests, and OCR text.

### Tools

| Tool | Description |
|:---|:---|
| `ia_find_snapshots` | Find Wayback Machine snapshots of a URL, by closest timestamp or full capture history |
| `ia_get_snapshot` | Fetch archived page content at a specific Wayback timestamp |
| `ia_search_items` | Search the IA library (40M+ items) by keyword and metadata filters |
| `ia_get_item` | Retrieve full metadata and file manifest for an Archive item |
| `ia_get_text` | Retrieve readable OCR text from a text item, with paging |

### Resources

| Resource | Description |
|:---|:---|
| `ia://item/{identifier}` | Metadata snapshot for an Archive item — title, creator, mediatype, description, subjects, collections, date, license, and file count |

All resource data is also reachable via `ia_get_item`.

## Capability reference

### `ia_find_snapshots` <sub>tool</sub>

- `closest` mode: returns the nearest capture to a given `timestamp` via the Availability API, falling back to one CDX closest-capture query (preferring a `200` capture, 25 s deadline) when the Availability API has no answer
- `history` mode: full capture list via the CDX API; filter by date range (`from`/`to`) and HTTP status (`status_filter`)
- For an exact URL with `timestamp:N` collapse, pass the returned `resume_key` with the same URL to continue without skipping the page boundary. The cursor expires after one hour and retains the original filters; `limit` may change between pages. An invalid cursor returns `invalid_resume_key`; conflicting explicit filters return `resume_key_conflict`. Legacy CDX keys and wildcard histories remain available with a notice that pages may omit captures
- `collapse` is `timestamp:8` (one capture per day) when omitted or blank; adjustable to `timestamp:N`, N=1–14, with `timestamp:14` listing one row per distinct capture second
- Up to 10,000 records per call (`limit`, default 100); a larger `limit` (up to 150,000) is served as 10,000, setting `truncated` and a `notice` naming `resume_key` when captures remain; `resume_key` pagination for large histories
- Replay URLs are always `https://web.archive.org/web/…`
- Typed errors: `missing_timestamp` (closest mode without a `timestamp`, answered before any lookup), `no_snapshots` (no matches), `no_snapshot_available` (closest mode, no capture near timestamp from either source; or, in either mode, the Wayback Machine does not serve the URL — a 403, 410, or 451, as for a site excluded from it), `cdx_unavailable` (CDX 5xx, 429, another 4xx, timeout, network error, or unreadable response, or the closest-mode CDX check did not complete), `availability_unavailable` (closest mode, Availability API 5xx, 429, another 4xx, timeout, network error, or unreadable response); a 429, another 4xx, or a request timeout is answered after one request, a 429 with a hint to wait and a 4xx with a hint that repeating the request will not help

---

### `ia_get_snapshot` <sub>tool</sub>

- Resolves to the nearest available capture when the exact timestamp has no snapshot; exact 14-digit timestamps skip resolution
- Reports the capture Wayback served — `replay_url`, `resolved_timestamp`, and `resolved_status` follow Wayback's redirect when the requested timestamp is not itself a capture
- Decodes the page with its declared charset (`Content-Type`, then `<meta>`, else UTF-8 when the bytes are valid UTF-8, else Wayback's guessed charset or windows-1252), then removes scripts, styles, comments, and tags and decodes character references, returning readable plain text alongside the replay URL
- Reads at most the first 4 MiB of a page (a `notice` says when a page is longer); output capped at `IA_MAX_SNAPSHOT_CHARS` (default 50,000 characters)
- Typed errors: `no_snapshot_available` (no capture near the timestamp, the capture is an archived error page — the message names its timestamp and archived status — or Wayback refused the replay with a 4xx, or the lookup with a 403, 410, or 451, as it does for a site excluded from the Wayback Machine), `content_fetch_failed` (Wayback unreachable, rate-limiting, refusing the lookup, or timed out during lookup or fetch)

---

### `ia_search_items` <sub>tool</sub>

- Solr query syntax plus structured filters: `mediatype`, `collection`, `creator`, `language`, and date range (`date_from`/`date_to`)
- Date bounds accept `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`: `date_from` uses the period's first day and `date_to` its last day, including leap years. Blank bounds leave that side open; invalid dates return `invalid_date_range` before a search request
- `mediatype` takes the ten Internet Archive media types — `texts`, `movies`, `audio`, `software`, `image`, `data`, `web`, `collection`, `etree`, `account` — case-insensitively, and resolves common near-misses (`text`, `book`, `books` → `texts`; `movie`, `video`, `videos` → `movies`; `images` → `image`; `collections` → `collection`)
- Sort by downloads, date, title, or random (`sort`, Solr syntax such as `date asc` or `titleSorter asc`; default `downloads desc`; Advanced Search has no relevance sort). Ties under the sort are ordered by `identifier`, so consecutive pages neither repeat nor skip an item
- `query` is at most 2,047 characters, the longest Advanced Search accepts; the filters count toward it, and a URL in the query must be quoted
- Up to 200 results per call (`rows`, default 50), 1-indexed `page`; on page 1 a larger `rows` (up to 10,000) is served as 200, setting `truncated` and a `notice` naming `rows: 200, page: 2` when more results remain
- Advanced Search serves only the first 10,000 results, so `page × rows ≤ 10,000`
- Output carries `total_found`, `page`, and the `rows` applied for pagination; an empty page returns a `notice` rather than an error — naming the `mediatype` applied when nothing matched, or the last page when `page` is past the end
- `title`, `date`, `creator`, and `collection` may be a string or a list; `collection` leaves out per-account `fav-` favorites lists, and `creator` lists the first 10 names, with `creator_count` when a record has more
- Typed errors answered before any search request: `invalid_date_range` (an invalid date bound), `invalid_mediatype` (any other `mediatype`, listing the accepted values), `rows_over_cap` (`rows` above 200 past page 1), and `page_limit_exceeded` (`page × rows` past 10,000, naming the last reachable page)
- Typed errors from Advanced Search: `invalid_query` (it rejected the query syntax, an unquoted URL, a query its filters take past 2,047 characters, or the sort field; its message is relayed) and `search_unavailable` (it failed, rate-limited the request, sent an unreadable response, timed out, or could not be reached); a 5xx or network error is retried, while a 429, another 4xx, a timeout, or an error body is answered after one request, a 4xx with a hint that repeating the request will not help

---

### `ia_get_item` <sub>tool</sub>

- Returns `title`, `creator`, `description`, `subject`, `collection`, `licenseurl`, `rights`, and `language` when present in upstream metadata; `creator`, `description`, `subject`, `collection`, and `language` may be a string or a list
- `files[]` is one page of the manifest in upstream order — `format`, `size`, `md5`, and a direct `download_url` per file; `file_count` is always the full manifest size
- `max_files` (default 50, at most 500 per call) and `file_offset` (default 0) page through large items; a larger `max_files` (up to 300,000) is served as 500. When files remain, the response sets `truncated` and names the next `file_offset`
- `format` keeps one file type (exact match, case-insensitive — e.g. `DjVuTXT`, `Text PDF`, `VBR MP3`) before paging and reports the match count as `totalCount`; a format with no matches returns an empty page and a notice listing the formats the item has
- Typed errors: `item_not_found` (unknown or dark identifiers), `archive_unavailable` (the Metadata API failed, rate-limited or refused the request, timed out, could not be reached, or sent an unreadable response); a first timeout is retried once, so a call waits at most two request timeouts

---

### `ia_get_text` <sub>tool</sub>

- `max_chars` and `char_offset` page through long documents; `has_more` signals additional text remains. `max_chars` defaults to and is capped at `IA_MAX_SNAPSHOT_CHARS` — a larger value is served at that maximum, with a `notice`, and the output `max_chars` reports the value applied
- For sequential pages, pass `next_continuation` back as `continuation` with the same `identifier`, omitting `char_offset`. The cursor expires after one hour, binds the page to the selected text file, and resumes from its byte checkpoint. If a stable file validator or cursor storage is unavailable, the response gives an offset continuation notice
- Continuation errors: `ambiguous_pagination` when both token and offset are supplied, `invalid_continuation` for an invalid or changed-file cursor, and `range_unavailable` when the download cannot resume at the saved range. Recovery names the `char_offset` to use
- The upstream read stops at the page's end, so memory per call is bounded by the page size
- Locates the best available text file — DjVuTXT preferred, falls back to plain text; `source_file` names the file fetched and `source_file_bytes` its size in bytes, from the item manifest
- Typed errors: `item_not_found`, `no_text_file`, `download_forbidden` (restricted collections), `archive_unavailable` (the Metadata API or the text download failed, rate-limited or refused the request, timed out, or could not be reached); the metadata request and the download each retry a first timeout once and stop at a second

---

### `ia://item/{identifier}` <sub>resource</sub>

- Returns `application/json` — `title`, `creator`, `mediatype`, `description`, `subject`, `collection`, `date`, `licenseurl`, `rights`, `language`, and `file_count`
- `identifier` comes from `ia_search_items` results
- Typed errors: `item_not_found` for unknown identifiers, `archive_unavailable` when the Metadata API fails

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Internet Archive-specific:

- No credentials required — all four APIs are public
- Three service layers: `WaybackService` (Availability + CDX), `ArchiveSearchService` (Solr), `ArchiveMetadataService` (Metadata + downloads)
- CDX collapse-by-day default and configurable `limit` keep responses tractable for high-capture URLs
- Identifies via a custom User-Agent on every request as required by IA's terms of use; configurable via `IA_USER_AGENT`

Agent-friendly output:

- Pagination context on every list response — `total_found`, `page`, `rows` (search), `resume_key` (CDX history), and `file_count` plus the next `file_offset` (item files) so agents never have to guess whether results are complete
- Typed error reasons with recovery hints so callers can retry, correct a filter, or recover an expired continuation without parsing error messages
- Structured file manifests — `ia_get_item` returns file-level metadata (format, size, URL) and a `format` filter, so agents can pick the right file without paging through thumbnails

## Getting started

### Public Hosted Instance

A public instance is available at `https://internet-archive.caseyjhand.com/mcp` — no installation required. It serves Streamable HTTP; each client takes its own configuration shape.

For Claude Code:

```sh
claude mcp add --transport http internet-archive-mcp-server https://internet-archive.caseyjhand.com/mcp
```

For Cline (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "internet-archive-mcp-server": {
      "type": "streamableHttp",
      "url": "https://internet-archive.caseyjhand.com/mcp"
    }
  }
}
```

For Cursor (`mcp.json`):

```json
{
  "mcpServers": {
    "internet-archive-mcp-server": {
      "url": "https://internet-archive.caseyjhand.com/mcp"
    }
  }
}
```

Claude Desktop adds remote servers under Settings → Connectors.

### Self-Hosted / Local

No API key required — the Internet Archive's APIs are fully public.

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "internet-archive-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/internet-archive-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "internet-archive-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/internet-archive-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "internet-archive-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/internet-archive-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No external accounts or API keys required.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/internet-archive-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd internet-archive-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# Optional: edit .env for custom User-Agent, timeouts, etc.
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation | `false` |
| `IA_USER_AGENT` | Custom User-Agent for IA API requests | `internet-archive-mcp-server/{version} (github.com/cyanheads/internet-archive-mcp-server)` |
| `IA_REQUEST_TIMEOUT_MS` | HTTP request timeout in milliseconds, headers and body. A positive integer — anything else fails startup | `30000` |
| `IA_MAX_SNAPSHOT_CHARS` | Default and maximum characters per `ia_get_text` page (a larger `max_chars` is served at it); also caps `ia_get_snapshot` text. A positive integer — anything else fails startup | `50000` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t internet-archive-mcp-server .
docker run --rm -p 3010:3010 internet-archive-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/internet-archive-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools, resource, and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Five tools across Wayback and IA library. |
| `src/mcp-server/resources` | Resource definitions. `ia://item/{identifier}` item metadata resource. |
| `src/services/wayback` | `WaybackService` — Availability API + CDX API client, plus archived-page charset decoding and text extraction. |
| `src/services/archive-search` | `ArchiveSearchService` — Solr Advanced Search client. |
| `src/services/archive-metadata` | `ArchiveMetadataService` — Metadata API + file download client. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
