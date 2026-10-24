# Internet Archive MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `ia_find_snapshots` | Find Wayback Machine snapshots of a URL. Mode `closest` returns the single nearest capture to a given timestamp via the Availability API, falling back to a CDX closest-capture query when the Availability API has no answer. Mode `history` returns the full capture list via CDX — filterable by date range and HTTP status, collapsed by default to one capture per day. Returns timestamps and `https://web.archive.org` replay URLs. At most 10,000 records per call — a larger `limit` is served as 10,000 with a notice naming `resume_key` — and resume-key pagination for large histories. | `url`, `mode` (`closest`\|`history`), `timestamp` (closest mode), `from`/`to`, `status_filter`, `limit`, `collapse` (`timestamp:N` precision, default `timestamp:8`), `resume_key` (history mode) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `ia_get_snapshot` | Fetch the archived content of a URL at a specific Wayback timestamp. Resolves to the nearest available capture when the exact timestamp has no snapshot. Returns the archived text content (HTML stripped to readable text) and the replay URL and timestamp of the capture Wayback served. | `url`, `timestamp` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `ia_search_items` | Search the Internet Archive library (40M+ items) via the Advanced Search / Solr API. Filter by media type, collection, creator, date range, and language. Sort by downloads (the default), date, title, or random, with ties ordered by `identifier`. Returns identifiers, titles, creators (the first 10, with `creator_count` when a record lists more), media types, dates, download counts, collections (without `fav-` favorites lists), `total_found`, and current `page`/applied `rows` for pagination context. At most 200 rows per call — a larger `rows` on page 1 is served as 200 with a continuation notice — within Advanced Search's 10,000-result window. | `query`, `mediatype`, `collection`, `creator`, `date_from`/`date_to`, `language`, `sort`, `rows`, `page` | `readOnlyHint: true`, `openWorldHint: true` |
| `ia_get_item` | Retrieve metadata and the file manifest for an Archive item by identifier. Returns title, creator, description, subjects, collections, license, language, the full `file_count`, and a page of files (default 50, at most 500 per call — a larger `max_files` is served as 500) with format, size, and direct download URL, optionally filtered to one format. The primary hub for acting on a search result. | `identifier`, `format`, `max_files`, `file_offset` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `ia_get_text` | Retrieve readable OCR DjVuTXT or plain text by identifier. Page by UTF-16 offset or an expiring continuation token; return `has_more`, source-file metadata, and the next token when available. | `identifier`, `max_chars`, `char_offset`, `continuation` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |

### Error Contracts

| Tool | `reason` | Code | When |
|:-----|:---------|:-----|:-----|
| `ia_find_snapshots` | `missing_timestamp` | `InvalidParams` | Closest mode called with no `timestamp`, `""`, or a whitespace-only one; thrown before any Availability or CDX request |
| `ia_find_snapshots` | `no_snapshots` | `NotFound` | CDX returned zero results for the given URL/filters |
| `ia_find_snapshots` | `invalid_resume_key` | `ValidationError` | Server cursor is malformed, missing, expired, or unavailable in the current tenant; restart the history query |
| `ia_find_snapshots` | `resume_key_conflict` | `ValidationError` | Explicit URL, collapse, date bounds, or status filter conflicts with the server cursor's query; retain the cursor's original query or start a new one |
| `ia_find_snapshots` | `no_snapshot_available` | `NotFound` | Closest mode: neither the Availability API nor the CDX fallback has a capture near the timestamp. Either mode: CDX (history or fallback) or the Availability API answered 403, 410, or 451 — the Wayback Machine does not serve the URL — after one request, with a hint that no capture of it can be read |
| `ia_find_snapshots` | `cdx_unavailable` | `ServiceUnavailable` | CDX answered HTTP 5xx or a network error after retries, 429 or a request timeout (on headers or body) after one request, another 4xx after one request (`retryable: false`, a hint naming `url`, `from`, `to`, and `resume_key`), or a 200 carrying an HTML page or unparseable body; in closest mode, the CDX fallback failed or ran past its deadline after the Availability API found nothing |
| `ia_find_snapshots` | `availability_unavailable` | `ServiceUnavailable` | Closest mode: the Availability API answered HTTP 5xx or a network error after retries, 429 or a request timeout after one request, another 4xx after one request (`retryable: false`, a hint naming `url` and `timestamp`), or a 200 carrying an HTML page or unparseable body |
| `ia_get_snapshot` | `no_snapshot_available` | `NotFound` | Neither the Availability API nor the CDX fallback has a capture near the requested timestamp, the replay returned 404, the replay is an archived error page (a non-2xx carrying `Memento-Datetime`, answered after one request; the message names the capture timestamp and archived status), or the replay answered another 4xx without `Memento-Datetime` (after one request, naming the status). A 403, 410, or 451 from the replay or from either lookup API says the Wayback Machine does not serve the URL and carries a hint that no capture of it can be read |
| `ia_get_snapshot` | `content_fetch_failed` | `ServiceUnavailable` | Wayback unreachable during the closest-capture lookup or the archived-page fetch: 5xx (504 included), 408, 425, or a network error after retries, 429 answered after one request with a wait hint, a request timeout after one request, a lookup 4xx refusal after one request, or an unreadable lookup response; or the CDX fallback did not complete. Keeps the lookup's own wait, refusal, or history-mode hint when it has one |
| `ia_search_items` | `invalid_mediatype` | `InvalidParams` | `mediatype` is neither one of the ten canonical media types nor a recognized alias (case-insensitive); thrown before any Advanced Search request, with a recovery listing the ten values |
| `ia_search_items` | `invalid_date_range` | `ValidationError` | A nonblank date bound is not a real Gregorian `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`; answered before any Advanced Search request, naming the field and accepted formats |
| `ia_search_items` | `rows_over_cap` | `InvalidParams` | `rows` above 200 with `page` ≥ 2; thrown before any request. Page 1 serves an over-cap `rows` at 200 instead |
| `ia_search_items` | `page_limit_exceeded` | `InvalidParams` | `page × rows` (the `rows` actually sent, after the 200 cap) exceeds 10,000; thrown before any request, the message naming the last reachable page for that `rows` |
| `ia_search_items` | `invalid_query` | `InvalidParams` | Advanced Search answered an `error` body that blames the request — an untagged query parse error, `[UNSUPPORTED_SORT]`, `[MALFORMED_QUERY]` (an unquoted URL), or `[UNSUPPORTED_VALUE]` (a `q` past 2,047 characters, filters included); answered after one request, relaying the upstream text on one line |
| `ia_search_items` | `search_unavailable` | `ServiceUnavailable` | Advanced Search answered any other `error` body (`[BACKEND_ERROR]`, an unknown tag), a 429, another 4xx, or a request timeout (on headers or body) after one request, or a 5xx, a network error (a connection dropped mid-body included), an HTML page, an unparseable body, or a body without `response` after retries. A 4xx other than 429 carries `retryable: false`, no upstream body, and a hint that repeating the request will not help. A timeout, a network error, a 5xx, an HTML page, an unparseable body, or a body with neither key carries a throw-site hint that Advanced Search is down or unreachable and to call again in a few minutes. The declared recovery, which the `error` bodies keep, names the query text that reaches `[BACKEND_ERROR]` |
| `ia_get_item` | `item_not_found` | `NotFound` | Metadata API returned `{}` (identifier does not exist), a dark item, or a body with neither `metadata` nor `files` (its `error` or `result` answer for an identifier with a `/` in it) |
| `ia_get_item` | `archive_unavailable` | `ServiceUnavailable` | Metadata API answered HTTP 5xx, 408, 425, a network error (a connection dropped mid-body included), an HTML page, or an unparseable body after retries; a request timeout (on headers or body) after its second occurrence, a first timeout being retried once; 429 (with a wait hint) after one request; another 4xx after one request with `retryable: false` and a hint to verify the identifier. No upstream body in `data` |
| `ia_get_text` | `item_not_found` | `NotFound` | As for `ia_get_item` |
| `ia_get_text` | `no_text_file` | `NotFound` | Item exists but `files[]` contains no DjVuTXT or plain-text file |
| `ia_get_text` | `ambiguous_pagination` | `ValidationError` | Both a nonblank continuation token and an explicit `char_offset` were supplied |
| `ia_get_text` | `invalid_continuation` | `ValidationError` | Cursor is invalid, expired, belongs to another item or tenant, or names a changed text file; recovery gives an offset call |
| `ia_get_text` | `range_unavailable` | `ValidationError` | The text response does not honor the requested byte range; recovery gives an offset call |
| `ia_get_text` | `download_forbidden` | `Forbidden` | Text file download returned HTTP 401 (login required) or 403 (limited collection), after one request |
| `ia_get_text` | `archive_unavailable` | `ServiceUnavailable` | The metadata request failed as for `ia_get_item`, or the text file download did: 5xx, 408, 425, or a network error after retries; a request timeout (on headers or a stalled body) after its second occurrence, a first timeout being retried once; 429 (with a wait hint) after one request; another 4xx (404, 410, 451, …) after one request with `retryable: false` and a hint to check the manifest with `ia_get_item`. The recovery says a timed-out download can time out again on retry |
| `ia://item/{identifier}` | `item_not_found` | `NotFound` | As for `ia_get_item` |
| `ia://item/{identifier}` | `archive_unavailable` | `ServiceUnavailable` | As for `ia_get_item` |

Every upstream failure on every tool surfaces under a declared reason with no upstream body in `data`; only a caller cancellation (`RequestCancelled`), a caller-side deadline (`Timeout`), and the remaining baseline errors (`InternalError`, `ValidationError`) carry none. A blank `query`, `identifier`, or `url` (empty or whitespace-only) never reaches a handler: the input schema rejects it as the framework's `invalid_arguments` (`InvalidParams`).

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
- Wayback Availability API: `GET archive.org/wayback/available?url=&timestamp=` — closest snapshot to a given time, single-result response; answers `archived_snapshots: {}` for some heavily archived URLs that have captures
- Wayback CDX API: `GET web.archive.org/cdx/search/cdx?url=&output=json` — full capture history; array-of-arrays with header row; supports field selection (`fl`), collapsing (`collapse`), date range (`from`/`to`), status filtering, resume-key pagination, and closest-first ordering (`closest=&sort=closest`)
- Advanced Search API: `GET archive.org/advancedsearch.php?q=&output=json` — Solr-based; `response.docs` envelope; supports `fl[]` field selection, `rows`, `page`, `sort[]`; reports a rejected request as HTTP 200 with `{"error": "…"}` and no `response`; serves no result past the 10,000th
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
| `IA_REQUEST_TIMEOUT_MS` | No | HTTP request timeout in milliseconds, covering the headers and the body of each upstream request. A positive integer; anything else fails startup naming the variable. Default `30000` |
| `IA_MAX_SNAPSHOT_CHARS` | No | Default and maximum characters per `ia_get_text` page — a larger `max_chars` is served at this value, with a notice — and the text cap for `ia_get_snapshot`. A positive integer; anything else fails startup naming the variable. Default `50000` |

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
| 1 | `GET /cdx/search/cdx?url=&fl=timestamp,statuscode,mimetype,original,digest,length&collapse=timestamp:8&limit=N&showResumeKey=true` | For exact-URL timestamp collapse, fetch the applied page size plus one row; a server cursor resumes inclusively at its saved next timestamp through `from`. Legacy raw keys still use `resumeKey` |
| — | Parse header row; strip it; map rows to objects | Local transform (no extra call) |
| — | Strip trailing `[]` or `[""]` separators and their key; expose a server cursor or legacy key as `resume_key` | Exact-URL timestamp cursors keep the unreturned row for the next page; legacy and wildcard continuation carries an incompleteness notice |

### `ia_get_snapshot` 

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /wayback/available?url=&timestamp=` | Resolve nearest snapshot URL (skipped for an exact 14-digit timestamp) |
| 1b | `GET /cdx/search/cdx?url=&closest=&sort=closest&limit=10&fl=timestamp,original,statuscode` | Only when step 1 has no answer: nearest capture, preferring a `200` row; one attempt, 25 s deadline |
| 2 | `GET web.archive.org/web/{resolved_timestamp}/{url}` | Fetch archived HTML; Wayback may redirect to the capture it actually serves |
| — | Stream at most 4 MiB of the body (cancel the rest); decode with the declared or guessed charset; remove markup, decode character references, collapse whitespace; truncate if needed | Local transform |

### `ia_search_items`

| # | Call | Purpose |
|:--|:-----|:--------|
| — | Reject `rows` > 200 past page 1 and `page × rows` > 10,000; cap `rows` at 200 on page 1 | Local check, no request |
| — | Trim date bounds, validate Gregorian dates, and expand year/month bounds to the period's first or last day | Local check, no request; omitted sides use `*`, and both omitted means no date filter |
| 1 | `GET /advancedsearch.php?q=&fl[]=...&rows=&page=&sort[]=&output=json` | Solr search with field projection |
| — | Classify an `error` body; drop `fav-` entries from `collection`; cut `creator` to 10 with `creator_count` | Local transform |

### `ia_get_item`

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /metadata/{identifier}` | Metadata + file manifest |
| — | Filter `files[]` by `format`, then slice `[file_offset, file_offset + min(max_files, 500)]`; report `file_count` and the match count | Local paging |

### `ia_get_text`

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /metadata/{identifier}` | Locate DjVuTXT or plain-text file in `files[]` |
| 2 | `GET archive.org/download/{identifier}/{filename}` with identity encoding; conditional byte Range when continuing | Validate the representation and byte range, stream-decode up to the page's end, then cancel the read |
| — | Keep the requested UTF-16 page plus lookahead; report the manifest `size` as `source_file_bytes` | Save a tenant-scoped decoder checkpoint when a stable validator and cursor storage are available; no document text is stored |

---

## Design Decisions

**Two Wayback tools, not one.** `ia_find_snapshots` (discovery) and `ia_get_snapshot` (retrieval) separate the "what snapshots exist" workflow from the "show me what the page said" retrieval. Merging them conflates two distinct agent intents and would produce an awkward dual-mode shape. The `mode` parameter inside `ia_find_snapshots` is a good fit because both modes answer the same question ("what snapshots exist?") via different API paths — that's within-tool disambiguation, not two separate goals.

**CDX collapse default.** Popular URLs have tens of thousands of captures. Default `collapse=timestamp:8` (one per day) keeps responses tractable. The `collapse` parameter accepts `timestamp:N` where N is 1–14 (precision digits: 4=year, 6=month, 8=day, 10=hour, 14=second), validated with `z.string().regex(/^timestamp:\d{1,2}$/)`; arbitrary strings are rejected. An omitted or blank `collapse` is unset, per the blank-optional convention, so both send the `timestamp:8` default. `timestamp:14` is the finest listing — one row per distinct capture second (`example.com` in 2015: 364 rows at the default, the 10,000 cap at `timestamp:14`).

**No `ia_get_snapshot` HTML passthrough.** Raw Wayback HTML is rewritten by the archive (banner injections, relative URL rewriting) and can be very large. The tool strips to readable text and always returns the replay URL so the human can open the original in a browser.

**Text extraction is one linear markup scan, then one reference decode.** A hand-written left-to-right index scan (comment, script/style with raw-text body, any other tag; a quote opens an attribute value only after `=`, as in a browser) replaces each construct with a space, then one callback pass decodes `;`-terminated references against a curated `Map` (HTML 4.01's 252 names plus `apos` and the WHATWG upper-case aliases) with WHATWG numeric rules. Decoding once rules out double-unescaping; no dependency is needed, since a 20-page 1996–2015 corpus used no name outside that table. The scan is index arithmetic rather than a regex so it stays linear on adversarial archived pages in any engine — the earlier regex chain went quadratic, and a regex alternative measured linear in V8 still hit JavaScriptCore's backtracking-stack fallback on long tags under Bun.

**Decode by declared charset.** The replay serves `Content-Type: text/html` with no charset, so the body is decoded from bytes: BOM, then header charset, then the first `<meta>` declaration in the first 16 KiB (past the ~1 KiB banner Wayback injects). A body that declares none stays UTF-8 when a strict UTF-8 decode succeeds; only bytes that are not UTF-8 fall back to Wayback's `x-archive-guessed-charset` (when `TextDecoder` knows the label), else windows-1252. The guess never overrides valid UTF-8 because it is unreliable — a Latin-1 slashdot.org 1999 capture is guessed `ibm852`, and a wrong single-byte guess would turn a valid UTF-8 page into mojibake. On a body cut at the read limit, a character split at the cut is dropped before the strict check, so the cut cannot fail it.

**Read at most 4 MiB of a replay.** The body is streamed and cut at 4 MiB, cancelling the upstream read, and the tool discloses the cut in a `notice`. Measured on 2024 captures of heavy pages, a 3.0 MB edition.cnn.com front page yields all its text within 1.3 MB and Wikipedia articles reach 50,000 characters within 440 KB, so ordinary pages lose nothing.

**Report the capture Wayback served.** Wayback 302-redirects a timestamp that is not itself a capture, and a redirect capture to the capture it points at. `replay_url` is the URL the fetch ended on (always `https://web.archive.org`), `resolved_timestamp` is read from it, and `resolved_status` is the HTTP status of that final replay response (Wayback's own `x-ts` header carries the same value), so all three name the capture the text came from — never the capture the lookup resolved.

**Closest lookup falls back to CDX.** The Availability API sometimes answers `{}` for URLs CDX has captures of, so an empty answer (and only an empty answer — never an error or a cancellation) triggers one CDX `sort=closest` query. A successful Availability answer costs one request, as before. The fallback gets one attempt under a 25 s deadline: measured `sort=closest` latencies ran 2.5–23 s for about half the URLs tried and 31 s to over 60 s for the rest, so no retry ladder could help and the deadline keeps the call under the 30 s request timeout. A fallback that fails or times out is `cdx_unavailable` (`content_fetch_failed` in `ia_get_snapshot`) with a history-mode hint — never `no_snapshot_available`, which would claim there is no capture.

**Upstream non-2xx answers surface as a declared reason, never with the upstream body.** `fetchWithTimeout` throws on every non-2xx with the body in `data`, so each service reclassifies inside its retry closure, allowlisting what `data` carries: CDX → `cdx_unavailable`, Availability → `availability_unavailable`, Advanced Search → `search_unavailable`, Metadata API and text downloads → `archive_unavailable`. A 5xx, 408, or 425 keeps `retryAfter`/`retryable`, so attempt counts are unchanged (Advanced Search treats 408 and 425 as refusals). A 429 is answered after one request with a hint to wait (the `Retry-After` value when it is delta-seconds or a future HTTP-date, otherwise several minutes) — retrying it would only extend a rate limit that, measured, held for 5–13 minutes. The retry predicate stops it rather than `retryable: false`, which would put "not retryable" on the wire beside a hint to wait and retry. Any other 4xx is a refusal no retry fixes: answered after one request with `retryable: false` and a throw-site hint naming what the caller can check (the query, the identifier, the item's file list, `url`/`from`/`to`/`resume_key`, or `url`/`timestamp`), since each declared recovery promises a later retry. A 401/403 text download stays `download_forbidden`, and a 403, 410, or 451 from a Wayback API is the URL not being served (below). An HTML page or unparseable JSON on a 200 is treated as the same reason and retried like a 5xx. `ia_get_snapshot` maps any `ServiceUnavailable` from lookup or fetch onto its own `content_fetch_failed`, keeping its hint and retry fields, since the service cannot know which tool's reason set applies.

**Timeouts and network errors surface as the same declared reason.** A request timeout — `fetchWithTimeout`'s own deadline, on the headers or a stalled body — is not retried on the Wayback and Advanced Search paths: the attempt already waited the full `IA_REQUEST_TIMEOUT_MS` on an upstream that did not answer, and further attempts would hold the caller past common client tool-call timeouts. The Metadata API and text download paths retry a first timeout once and end the call on a second, so a call waits at most two request timeouts on either: archive.org's metadata and download hosts stall intermittently and usually answer a second request, which a single attempt turned into `archive_unavailable`. A timed-out `ia_get_text` download can still time out again on a later call, which its declared recovery says. A network error (refused, reset, a DNS failure, or a connection dropped mid-response) fails fast, so it keeps its four attempts. Both surface after the retry loop as that path's reason (CDX → `cdx_unavailable`, Availability → `availability_unavailable`, page fetch → `content_fetch_failed` through the tool, Advanced Search → `search_unavailable`, Metadata API and text download → `archive_unavailable`), without `retryable: false`, since a later call can succeed. The classification, the retry predicate, and the 429 wait phrase live in one module (`src/services/upstream-errors.ts`) that all three services share. `withRetry`'s `deadlineMs` was rejected for this: it would also cut short the 5xx ladders whose attempt counts stay unchanged. Caller cancellation and a caller-side deadline pass through untouched.

**`archive_unavailable` is one reason for both item tools and the resource.** `ia_get_item`, `ia_get_text`, and `ia://item/{identifier}` share `ArchiveMetadataService.getItem`, so a Metadata API failure reaches all three under the same name; `ia_get_text`'s download failures use it too, since no existing reason's recovery was true for them (`download_forbidden` says the item is restricted). Its `ia_get_text` recovery adds that a timed-out download can time out again on retry.

**An archived error page is `no_snapshot_available`, not a Wayback failure.** Wayback replays a capture of a site's 4xx or 5xx page with that status and a `Memento-Datetime` header (RFC 7089), which a Wayback failure of its own does not carry. The replay fetch captures that header on a non-2xx, and one carrying it is not retried and surfaces as `no_snapshot_available`, naming the capture timestamp and archived status, on the exact-timestamp and lookup paths alike. `content_fetch_failed`'s retry hint would be false for it, while history mode with `status_filter: "200"` finds a readable capture. Returning the error page's text as a success was rejected: it turns a failure into a success shape. Without the header, a 429 is still answered after one request, a 5xx, 408, or 425 retried, and a 404 is `no_snapshot_available`.

**A replay 4xx without `Memento-Datetime` is Wayback refusing the request.** Wayback answers a site excluded from the archive with a 403 and its own playback page, no `Memento-Datetime`. Every such 4xx except the 404, 408, 425, and 429 above is not retried and surfaces as `no_snapshot_available` naming the status, never carrying the playback page as `data.body`. A 403, 410, or 451 says the Wayback Machine does not serve the URL and overrides the declared history-mode hint, which cannot help: no capture of an excluded URL can be read at any timestamp. Another 4xx (a 400 for a malformed replay URL, an unfollowed 3xx) keeps the declared hint.

**A lookup 403, 410, or 451 is the URL not being served, not an outage.** CDX answers the same excluded site with a 403. History mode, the closest-mode CDX fallback, and the Availability API all map 403, 410, and 451 to `no_snapshot_available` after one request, with the replay's message and hint (shared from `wayback-service.ts`). `cdx_unavailable` was rejected for it: its "did not complete, retry" framing sends callers back to a URL that can never be read, including through `ia_get_snapshot`, whose timestamps shorter than 14 digits resolve through the fallback. The fallback lets this answer through unwrapped, and words any other refusal it wraps without "retry later".

**`ia_get_text` separate from `ia_get_item`.** `ia_get_item` returns metadata + file manifest, not content. Fetching text content is a distinct, potentially large second request. Keeping it separate lets agents skip it when they only need metadata and file URLs.

**Text continuation keeps a decoder checkpoint.** Text pages count UTF-16 code units and match slicing the whole decoded file, including BOMs, malformed UTF-8, and a page boundary inside a surrogate pair. An opaque, expiring tenant-scoped cursor binds the item, selected filename, and stable representation validator to a byte checkpoint and intra-character skip. Conditional identity-encoded Range requests resume there; the response status, range, and validator must agree before decoding. No document text is stored. Offset paging remains available when a validator or cursor storage is unavailable, with a notice. Memory stays bounded by the page and lookahead; `max_chars` retains its configured cap and `source_file_bytes` reports manifest bytes rather than a guessed character count.

**Collapsed history uses an unreturned timestamp.** For exact URLs with `timestamp:N` collapse, N=1–14, one extra row identifies where the next page begins. The tenant-scoped expiring cursor retains the query filters and resumes inclusively at that row's timestamp, preserving page boundaries while allowing a different page size. Legacy CDX keys and wildcard histories keep their existing path with an incompleteness notice. A byte offset or CDX raw resume key cannot supply the same collapsed-page guarantee.

**Partial dates expand at the search boundary.** `date_from` uses the first day of a requested year or month, and `date_to` uses its last day under Gregorian leap-year rules. Invalid dates fail before HTTP with `invalid_date_range`; the advertised inputs remain free strings so the error can name the field and recovery. Blank bounds are omitted, and reversed valid ranges retain the upstream empty-result behavior.

**`ia_get_item` pages the manifest in the handler, not the service.** Most items have a few dozen files, but scanned books and collections carry hundreds to thousands (mostly per-page derivatives), which put megabytes on both response surfaces. The handler filters by `format` and slices by `max_files`/`file_offset` so `structuredContent` and `content[]` carry the same page; `ArchiveMetadataService.getItem` keeps returning the full manifest because `ia_get_text` scans every file for its text source. Truncation and the match count go through the enrichment block (`truncated`, `totalCount`, `notice`) rather than a domain field.

**Over-cap `max_files` and `limit` are served at the cap.** Both are workload caps on a read, so a value between the cap and a hard ceiling is served at the cap rather than rejected: `max_files` 501–300,000 at 500, history-mode `limit` 10,001–150,000 at 10,000 returned records. Exact-URL timestamp-collapse histories request one additional row for continuation. When the cap withholds results the response sets `truncated`/`shown`/`cap` with the applied value and a notice naming the next `file_offset` or `resume_key`. Closest mode never reads `limit`.

**Metadata API `{}` empty response = not found.** The API returns HTTP 200 with `{}` for unknown identifiers rather than 404, so the service throws `item_not_found` for it. The same goes for any body with neither `metadata` nor `files`: an identifier with a `/` in it addresses a sub-path, which answers `{"error": "Couldn't get 'b' for item a"}` or a bare `{"result": …}` with HTTP 200 — no item, though it would otherwise read as one with no metadata and no files.

**Advanced Search empty query = HTML fallback.** The API returns an HTML error page (not JSON) when `q` is empty, so a blank query must never reach it. The `query` schema enforces that (see the next note), so the service carries no guard of its own.

**Required strings reject blanks at the schema.** `query`, both `identifier`s, and both `url`s are `z.string().trim().min(1)`. A blank value is structurally wrong and no tool-specific guidance would help, so it belongs on the schema, where it also advertises `minLength: 1`; each `.min(1)` message names what to send. Surrounding whitespace is trimmed before the handler runs.

**`mediatype` resolves in the handler, not through `z.enum`.** Solr matches `mediatype` exactly and case-sensitively, so `text` or `Texts` answered zero results as an empty success. The handler trims, lowercases, maps a fixed alias table (`text`/`book`/`books` → `texts`, `movie`/`video`/`videos` → `movies`, `images` → `image`, `collections` → `collection`), and rejects anything else as `invalid_mediatype` listing the ten values. A `z.enum` would reject the near-misses instead of resolving them, and `z.preprocess` does not serialize to JSON Schema. The ten values are the full vocabulary of the index (an aggregation over it, 2026-09-24); a blank `mediatype` still means no filter.

**Closest mode's timestamp requirement is a handler guard.** Whether `timestamp` is required depends on `mode`, and a schema refinement neither shows in the tool's input schema nor carries a declared reason. The handler throws `missing_timestamp` (`InvalidParams`) with a recovery naming the format and history mode — never `no_snapshot_available`, which claims the URL has no captures.

**An empty search page says why.** Advanced Search answers a page past the end with `numFound > 0` and no docs, so the empty-result notice distinguishes that case (naming the last page) from a search that matched nothing (naming the `mediatype` applied, if any).

**Advanced Search error bodies are errors, never empty pages.** A rejected request comes back as HTTP 200 with `{"error": "…"}` and no `response`, so the service checks for `error` before reading `response`; a genuinely empty result still carries `response` with `numFound: 0`. An untagged message (a query parse error), `[UNSUPPORTED_SORT]`, `[MALFORMED_QUERY]` (an unquoted URL), and `[UNSUPPORTED_VALUE]` (a `q` past 2,047 characters, filters included) blame the request and surface as `invalid_query` with the upstream text, its whitespace collapsed to one line; `[BACKEND_ERROR]` and any other tag surface as `search_unavailable`. `[BACKEND_ERROR]` was only ever observed for query text — a bare `AND`, `title:`, `AND AND`, or `&`, `%`, `/`, `!`, `;` inside a word (`AT&T`, `100%`, `1/2`), deterministic on repeat and cleared by quoting the phrase behind a field prefix — but it names a backend fault, so it stays `search_unavailable` with a recovery naming those inputs. Neither is retried (`retryable: false` on the unavailable case), so the recovery promises no retry for them. A 5xx is retried, and a 429 or another 4xx answered after one request, the 429 with a wait hint and the 4xx with `retryable: false` and a hint that repeating it will not help (a control character in `q` draws a 400), neither carrying the upstream body; an HTML page, unparseable JSON, or a body with neither key is retried like a 5xx. Those outages, a timeout and a network error included, carry their own hint that Advanced Search is down, since the declared recovery's query-text advice is wrong for a query that never reached the backend.

**`query` is capped at 2,047 characters.** Advanced Search rejects a composed `q` longer than 2,047 characters as `[UNSUPPORTED_VALUE]`, so a longer `query` can never succeed; the schema rejects it before a request, and a shorter one that the filters take past the limit still reaches `invalid_query`.

**Ties under the sort break by `identifier`.** Advanced Search orders tied rows arbitrarily from one request to the next, so consecutive pages repeat and skip them: 28 and 43 of 200 rows overlapped between pages 1 and 2 of `downloads:0 AND subject:news` sorted `downloads desc`, in two runs on 2026-10-12. Every search therefore sends `identifier asc` as a second `sort[]`, which made that overlap 0 and left the first page of a query without ties (`tesla`) in the same order. A `random` sort is sent alone, since Advanced Search rejects any other sort beside it. There is no relevance sort: `score desc` and `relevance desc` are `[UNSUPPORTED_SORT]`.

**The 10,000-result window is checked before any request.** Advanced Search rejects a page whenever `page × rows` exceeds 10,000 (measured at rows 1, 7, 30, 50, and 200, for queries matching 0, 286, and about 75,700 items), so the handler throws `page_limit_exceeded`, naming `floor(10000 / rows)` as the last reachable page. It checks the `rows` actually sent, after the 200 cap. Reaching results past the window needs the cursor-based Scraping API, which would replace `page`.

**Over-cap `rows` is served at the cap on page 1 only.** A `rows` from 201 to 10,000 has one reading on page 1 — as many as one call allows — so it is served as 200 with `truncated`/`shown`/`cap` and a notice naming `rows: 200, page: 2`, which resumes at result 201. On later pages it rejects as `rows_over_cap`: pages are `rows`-sized blocks and Advanced Search ignores a `start` offset, so the remainder of a 500-row page 2 starts at result 701, which no `rows`/`page` pair at 200 addresses. The output `rows` reports the applied value, so the past-last-page arithmetic stays consistent. Above 10,000 no request can be served, so the schema rejects it.

**Search results drop `fav-` collections and cap `creator` at 10.** Advanced Search lists a `fav-<account>` entry among an item's collections for every account that favorited it — hidden per-account lists, absent from the item's own metadata — which put a default 50-row `tesla` page at 231 KB (2026-10-12; 11 KB without them). They are filtered by prefix, never by position, since real collections can follow one; `collection` is omitted when nothing else remains. `creator` keeps its first 10 names (an 8,613-item sample peaked at 8; large collaborations run to 409) and a per-row `creator_count` gives the full count when it was cut; `ia_get_item` returns the full list. `title` and `date` arrive as lists on a few records and are relayed as received.

**CDX array-of-arrays format.** First element is the header row `["timestamp","statuscode",...]`; subsequent elements are data rows. Service strips the header and maps remaining rows to objects by index position. This is stable across CDX field selections.

**`ia_search_items` output includes pagination context.** The Solr API returns `response.numFound` and `response.start`. The output schema must expose `total_found: number` and `page: number` / `rows: number` so agents know whether they're seeing 5 of 5 or 5 of 50,000 results, and can paginate correctly without guessing.

**No DataCanvas.** Capture lists and search results are discovery surfaces — agents use them to find a specific item then drill in, not to run aggregates. `collapse` + `limit` handle large CDX histories at the API level.

**Resource scope is minimal.** One resource (`ia://item/{identifier}`) covers the stable-URI injectable-context use case. CDX history and search results change too fast to be meaningful as resources.

---

## Known Limitations

- CDX can time out for extremely popular URLs even with `collapse=timestamp:8` — the timeout surfaces as `cdx_unavailable` after one request; a `from`/`to` range or a smaller `limit` keeps the query cheaper, and the resume key pages through the rest
- `ia_get_snapshot` text extraction drops scripts, styles, comments, and markup; navigation and other page chrome stay in the text — agents needing raw HTML should use the replay URL directly
- A page with no charset declaration that is not valid UTF-8 decodes with Wayback's guessed charset or windows-1252; a wrong guess can still substitute letters in a page that is neither UTF-8 nor windows-1252
- The CDX `sort=closest` fallback often takes longer than its 25 s deadline for heavily archived URLs; closest mode then reports `cdx_unavailable` and points at history mode
- `ia_get_snapshot` reads at most the first 4 MiB of a page
- Text and history cursors expire after one hour and depend on the configured state store; restarting an in-memory deployment invalidates its cursors. A changed text representation invalidates its text cursor. Offset paging and a fresh history query remain available
- Legacy CDX resume keys and wildcard history paging may omit captures across page boundaries; their responses disclose this limitation
- `ia_get_text` reports no total character count — a document's length is known only once a page reaches its end (`has_more: false`); `source_file_bytes` gives the file's size in bytes, and UTF-8 text other than ASCII takes more than one byte per character
- Items in restricted collections return metadata but download URLs may 403 — `ia_get_text` surfaces this in the error rather than failing silently
- Copyright varies widely by item; the `licenseurl` and rights fields are surfaced as-is without legal interpretation
- The Advanced Search Solr index has a lag — very recently uploaded items may not appear

---

## API Reference

### Wayback Availability
```
GET https://archive.org/wayback/available?url={url}&timestamp={YYYYMMDDHHmmss}
Response: { url, archived_snapshots: { closest?: { url, timestamp, status, available } }, timestamp }
  (closest.url uses http://web.archive.org — the service upgrades it to https)
Not-found: archived_snapshots = {} (HTTP 200) — also returned for some URLs that have captures
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
  &closest={timestamp}&sort=closest                           (nearest captures first)
Response: array-of-arrays; row[0] = header; row[N] = data; trailing [] or [""] followed by [resumeKey] when more exist
Error: empty array or HTTP 503/504 on missing url param or overloaded query
```

### Advanced Search
```
GET https://archive.org/advancedsearch.php?q={solr_query}&output=json
  &fl[]=identifier&fl[]=title&fl[]=creator&fl[]=mediatype&fl[]=date&fl[]=downloads&fl[]=collection
  &rows=50&page=1&sort[]=downloads+desc&sort[]=identifier+asc
Response: { responseHeader: { status, QTime }, response: { numFound, start, docs: [...] } }
Error: HTTP 200 {"error": "…"} with no response on a rejected request; HTML page on empty q= or auth error
```

### Metadata API
```
GET https://archive.org/metadata/{identifier}
Response: { metadata: {...}, files: [{name, format, size, md5, ...}], ... }
Not-found: {} (HTTP 200)
```
