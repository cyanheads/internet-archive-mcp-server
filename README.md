<div align="center">
  <h1>@cyanheads/internet-archive-mcp-server</h1>
  <p><b>Search the Wayback Machine and IA library (40M+ items), fetch archived snapshots, retrieve item metadata and full text via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/internet-archive-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/internet-archive-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/internet-archive-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/internet-archive-mcp-server/releases/latest/download/internet-archive-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=internet-archive-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaW50ZXJuZXQtYXJjaGl2ZS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22internet-archive-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Finternet-archive-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

The Wayback Machine and Internet Archive library (40M+ items). Find and fetch archived snapshots of any URL, search the library by keyword and metadata, and retrieve item metadata, file manifests, and OCR text from any MCP client. Runs as a stdio process or a local Streamable HTTP server.

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

- `closest` mode: single lookup via the Availability API, returns the nearest capture to a given `timestamp`
- `history` mode: full capture list via the CDX API; filter by date range (`from`/`to`), HTTP status (`status_filter`), and MIME type
- Default `collapse` of `timestamp:8` (one capture per day); adjustable to `timestamp:N`, N=1–14
- Up to 10,000 records per call (`limit`, default 100); `resume_key` pagination for large histories
- Typed errors: `no_snapshots` (no matches), `no_snapshot_available` (closest mode, no capture near timestamp), `cdx_unavailable`

---

### `ia_get_snapshot` <sub>tool</sub>

- Resolves to the nearest available capture when the exact timestamp has no snapshot; exact 14-digit timestamps skip resolution and assume status `200`
- Strips scripts, styles, and nav from the archived HTML, returning readable plain text alongside the canonical replay URL
- Output capped at `IA_MAX_SNAPSHOT_CHARS` (default 50,000 characters)
- Typed errors: `no_snapshot_available`, `content_fetch_failed`

---

### `ia_search_items` <sub>tool</sub>

- Solr query syntax plus structured filters: `mediatype`, `collection`, `creator`, `language`, and date range (`date_from`/`date_to`)
- Sort by relevance, date, or downloads (`sort`, Solr syntax; default `downloads desc`)
- Up to 200 results per page (`rows`, default 50), 1-indexed `page`
- Output carries `total_found`, `page`, `rows` for pagination; empty results return a `notice` with guidance rather than an error

---

### `ia_get_item` <sub>tool</sub>

- Returns `title`, `creator`, `description`, `subject`, `collection`, `licenseurl`, `rights`, and `language` when present in upstream metadata
- `files[]` includes every manifest file — `format`, `size`, `md5`, and a direct `download_url`
- Typed error `item_not_found` for unknown identifiers

---

### `ia_get_text` <sub>tool</sub>

- `max_chars` (defaults to `IA_MAX_SNAPSHOT_CHARS`) and `char_offset` page through long documents; `has_more` signals additional text remains
- Locates the best available text file — DjVuTXT preferred, falls back to plain text; `source_file` names the file fetched
- Typed errors: `item_not_found`, `no_text_file`, `download_forbidden` (restricted collections)

---

### `ia://item/{identifier}` <sub>resource</sub>

- Returns `application/json` — `title`, `creator`, `mediatype`, `description`, `subject`, `collection`, `date`, `licenseurl`, `rights`, `language`, and `file_count`
- `identifier` comes from `ia_search_items` results
- Typed error `item_not_found` for unknown identifiers

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Internet Archive-specific:

- No credentials required — all four APIs are public
- Three service layers: `WaybackService` (Availability + CDX), `ArchiveSearchService` (Solr), `ArchiveMetadataService` (Metadata + downloads)
- CDX collapse-by-day default and configurable `limit` keep responses tractable for high-capture URLs
- Identifies via a custom User-Agent on every request as required by IA's terms of use; configurable via `IA_USER_AGENT`

Agent-friendly output:

- Pagination context on every list response — `total_found`, `page`, `rows` (search) and `resume_key` (CDX history) so agents never have to guess whether results are complete
- Typed error reasons (`no_snapshots`, `no_snapshot_available`, `item_not_found`, `no_text_file`, `download_forbidden`) with recovery hints so callers can retry or explain to users without parsing text
- Structured file manifests — every `ia_get_item` response includes file-level metadata (format, size, URL) enabling agents to select the right file without a follow-up call

## Getting started

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
| `IA_REQUEST_TIMEOUT_MS` | HTTP request timeout in milliseconds | `30000` |
| `IA_MAX_SNAPSHOT_CHARS` | Default character cap for `ia_get_text` responses | `50000` |

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
| `src/services/wayback` | `WaybackService` — Availability API + CDX API client. |
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
