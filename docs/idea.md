---
name: internet-archive-mcp-server
description: "Internet Archive & Wayback Machine — historical web snapshots plus search and metadata across texts, audio, video, and software."
version: 0.0.0
status: idea
category: external-data
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/internet-archive-mcp-server"
created: 2026-05-30
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
mirror: "not viable — petabyte-scale corpus; live only (Wayback availability/CDX + Metadata APIs)."
pattern: multi-endpoint single-source
complexity: medium
api-deps: Internet Archive (Wayback availability/CDX, Advanced Search, Metadata API)
api-cost: free (no key for reads; identifying User-Agent courteous)
hostable: true
composes-with: libofcongress-mcp-server, wikipedia-mcp-server, gdelt-mcp-server, openlibrary-mcp-server
---

# internet-archive-mcp-server

The Internet Archive — Wayback Machine historical web snapshots plus the 40M+ item library of texts, audio, video, software, and images. Keyless reads across the Wayback availability/CDX APIs, the Advanced Search (Solr) API, and the per-item Metadata API.

No fleet server touches the **archived web** — the single most useful thing here is "what did this URL look like on date X," which composes with *every other server* (snapshot any page the agent cites). The IA library also fills gaps: public-domain media, historical documents, software, and live-music recordings nothing else in the fleet indexes.

**Audience:** Researchers, journalists, fact-checkers, anyone citing a page that may have changed or vanished, plus media/history researchers mining the open library.

## User Goals

- Find archived snapshots of a URL (closest to a date, or the full capture history)
- Retrieve what a page looked like at a specific past time
- Search the Archive's library across media types (texts, audio, video, software)
- Get full metadata and the file list for an item
- Pull the contents of a public-domain text or document

## API Surface

Several keyless APIs under archive.org. Wayback addresses captures by URL + 14-digit timestamp; the library addresses items by string **identifier** (e.g. `nasa`, `commute_test`).

| API | Endpoint | Purpose |
|:----|:---------|:--------|
| Wayback Availability | `archive.org/wayback/available?url=&timestamp=` | Closest snapshot to a date — fast, single result |
| Wayback CDX | `web.archive.org/cdx/search/cdx?url=&output=json` | Full capture history: every snapshot with timestamp, status, digest, mimetype |
| Advanced Search | `archive.org/advancedsearch.php?q=&output=json` | Solr search across the library; field queries, facets, sort |
| Metadata | `archive.org/metadata/{identifier}` | Item metadata + file manifest (formats, sizes, download URLs) |

Snapshot content is served from `web.archive.org/web/{timestamp}/{url}`. The CDX API is the power tool (full history, collapsing, filtering); availability is the quick "closest capture."

## Tool Surface (sketch)

```
ia_find_snapshots   — snapshots of a URL. mode: 'closest' (nearest to a timestamp, via
                      availability) | 'history' (full capture list via CDX with optional
                      from/to, status, and collapse). Returns snapshot timestamps and the
                      web.archive.org replay URLs. "When was this page archived, and what
                      did it look like over time?"

ia_get_snapshot     — fetch the archived content of a URL at a specific timestamp
                      (resolves to the nearest capture if exact is missing). Returns the
                      archived HTML/text and the canonical replay URL. "Show me this page
                      as it was on 2018-03-01."

ia_search_items     — search the IA library (Advanced Search / Solr). Query + filters:
                      mediatype (texts|audio|movies|software|image|web), collection,
                      creator, year/date range, language; sort by relevance/downloads/
                      date. Returns items with identifier, title, creator, mediatype,
                      date, downloads. Discovery entry point.

ia_get_item         — full metadata + file manifest for an identifier: title, creator,
                      description, subjects, dates, collection, and every file with
                      format, size, and download URL. The hub for acting on a result.

ia_get_text         — retrieve the readable contents of a text item (plain-text or
                      OCR'd full text) by identifier, with length-aware truncation +
                      "…N more" and a pointer to the file for the rest. For public-domain
                      books, documents, and transcripts.
```

## Design Notes

- Medium complexity from the **Wayback timestamp/identifier model** and the CDX query semantics (collapsing, status filtering, pagination over huge capture sets), plus a heterogeneous corpus where item shape varies by mediatype.
- **The Wayback tools are the headline** — "snapshot any URL" is a universal composer. Lead with them; the library search/metadata tools are the breadth.
- CDX can return enormous capture lists for popular URLs — default `collapse=timestamp:8` (one per day) and cap results with "…N more." **No DataCanvas** (audit 2026-05-31): capture lists are a discovery surface (timestamps/URLs), not analytical rows — page or collapse, don't spill to SQL.
- Snapshot retrieval returns *archived* HTML which may be heavy and rewritten; offer a text-extracted view and always return the replay URL for human follow-up. Note that not every URL/date has a capture — absence is "not archived," not "didn't exist."
- Respect IA politely: identifying User-Agent, modest concurrency, backoff on 429. Reads are keyless; writes/uploads (out of scope) need S3-style keys.
- Copyright varies by item — surface `licenseurl`/rights where present; don't imply everything is public-domain.
- Composes with `libofcongress` (parallel historical/cultural archive), `wikipedia` (archived sources behind citations), `gdelt` (archived snapshots of news URLs it surfaces), `openlibrary` (IA hosts scanned editions OpenLibrary references).
- Moonshot: a "citation hardening" workflow — take any URL an agent is about to cite, return the best Wayback snapshot + a permalink, so answers link to a stable archived copy instead of a mutable live page.
- README one-liner: "Archived web snapshots and 40M+ open-library items — the Wayback Machine and Internet Archive for agents."
