<div align="center">
  <h1>@cyanheads/internet-archive-mcp-server</h1>
  <p><b>Search the Wayback Machine and IA library (40M+ items), fetch archived snapshots, retrieve item metadata and full text via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Item Resource • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.6.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/internet-archive-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/internet-archive-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/internet-archive-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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
| `ia_get_snapshot` | Fetch archived page content at a specific Wayback timestamp and, with `include_links`, the page's links |
| `ia_search_items` | Search the IA library (40M+ items) by keyword and metadata filters |
| `ia_get_item` | Retrieve full metadata and file manifest for an Archive item |
| `ia_get_text` | Retrieve readable OCR text from a text item, with paging, or starting at a phrase's first match (`find`) |

### Resources

| Resource | Description |
|:---|:---|
| `ia://item/{identifier}` | Metadata snapshot for an Archive item — title, creator, mediatype, description, subjects, collections, date, upload dates (`publicdate`, `addeddate`), license, publisher and catalog numbers, running time of an audio or video item, and file count |

Item resource data is also reachable via `ia_get_item`.

### Agent skill

The [`internet-archive-guide`](./skills/internet-archive-guide/SKILL.md) covers historical comparisons, item identity, and coverage checks. Plugin installs include it, and MCP clients can read it at `skill://internet-archive-guide/SKILL.md`.

## Capability reference

### `ia_find_snapshots` <sub>tool</sub>

- Timestamps (`timestamp`, `from`, `to`) take 1–14 digits (`YYYYMMDDHHMMSS` or a prefix of it) or an ISO 8601 date or UTC date-time such as `2020-06-15` or `2020-06-15T12:34:56Z`. A prefix names a period: as `from` it starts the period (`2015` is January 1, 2015), as `to` it ends it (`2015` reaches December 31, 2015), and as `timestamp` it resolves to the capture nearest the period's end (`2015` can resolve to one from early January 2016)
- `url` may be a Wayback capture URL (`web.archive.org/web/<timestamp>/<url>`, such as a `replay_url`), read as the URL it archives before any request. `history` lists that URL's captures and ignores its timestamp; `closest` takes it as the `timestamp` when none is given, and a `timestamp` naming a different one fails as `ambiguous_timestamp`
- `closest` mode: returns the nearest capture to a given `timestamp`, or the latest capture when `timestamp` is omitted or blank, via the Availability API, falling back to one CDX closest-capture query (preferring a `200` capture) when the Availability API finds no capture, answers 429, or 408, 425, or 5xx after retries, sends an HTML or unreadable response, or answers `200` with an `error` in place of a capture. That query gets at most 25 s, the request timeout, or the time left in the call's deadline. A timeout, network error, or 4xx refusal from the Availability API does not fall back
- Every call, either mode, ends within 55 s, or within `IA_REQUEST_TIMEOUT_MS` when that is longer; each request, retry, and backoff counts against it
- `history` mode: full capture list via the CDX API; filter by date range (`from`/`to`) and HTTP status (`status_filter`). A query no capture matches returns `snapshots: []` with a `notice` saying why: the Wayback Machine lists no captures of the URL (or none under its prefix or domain), none match the `from`, `to`, and `status_filter` sent, or none remain past the `resume_key`; the `resume_key` is kept when CDX sent one
- For an exact URL, under any `collapse`, pass the returned `resume_key` with the same URL to continue without skipping the page boundary. The cursor expires after one hour and retains the original filters; `limit` may change between pages. An invalid cursor returns `invalid_resume_key`; conflicting explicit filters return `resume_key_conflict`. Legacy CDX keys and wildcard histories remain available with a notice that pages may omit the row at a page boundary (a wildcard page may return it as a later capture of the same URL)
- A `url` ending in `*` (`example.com/docs/*`) lists the captures of every URL under that prefix, ordered by URL and then by time, and a `url` starting with `*.` (`*.example.com`) lists the captures of that domain and its subdomains. Both page by CDX's own key with a notice; a wide prefix can fail as `cdx_unavailable`, so narrow the prefix or `from` and `to`. A `*` anywhere else is part of the URL
- `collapse` is `timestamp:8` (one capture per day) when omitted or blank; adjustable to `timestamp:N` (N above 14 reads as 14; `timestamp:14` lists one row per distinct capture second and `timestamp:0` only the first capture in range), `digest` (the first capture in range and each capture whose content differs from the one before, so a change back to earlier content counts), or `urlkey` (one row per URL, its first capture in range). `status_filter` applies before the collapse, so `digest` with `status_filter: "200"` leaves out redirect captures
- Up to 10,000 records per call (`limit`, default 100); a larger `limit` (up to 150,000) is served as 10,000, setting `truncated` and a `notice` naming `resume_key` when captures remain; `resume_key` pagination for large histories
- Replay URLs are always `https://web.archive.org/web/…`
- Typed errors: `invalid_timestamp` (a `timestamp`, `from`, or `to` that is not 1–14 digits or an ISO 8601 date or UTC date-time, or names a date or time that does not exist; or a capture URL in `url` whose timestamp does the same, naming `field: "url"`; answered before any request), `ambiguous_timestamp` (closest mode, a capture URL in `url` and a `timestamp` naming a different one; answered before any request), `no_snapshot_available` (closest mode, no capture near `timestamp` from either source, or none at all when `timestamp` is omitted; or, in either mode, the Wayback Machine does not serve the URL — a 403, 410, or 451, as for a site excluded from it), `cdx_unavailable` (CDX 5xx, 429, another 4xx, timeout, network error, or unreadable response, a body that is not a list of capture rows included, or the call's 55 s deadline (`IA_REQUEST_TIMEOUT_MS` when longer) ran out; or the closest-mode CDX check did not complete after the Availability API found no capture), `availability_unavailable` (closest mode, the Availability API failed — an error status, an unreadable response, or an `error` in place of a capture — and the CDX check it fell back to failed too or ran out of time, or the Availability API answered another 4xx, timed out, did not finish within the call's 55 s deadline (`IA_REQUEST_TIMEOUT_MS` when longer), or could not be reached, none of which falls back); a 429, another 4xx, or a request timeout is answered after one request, a 429 with a hint to wait and a 4xx with a hint that repeating the request will not help

---

### `ia_get_snapshot` <sub>tool</sub>

- `timestamp` takes the forms `ia_find_snapshots` does (1–14 digits or an ISO 8601 date or UTC date-time); a blank `timestamp` reads the timestamp of a Wayback capture URL passed as `url`, else the latest capture. Resolves to the nearest available capture when the exact timestamp has no snapshot; exact 14-digit timestamps skip resolution
- `url` may be a Wayback capture URL (`web.archive.org/web/<timestamp>/<url>`, such as a `replay_url`), read as the URL it archives at its timestamp before any request; a `timestamp` naming a different one fails as `ambiguous_timestamp`
- A call ends within 55 s, or within `IA_REQUEST_TIMEOUT_MS` when that is longer; the closest-capture lookup, the page fetch, and every retry share it
- Reports the capture Wayback served — `replay_url`, `resolved_timestamp`, and `resolved_status` follow the replay's redirects, up to 10 on the Wayback Machine: Wayback's own redirect when the requested timestamp is not itself a capture, and an archived redirect (a capture of the site's own 3xx), which a `notice` names with its capture timestamp, status, and target, whether it is the capture requested or the nearest capture Wayback redirected the requested timestamp to
- An HTML page is decoded with its declared charset (byte-order mark, then `Content-Type`, then `<meta>`, else UTF-8 when the bytes are valid UTF-8, else Wayback's guessed charset or windows-1252), then scripts, styles, comments, and tags are removed and character references decoded, returning readable plain text in lines alongside the replay URL: each block element (paragraph, heading, list item, table row) and `<br>` starts a line, the cells of a table row are separated by tabs (empty cells included), `<pre>` text keeps its spacing and line breaks, and elsewhere a whitespace run reads as one space and blank lines collapse to one. Another text type (plain text, JSON, XML, JavaScript) is read as stored from the capture's `id_` form, markup and line breaks kept, decoded by the same charset order without the `<meta>` step. A capture that is not text (a PDF, an image) fails as `non_text_capture`
- Reads at most the first 4 MiB of a page (a `notice` says when a page is longer). Long text comes one page at a time: `max_chars` (default and maximum `IA_MAX_SNAPSHOT_CHARS`, 50,000 characters) sizes a page and `char_offset` starts it; `has_more` and `total_chars` say what remains, and a `notice` names the `url`, `char_offset`, and `resolved_timestamp` (as `timestamp`) that read the next page from the same capture, and `include_links true` when the call set it; after an archived redirect that `url` differs from the one sent
- `include_links` (default `false`) adds `links`, one `{ text, url }` per http(s) link target whose first occurrence starts in this page of text, in document order, and `total_links`, the count over the capture's whole text (the first 4 MiB). Each target is listed once, with the first non-empty text it is linked by; the page's own URL, other schemes (`mailto:`, `ftp:`), and fragments are left out. A link Wayback rewrote reads as the URL it archives; any other resolves against the capture's original URL or its first `<base href>`. The last page also takes links at the very end of the text, so a read that follows `has_more` with the option set lists each link once, and a smaller `max_chars` carries fewer per call. A non-HTML capture gives `[]` and `0`. It adds no request. To read a linked page, pass its `url` with `resolved_timestamp` as `timestamp`, or with a blank `timestamp` when the link is a Wayback capture URL (a link to an archived copy); in `content[]` the links follow the text as `**Links on this page:**` and one item per link
- Typed errors: `invalid_timestamp` (a `timestamp` that is not blank, 1–14 digits, or an ISO 8601 date or UTC date-time, or names a date or time that does not exist; or a capture URL in `url` whose timestamp does the same, naming `field: "url"`; answered before any request), `ambiguous_timestamp` (a capture URL in `url` and a `timestamp` naming a different one; answered before any request), `no_snapshot_available` (no capture near the timestamp; the capture is an archived error page, the message naming its timestamp and archived status; the replay's redirects reach no readable capture — the target of an archived redirect was never archived, is an archived error page, or was refused, or the redirects loop, run past 10, or carry no `Location` or one that is not a Wayback Machine URL — the message naming any archived redirect and its target, and how the redirects ended; or Wayback refused the replay with a 4xx, or the lookup with a 403, 410, or 451, as it does for a site excluded from the Wayback Machine), `non_text_capture` (the capture Wayback served is not text; the message names its replay URL, and any archived redirect that led to it), `content_fetch_failed` (Wayback unreachable, rate-limiting, or timed out during the page fetch, or refusing the unmodified form of a text capture it replayed, or that form's redirects reaching no readable capture; the Availability API refused the lookup, timed out, or could not be reached; the closest-capture lookup and its CDX fallback did not complete; or the lookup and the fetch together did not finish within the call's 55 s deadline (`IA_REQUEST_TIMEOUT_MS` when longer))

---

### `ia_search_items` <sub>tool</sub>

- Solr query syntax plus structured filters: `mediatype`, `collection`, `creator`, `language`, and publication date range (`date_from`/`date_to`). With a filter, `query` is parenthesized so the filter binds to all of it
- `creator` matches a creator holding every word of the name close together, in any order and case-insensitively, so `Charles Dickens` also finds `Dickens, Charles, 1812-1870`; for an exact phrase put `creator:"Charles Dickens"` in `query`. `language` takes an ISO 639-1, ISO 639-2, or discontinued MARC code or an English name and matches a known language under any of its codes and names (`fr` also finds `fre`, `fra`, and `French`); a two-letter code that is also an English word (`am`, `an`, `as`, `be`, `he`, `hi`, `is`, `it`, `my`, `no`, `or`, `so`, `to`) is searched only when it is the value given, and an unknown value is matched as given. `collection` takes an identifier or its archive.org details URL
- Date bounds accept `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`: `date_from` uses the period's first day and `date_to` its last day, including leap years. The bounds match the item's publication `date` only, so an item with no `date` never matches. Blank bounds leave that side open; invalid dates return `invalid_date_range` before a search request. For a range on when an item was uploaded, put `publicdate` in `query`, such as `publicdate:[2026-11-01 TO 2026-11-21]`; a bare upper date covers its whole day
- `mediatype` takes the ten Internet Archive media types — `texts`, `movies`, `audio`, `software`, `image`, `data`, `web`, `collection`, `etree`, `account` — case-insensitively, and resolves common near-misses (`text`, `book`, `books` → `texts`; `movie`, `video`, `videos` → `movies`; `images` → `image`; `collections` → `collection`)
- Sort by downloads, date, title, or random (`sort`, Solr syntax such as `date asc` or `titleSorter asc`; default `downloads desc`; Advanced Search has no relevance sort). Except under `random`, ties under the sort are ordered by `identifier`, so consecutive pages neither repeat nor skip an item
- `query` is at most 2,047 characters, the longest Advanced Search accepts; the filters count toward it, and a URL in the query must be quoted
- Up to 200 results per call (`rows`, default 50), 1-indexed `page`; on page 1 a larger `rows` (up to 10,000) is served as 200, setting `truncated` and a `notice` naming `rows: 200, page: 2` when more results remain
- Advanced Search serves only the first 10,000 results, so `page × rows ≤ 10,000`
- Output carries `total_found`, `page`, and the `rows` applied for pagination; an empty page returns a `notice` rather than an error — naming every filter applied when nothing matched, or the last page when `page` is past the end
- Each row carries `publicdate`, when the item became public (its upload time), as Advanced Search returns it, such as `2014-10-24T16:15:43Z`, omitted when the record has none; a `publicdate` sort orders by it, and `content[]` renders it as `**Public Date:**` after `**Date:**`
- `title`, `date`, `publicdate`, `creator`, and `collection` may be a string or a list; `collection` leaves out per-account `fav-` favorites lists, and `creator` lists the first 10 names, with `creator_count` when a record has more. In `content[]` a list of two or more values renders one item per value, so a value holding a comma keeps its boundaries
- Typed errors answered before any search request: `invalid_date_range` (an invalid date bound), `invalid_mediatype` (any other `mediatype`, listing the accepted values), `invalid_filter` (a `creator` or `language` with no letter or digit, which Advanced Search would ignore and match every item), `invalid_query` (a `query` ending in a backslash that escapes nothing), `rows_over_cap` (`rows` above 200 past page 1), and `page_limit_exceeded` (`page × rows` past 10,000, naming the last reachable page)
- Typed errors from Advanced Search: `invalid_query` (it rejected the query syntax, an unquoted URL, a query its filters take past 2,047 characters, or the sort field; its message is relayed) and `search_unavailable` (it failed, rate-limited the request, sent an unreadable response, timed out, did not finish within the call's 55 s deadline (`IA_REQUEST_TIMEOUT_MS` when longer), or could not be reached); a 5xx or network error is retried while the deadline allows, while a 429, another 4xx, a timeout, or an error body is answered after one request, a 4xx with a hint that repeating the request will not help

---

### `ia_get_item` <sub>tool</sub>

- `identifier` is an item identifier or an archive.org item URL (`/details/`, `/download/`, `/metadata/`, `/stream/`, or `/embed/` form, or a storage-node `/<n>/items/<identifier>/…` form) read as the identifier it names
- Returns `title`, `creator`, `description`, `mediatype`, `date`, `publicdate`, `addeddate`, `subject`, `collection`, `licenseurl`, `rights`, `language`, `publisher`, `volume`, `isbn`, `oclc_id`, `lccn`, `openlibrary_edition`, `openlibrary_work`, and `runtime` when present in upstream metadata; each of them may be a string or a list, and a value of any other shape is left out. `date` is the publication date; `publicdate` (when the item was made public) and `addeddate` (when it was added to the Archive) are stored as `YYYY-MM-DD HH:MM:SS` in UTC, `addeddate` on some records as a bare date, and an item can have both with no `date`. `runtime` is an audio or video item's total running time as catalogued (`13:06:44`, or free text such as `27 min 13 sec`). In `content[]` a list of two or more values renders one item per value (a `licenseurl` list as one link per URL; a license that is not a web URL reads as text), and a multi-value `title` is listed under `**Title:**` with the heading falling back to the identifier. `description` is plain text, converted from the HTML the Archive stores (paragraphs and `<br>` become line breaks, a link reads as its label followed by its URL in parentheses)
- `image_count` (texts items only: the scanned page images, covers and calibration cards included, not a printed page count) and `access_restricted` (`true` when the item is in an access-restricted collection such as a lending library) are present when they apply
- `files[]` is one page of the manifest in upstream order — `format`, `size`, `md5`, and a direct `download_url` per file, plus `private: true` on a file the manifest marks private, whose download the Archive refuses; `file_count` is always the full manifest size. An audio or video file also carries `title`, `track`, and `length` as catalogued (`track` as `1`, `01`, or `1/37`, `0` on checksum and file-list files; `length` as minutes and seconds such as `06:21` or as seconds such as `381.1`, which can differ between the copies of one recording, and derived copies often lack `title` and `track`), shown in `content[]` as nested `**Title:**`, `**Track:**`, and `**Length:**` items under the file. Each per-file field is kept only as a non-empty string, and a manifest entry with no file name is left out
- `max_files` (default 50, at most 500 per call) and `file_offset` (default 0) page through large items; a larger `max_files` (up to 300,000) is served as 500. When files remain, the response sets `truncated` and names the next `file_offset`
- `format` keeps one file type (exact match, case-insensitive — e.g. `DjVuTXT`, `Text PDF`, `VBR MP3`) before paging and reports the match count as `totalCount`; a format with no matches returns an empty page and a notice listing the formats the item has
- Typed errors: `invalid_identifier` (an `identifier` holding `/` or `:` that is not an archive.org item URL, answered before any request), `item_not_found` (unknown or dark identifiers), `archive_unavailable` (the Metadata API failed, rate-limited or refused the request, timed out, could not be reached, or sent an unreadable response, or the call's 55 s deadline ran out); a first timeout is retried once while time remains, and a call ends within 55 s, or `IA_REQUEST_TIMEOUT_MS` when that is longer

---

### `ia_get_text` <sub>tool</sub>

- `max_chars` and `char_offset` page through long documents; `has_more` signals additional text remains. `max_chars` defaults to and is capped at `IA_MAX_SNAPSHOT_CHARS` — a larger value is served at that maximum, with a `notice`, and the output `max_chars` reports the value applied
- For sequential pages, pass `next_continuation` back as `continuation` with the same `identifier`, omitting `char_offset`. The cursor expires after one hour, binds the page to the selected text file, and resumes from its byte checkpoint. If a stable file validator or cursor storage is unavailable, the response gives an offset continuation notice
- Continuation errors: `ambiguous_pagination` when both token and offset are supplied, `invalid_continuation` for an invalid or changed-file cursor, and `range_unavailable` when the download cannot resume at the saved range. Recovery names the `char_offset` to use
- `find` (a literal phrase of at most 500 characters, trimmed; blank is read as omitted) starts the page at the phrase's first match at or after `char_offset` or the continuation's position, so a passage can be read without paging to it. `match_offset` reports where the match begins and equals the output `char_offset`. Letters match regardless of case, one character to one (`ß` never matches `ss`); a whitespace run in the phrase matches any whitespace run in the text, line breaks included; every other character matches itself, so OCR misreads and words hyphenated across line ends break a phrase. `find` with `continuation` is accepted, and `continuation` with `char_offset` still fails as `ambiguous_pagination`. The page's `next_continuation`, passed back with the same `find`, searches on from the page's end; a match that begins inside the returned page and runs past its end is not reported by that search
- A `find` that matches nothing returns empty `text`, `has_more: false`, no `match_offset` or `next_continuation`, and a `notice` naming the file and the offset the search started from; it rules out that one file from that offset to its end only (the file-count notice stays when the file was a default pick)
- `find_incomplete` (`Timeout`) means the search stopped about a second before the download's request timeout or the call deadline would have cut it off, or the first match came after a whitespace run longer than the text one call holds. `data.char_offset` is where to resume (the match itself in the second case) and `data.next_continuation` is present when a cursor could be stored; call again with the same `find` and that token, or with that offset when there is none, which reads the file from its first byte and so searches further only on a faster download. A search that stopped without getting past its start, with no cursor that skips the text before it, fails as `archive_unavailable` instead, as a read without `find` does when its download cannot reach `char_offset`. Neither is retried
- The upstream read stops at the page's end (with `find`, at the end of the page that starts at the first match, or at the end of the file when nothing matches), so memory per call is bounded by the page size
- `identifier` is an item identifier or an archive.org item URL (`/details/`, `/download/`, `/stream/`, `/metadata/`, or `/embed/` form, or a storage-node `/<n>/items/<identifier>/…` form); a `/download/`, `/stream/`, or storage-node URL that names a file reads that file when `file` is omitted, and a continuation must read the file it names. A Wayback Machine URL is rejected: use `ia_get_snapshot`
- Each call reads one text file: the one `file` names, or by default the first DjVuTXT file, else Text, Plain Text, or another `.txt` file (Metadata sidecars excluded). `file` takes a name as `ia_get_item` lists it. When an item holds several readable text files, such as one per volume, a `notice` gives the count and says to pass `file` for another
- `source_file` names the file fetched and `source_file_bytes` its size in bytes, from the item manifest
- Typed errors: `invalid_identifier` (an `identifier` holding `/` or `:` that is not an archive.org item URL), `invalid_file` (`file`, or the file a URL names, is not in the manifest or is not readable text), `item_not_found`, `no_text_file`, `find_incomplete` (a `find` search that stopped early, above), `download_forbidden` (restricted collections), `archive_unavailable` (the Metadata API or the text download failed, rate-limited or refused the request, timed out, could not be reached, or the call's 55 s deadline ran out, or a `find` search could not get past its start before the download ran out of time); the metadata request and the download each retry a first timeout once while time remains and stop at a second, and a call ends within 55 s, or `IA_REQUEST_TIMEOUT_MS` when that is longer

---

### `ia://item/{identifier}` <sub>resource</sub>

- Returns `application/json` — `title`, `creator`, `mediatype`, `description` (plain text, as in `ia_get_item`), `subject`, `collection`, `date`, `publicdate`, `addeddate`, `licenseurl`, `rights`, `language`, `publisher`, `volume`, `isbn`, `oclc_id`, `lccn`, `openlibrary_edition`, `openlibrary_work`, `runtime`, `image_count`, `access_restricted`, and `file_count`; each field is omitted when absent, and a field may be a string or a list as in `ia_get_item`
- `identifier` comes from `ia_search_items` results
- Typed errors: `item_not_found` for unknown identifiers, `archive_unavailable` when the Metadata API fails or the read's 55 s deadline (`IA_REQUEST_TIMEOUT_MS` when longer) runs out

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
- Structured file manifests — `ia_get_item` returns file-level metadata (format, size, URL, and for audio and video the track title, number, and duration) and a `format` filter, so agents can pick the right file without paging through thumbnails

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http internet-archive-mcp-server https://internet-archive.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add internet-archive-mcp-server -- npx -y @cyanheads/internet-archive-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "internet-archive-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/internet-archive-mcp-server"]
    }
  }
}
```

No API key is required. For Docker or a source build, see [Running the server](#running-the-server).

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
| `IA_REQUEST_TIMEOUT_MS` | Timeout for each upstream HTTP request in milliseconds, headers and body. A whole tool call or resource read ends within 55 s, or within this timeout when it is longer. A positive integer — anything else fails startup | `30000` |
| `IA_MAX_SNAPSHOT_CHARS` | Default and maximum characters per `ia_get_text` and `ia_get_snapshot` page (a larger `max_chars` is served at it). A positive integer — anything else fails startup | `50000` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/internet-archive-mcp-server.git
  cd internet-archive-mcp-server && bun install
  cp .env.example .env   # optional User-Agent and timeout overrides
  ```

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
docker run --rm -p 3010:3010 ghcr.io/cyanheads/internet-archive-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/internet-archive-mcp-server`. For stdio, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/internet-archive-mcp-server:latest"]` in the MCP config. To build locally, `docker build -t internet-archive-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools, resource, and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Five tools across Wayback and IA library. |
| `src/mcp-server/resources` | Resource definitions. `ia://item/{identifier}` item metadata resource. |
| `src/services/wayback` | `WaybackService` — Availability API + CDX API client, plus archived-page charset decoding, timestamp parsing, and Wayback capture URL reading (including the targets of a page's links). |
| `src/services` | Shared modules: HTML-to-text extraction (archived pages and item descriptions), upstream error classification, the per-call deadline. |
| `src/services/archive-search` | `ArchiveSearchService` — Solr Advanced Search client. |
| `src/services/archive-metadata` | `ArchiveMetadataService` — Metadata API + file download client, plus the streaming phrase search behind `find`. |
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
