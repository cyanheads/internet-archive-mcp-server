# Internet Archive MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `ia_find_snapshots` | Find Wayback Machine snapshots of a URL. Mode `closest` returns the single nearest capture to a given timestamp (fast, via Availability API). Mode `history` returns the full capture list via CDX — filterable by date range, HTTP status, and MIME type, collapsed by default to one capture per day. Returns timestamps and `web.archive.org` replay URLs. Supports resume-key pagination for large histories. | `url`, `mode` (`closest`\|`history`), `timestamp` (closest mode), `from`/`to`, `status_filter`, `limit`, `collapse` (`timestamp:N` precision, default `timestamp:8`), `resume_key` (history mode) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `ia_get_snapshot` | Fetch the archived content of a URL at a specific Wayback timestamp. Resolves to the nearest available capture when the exact timestamp has no snapshot. Returns the archived text content (HTML stripped to readable text) and the canonical replay URL. | `url`, `timestamp` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `ia_search_items` | Search the Internet Archive library (40M+ items) via the Advanced Search / Solr API. Filter by media type, collection, creator, date range, and language. Sort by relevance, date, or downloads. Returns identifiers, titles, creators, media types, dates, download counts, `total_found`, and current `page`/`rows` for pagination context. | `query`, `mediatype`, `collection`, `creator`, `date_from`/`date_to`, `language`, `sort`, `rows`, `page` | `readOnlyHint: true`, `openWorldHint: true` |
| `ia_get_item` | Retrieve full metadata and the file manifest for an Archive item by identifier. Returns title, creator, description, subjects, collections, license, and every file with its format, size, and direct download URL. The primary hub for acting on a search result. | `identifier` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `ia_get_text` | Retrieve the readable text content of a text item (OCR DjVuTXT or plain-text file) by identifier, with length-aware truncation and continuation pointer. Suited for public-domain books, documents, and transcripts. | `identifier`, `max_chars`, `char_offset` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |

### Error Contracts

| Tool | `reason` | Code | When |
|:-----|:---------|:-----|:-----|
| `ia_find_snapshots` | `no_snapshots` | `NotFound` | CDX returned zero results for the given URL/filters |
| `ia_find_snapshots` | `cdx_unavailable` | `ServiceUnavailable` | CDX returned HTTP 503/504 or timed out |
| `ia_get_snapshot` | `no_snapshot_available` | `NotFound` | Availability API returned `archived_snapshots: {}` — URL has no capture near the requested timestamp |
| `ia_get_snapshot` | `content_fetch_failed` | `ServiceUnavailable` | Archived HTML fetch failed (network error or non-200 from `web.archive.org/web/`) |
| `ia_get_item` | `item_not_found` | `NotFound` | Metadata API returned `{}` — identifier does not exist |
| `ia_get_text` | `item_not_found` | `NotFound` | Metadata API returned `{}` for the identifier |
| `ia_get_text` | `no_text_file` | `NotFound` | Item exists but `files[]` contains no DjVuTXT or plain-text file |
| `ia_get_text` | `download_forbidden` | `Forbidden` | Text file URL returned HTTP 403 — item is in a restricted collection |

Baseline errors (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`) bubble freely and don't need declaring.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `ia://item/{identifier}` | Metadata snapshot for an Archive item — title, creator, mediatype, description, subjects, collections, date, license, and file count. Read-only; stable URIs for injectable context. | None (single item) |

### Prompts

None — the server is data/action-oriented; static templates add no value here.

---

## Overview

Access the Internet Archive's two main pillars through a single MCP server:

1. **Wayback Machine** — historical snapshots of any URL, from a single "closest capture" lookup to the full multi-decade capture history via the CDX API.
2. **IA Library** — 40M+ items across texts, audio, video, software, and images, searchable by keyword and metadata, with per-item file manifests and text retrieval.

Target audience: researchers, journalists, fact-checkers, and any agent that needs to verify what a web page said at a past time or mine the open-source library. The Wayback tools compose broadly — "snapshot any URL an agent is about to cite" works alongside every other MCP server.

---

## Requirements

- Read-only access to all four APIs; no credentials needed
- Wayback Availability API: `GET archive.org/wayback/available?url=&timestamp=` — closest snapshot to a given time, fast single-result response
- Wayback CDX API: `GET web.archive.org/cdx/search/cdx?url=&output=json` — full capture history; array-of-arrays with header row; supports field selection (`fl`), collapsing (`collapse`), date range (`from`/`to`), status filtering, and resume-key pagination
- Advanced Search API: `GET archive.org/advancedsearch.php?q=&output=json` — Solr-based; `response.docs` envelope; supports `fl[]` field selection, `rows`, `page`, `sort[]`
- Metadata API: `GET archive.org/metadata/{identifier}` — returns `metadata` object + `files[]` array; `{}` on unknown identifier
- Identifying User-Agent required as a courtesy per IA's terms
- Respect backoff on 429; CDX can time out on unbounded queries — always use `limit` and `collapse` defaults
- No DataCanvas — capture lists and search results are discovery metadata (timestamps/URLs/identifiers), not analytical rows

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `WaybackService` | Availability API + CDX API | `ia_find_snapshots`, `ia_get_snapshot` |
| `ArchiveSearchService` | Advanced Search (Solr) API | `ia_search_items` |
| `ArchiveMetadataService` | Metadata API + file downloads | `ia_get_item`, `ia_get_text`, `ia://item/{identifier}` resource |

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `IA_USER_AGENT` | No | Custom User-Agent string. Defaults to `internet-archive-mcp-server/{version} (github.com/cyanheads/internet-archive-mcp-server)` |
| `IA_REQUEST_TIMEOUT_MS` | No | HTTP request timeout in milliseconds. Default `30000` |
| `IA_MAX_SNAPSHOT_CHARS` | No | Default character cap for `ia_get_text` responses. Default `50000` |

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with the three env vars above
2. **WaybackService** — Availability and CDX clients; `findClosest()`, `fetchHistory()`, `fetchContent()` methods
3. **ArchiveSearchService** — Solr search client; `search()` with field selection
4. **ArchiveMetadataService** — Metadata and download clients; `getItem()`, `getTextContent()`
5. **`ia_find_snapshots`** — both modes (closest + history)
6. **`ia_get_snapshot`** — snapshot content retrieval with text extraction
7. **`ia_search_items`** — library search
8. **`ia_get_item`** — item metadata + file manifest
9. **`ia_get_text`** — OCR text retrieval with pagination
10. **`ia://item/{identifier}` resource** — lightweight metadata injectable context

---

## Domain Mapping

| Noun | Operations | API |
|:-----|:-----------|:----|
| Snapshot | find-closest, find-history, fetch-content | Availability, CDX, `web.archive.org/web/` |
| Item | search, get-metadata, get-files, get-text | Advanced Search, Metadata, download |

---

## Workflow Analysis

### `ia_find_snapshots` (mode: `history`)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /cdx/search/cdx?url=&fl=timestamp,statuscode,mimetype,original,digest&collapse=timestamp:8&limit=N&showResumeKey=true[&resumeKey={key}]` | Fetch collapse-by-day capture list, applying date/status/mime filters; include resume key if continuing a prior page |
| — | Parse header row; strip it; map rows to objects | Local transform (no extra call) |
| — | Detect trailing `[[], ["<key>"]]` rows; strip them; expose `resume_key` in output if present | Enables continuation — output schema must include `resume_key?: string` and input must accept `resume_key?: string` |

### `ia_get_snapshot` 

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /wayback/available?url=&timestamp=` | Resolve nearest snapshot URL |
| 2 | `GET web.archive.org/web/{resolved_timestamp}/{url}` | Fetch archived HTML |
| — | Strip HTML tags to readable text; truncate if needed | Local transform |

### `ia_search_items`

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /advancedsearch.php?q=&fl[]=...&rows=&page=&sort[]=&output=json` | Solr search with field projection |

### `ia_get_item`

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /metadata/{identifier}` | Metadata + file manifest |

### `ia_get_text`

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /metadata/{identifier}` | Locate DjVuTXT or plain-text file in `files[]` |
| 2 | `GET archive.org/download/{identifier}/{filename}` | Fetch text content |
| — | Slice `[char_offset, char_offset + max_chars]`; report total length | Local pagination |

---

## Design Decisions

**Two Wayback tools, not one.** `ia_find_snapshots` (discovery) and `ia_get_snapshot` (retrieval) separate the "what snapshots exist" workflow from the "show me what the page said" retrieval. Merging them conflates two distinct agent intents and would produce an awkward dual-mode shape. The `mode` parameter inside `ia_find_snapshots` is a good fit because both modes answer the same question ("what snapshots exist?") via different API paths — that's within-tool disambiguation, not two separate goals.

**CDX collapse default.** Popular URLs have tens of thousands of captures. Default `collapse=timestamp:8` (one per day) keeps responses tractable. The `collapse` parameter accepts `timestamp:N` where N is 1–14 (precision digits: 4=year, 6=month, 8=day, 10=hour, 14=exact). Validate the format with `z.string().regex(/^timestamp:\d{1,2}$/).optional()` — or omit entirely to get uncollapsed results. Do not accept arbitrary strings.

**No `ia_get_snapshot` HTML passthrough.** Raw Wayback HTML is rewritten by the archive (banner injections, relative URL rewriting) and can be very large. The tool strips to readable text and always returns the canonical replay URL so the human can open the original in a browser. Text extraction via `sanitize-html` (framework optional peer dep) or regex stripping.

**`ia_get_text` separate from `ia_get_item`.** `ia_get_item` returns metadata + file manifest, not content. Fetching text content is a distinct, potentially large second request. Keeping it separate lets agents skip it when they only need metadata and file URLs.

**Metadata API `{}` empty response = not found.** The API returns HTTP 200 with `{}` for unknown identifiers rather than 404. The service layer must check for empty response and throw `notFound`.

**Advanced Search empty query = HTML fallback.** The API returns an HTML error page (not JSON) when `q` is empty. Service must validate non-empty query before calling.

**CDX array-of-arrays format.** First element is the header row `["timestamp","statuscode",...]`; subsequent elements are data rows. Service strips the header and maps remaining rows to objects by index position. This is stable across CDX field selections.

**`ia_search_items` output includes pagination context.** The Solr API returns `response.numFound` and `response.start`. The output schema must expose `total_found: number` and `page: number` / `rows: number` so agents know whether they're seeing 5 of 5 or 5 of 50,000 results, and can paginate correctly without guessing.

**No DataCanvas.** Capture lists and search results are discovery surfaces — agents use them to find a specific item then drill in, not to run aggregates. `collapse` + `limit` handle large CDX histories at the API level.

**Resource scope is minimal.** One resource (`ia://item/{identifier}`) covers the stable-URI injectable-context use case. CDX history and search results change too fast to be meaningful as resources.

---

## Known Limitations

- CDX can time out for extremely popular URLs even with `collapse=timestamp:8` — service wraps in a generous timeout and the tool communicates partial results via the resume key
- `ia_get_snapshot` text extraction drops embedded scripts, styles, and navigation menus intentionally — agents needing raw HTML should use the replay URL directly
- Items in restricted collections return metadata but download URLs may 403 — `ia_get_text` surfaces this in the error rather than failing silently
- Copyright varies widely by item; the `licenseurl` and rights fields are surfaced as-is without legal interpretation
- The Advanced Search Solr index has a lag — very recently uploaded items may not appear

---

## API Reference

### Wayback Availability
```
GET https://archive.org/wayback/available?url={url}&timestamp={YYYYMMDDHHmmss}
Response: { url, archived_snapshots: { closest?: { url, timestamp, status, available } }, timestamp }
Not-found: archived_snapshots = {} (HTTP 200)
```

### Wayback CDX
```
GET https://web.archive.org/cdx/search/cdx?url={url}&output=json
  &fl=timestamp,statuscode,mimetype,original,digest,length   (field selection)
  &collapse=timestamp:8                                       (one per day)
  &from=YYYYMMDD&to=YYYYMMDD                                  (date range)
  &filter=statuscode:200                                      (status filter)
  &limit=100                                                  (cap)
  &showResumeKey=true                                         (pagination token)
  &resumeKey={key}                                            (continue from)
Response: array-of-arrays; row[0] = header; row[N] = data; last two rows = ["", resumeKey] when more exist
Error: empty array or HTTP 503/504 on missing url param or overloaded query
```

### Advanced Search
```
GET https://archive.org/advancedsearch.php?q={solr_query}&output=json
  &fl[]=identifier&fl[]=title&fl[]=creator&fl[]=mediatype&fl[]=date&fl[]=downloads
  &rows=50&page=1&sort[]=downloads+desc
Response: { responseHeader: { status, QTime }, response: { numFound, start, docs: [...] } }
Error: HTML page on empty q= or auth error
```

### Metadata API
```
GET https://archive.org/metadata/{identifier}
Response: { metadata: {...}, files: [{name, format, size, md5, ...}], ... }
Not-found: {} (HTTP 200)
```
