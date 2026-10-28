---
name: internet-archive-guide
description: Use ia_* tools to investigate historical web pages or Internet Archive books and documents. Resolve capture and item identities, compare the captures actually served, and check coverage before claiming content absent or fully read.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use historical captures to establish what a page said at a captured time, and library items to investigate a particular edition or document. For the current page, use the live site. For page layout or raw HTML, follow the returned replay URL: snapshot text removes markup and can retain navigation alongside the page's content.

## Identifiers

- Keep a web page's original URL separate from its Wayback replay URL. `ia_find_snapshots` supplies capture timestamps and replay URLs; `ia_get_snapshot` takes the original URL and a timestamp.
- Take an item identifier from `ia_search_items`, then retain it while inspecting metadata and reading text. A title identifies a candidate, not an edition. Collection values returned with items are collection identifiers; use those values rather than guessing an identifier from a collection's display name.
- Take filenames and download URLs from `ia_get_item`. Text pages name their selected `source_file`; retain that filename with the item identifier when citing a passage.
- Keep history `resume_key` and text `next_continuation` tokens separate. Both come from the preceding response in their own workflow; neither is an item identifier or a timestamp.

## Gates

1. **Date the content actually served.** Before comparing or citing captures, check `ia_get_snapshot`'s resolved timestamp and replay URL. Wayback can redirect a requested capture to another capture; the requested date alone does not date the returned text.
2. **Establish history coverage before claiming a change was absent.** Daily collapse can hide changes within a day. Use capture-second precision for that question, follow history continuations, and retain any incompleteness notice. Wildcard and legacy raw continuations can omit captures across pages; they cannot support an exhaustive-history claim.
3. **Distinguish absence from failure.** A lookup outage does not establish that a URL was never captured. An archived error page does not contain the requested page's content; look for a successful capture. When the error says Wayback does not serve the URL at any timestamp, stop trying other dates for that URL and look for a different original URL.
4. **Inspect the manifest before declaring text unavailable.** A filtered or partial file page is not the complete manifest. No `DjVuTXT` match alone does not rule out plain text: `ia_get_text` also considers other text formats and `.txt` files. A forbidden download means restricted access, not a missing item; use the Archive website for that access path.
5. **Finish reading before claiming a document was searched completely.** Continue until `has_more` is false. Keep the selected source filename consistent; the file's byte size is not a text length. If a text continuation becomes invalid, follow the recovery offset or restart when the file changed rather than joining pages from different representations.
6. **Check search coverage before declaring an item absent.** An empty page can be past the last result. A broad search cannot expose results beyond the 10,000-result window; narrow by metadata to investigate the remaining set. A snapshot's capped text likewise cannot establish that a phrase is absent from the full archived page.

## Workflows

**Compare a page over time.** Survey history around the period in question, choose captures on each side of the suspected change, then fetch them. Compare their resolved dates before comparing their text. If both requests resolve to the same capture, they provide one observation, not evidence of stability between two dates. Report the observed difference with the two replay URLs and the coverage limits.

**Investigate a book or document.** Search with a fielded phrase such as `title:"war and peace" AND creator:tolstoy`. Inspect candidate metadata to choose the edition and language before reading text. OCR is a text derivative of that item; preserve its source filename and use the manifest's alternative download formats when the task needs the scanned pages. To discover related material, reuse collection identifiers from the selected item's metadata.

**Repair a rejected search.** Quote URLs and punctuation-bearing phrases behind a field prefix, for example `title:"AT&T"`, rather than sending punctuation as bare query syntax. Read the returned recovery: a backend-tagged rejection of query text needs a simpler query, while a timeout or network outage says nothing about whether the search matches. Avoid repeating an unchanged request marked non-retryable.
