<div align="center">
  <h1>@cyanheads/internet-archive-mcp-server</h1>
  <p><b>Search the Wayback Machine and IA library (40M+ items), fetch archived snapshots, retrieve item metadata and full text via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/internet-archive-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/internet-archive-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/internet-archive-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/internet-archive-mcp-server/releases/latest/download/internet-archive-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=internet-archive-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaW50ZXJuZXQtYXJjaGl2ZS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22internet-archive-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Finternet-archive-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Five tools covering two Internet Archive pillars — Wayback Machine snapshot discovery and retrieval, and IA library search and content access:

| Tool | Description |
|:---|:---|
| `ia_find_snapshots` | Find Wayback Machine snapshots of a URL. Mode `closest` returns the nearest capture to a given timestamp. Mode `history` returns the full capture list via CDX with date range, status, and MIME filters, collapsed by default to one capture per day. Supports resume-key pagination for large histories. |
| `ia_get_snapshot` | Fetch the archived content of a URL at a specific Wayback timestamp. Strips HTML to readable text and returns the canonical replay URL. |
| `ia_search_items` | Search the IA library (40M+ items). Filter by media type, collection, creator, date range, and language. Sort by relevance, date, or downloads. Returns identifiers, titles, types, and pagination context (`total_found`, `page`, `rows`). |
| `ia_get_item` | Retrieve full metadata and the file manifest for an Archive item by identifier — title, creator, description, subjects, collections, license, and every file with its format, size, and direct download URL. |
| `ia_get_text` | Retrieve readable OCR text (DjVuTXT or plain-text) from a text item. Length-aware truncation with continuation pointer (`char_offset`) for paging through large documents. |

### `ia_find_snapshots`

Discover what the Wayback Machine has captured for any URL.

- **`closest` mode**: single fast lookup via the Availability API — returns the nearest capture to a given timestamp
- **`history` mode**: full capture list via the CDX API, filterable by date range (`from`/`to`), HTTP status (`status_filter`), and MIME type
- Default collapse of `timestamp:8` (one capture per day) keeps responses tractable for popular URLs; adjust with the `collapse` parameter (`timestamp:N`, N=1–14)
- Resume-key pagination (`resume_key`) for stepping through large CDX histories without re-scanning

---

### `ia_get_snapshot`

Retrieve what a page actually said at a point in time.

- Resolves to the nearest available capture when the exact timestamp has no snapshot
- Strips Wayback banner injections and extracts readable text — returns clean content alongside the canonical replay URL for browser access
- Useful for fact-checking, citation verification, and tracing how content changed over time

---

### `ia_search_items`

Search across 40M+ Archive items by keyword and metadata filters.

- Full-text Solr query syntax plus structured filters: `mediatype` (texts, audio, video, software, image), `collection`, `creator`, `language`, and date range
- Sort by relevance, date added, or download count
- Pagination via `page` and `rows`; output includes `total_found` and current `page`/`rows` so agents can paginate correctly without guessing

---

### `ia_get_item`

Fetch the complete metadata and file manifest for any Archive item.

- Returns structured fields: `title`, `creator`, `description`, `subjects`, `collections`, `date`, `license`, and more
- `files[]` includes every file in the item with its `format`, `size`, and direct download URL — the primary way to act on a search result
- `metadata` response `{}` on unknown identifier → typed `item_not_found` error

---

### `ia_get_text`

Read the OCR text of public-domain books, documents, and transcripts.

- Locates the best available text file in the item's manifest (DjVuTXT preferred, falls back to plain text)
- `max_chars` and `char_offset` enable efficient paging through long documents without re-fetching
- Surfaces `download_forbidden` (HTTP 403) as a typed error for restricted collections rather than failing silently

## Resource

| Type | Name | Description |
|:---|:---|:---|
| Resource | `ia://item/{identifier}` | Metadata snapshot for an Archive item — title, creator, mediatype, description, subjects, collections, date, license, and file count. Stable URIs for injectable context. |

All resource data is also reachable via `ia_get_item`. The resource provides a stable, injectable URI for referencing a specific item across workflows.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Internet Archive-specific:

- No credentials required — all four APIs are public
- Three service layers: `WaybackService` (Availability + CDX), `ArchiveSearchService` (Solr), `ArchiveMetadataService` (Metadata + downloads)
- CDX collapse-by-day default and configurable `limit` keep responses tractable for high-capture URLs
- Identifies User-Agent on every request as required by IA's terms; configurable via `IA_USER_AGENT`

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

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
