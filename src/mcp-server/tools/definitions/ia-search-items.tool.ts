/**
 * @fileoverview Tool for searching the Internet Archive library (40M+ items).
 * @module mcp-server/tools/definitions/ia-search-items
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArchiveSearchService } from '@/services/archive-search/archive-search-service.js';

/** The complete Advanced Search mediatype vocabulary. Solr matches it exactly and case-sensitively. */
const MEDIATYPES = [
  'texts',
  'movies',
  'audio',
  'software',
  'image',
  'data',
  'web',
  'collection',
  'etree',
  'account',
];

/** Advanced Search serves no result past this one: it rejects any page with page × rows above it. */
const RESULT_WINDOW = 10_000;

/** Results returned per call. A larger `rows` on page 1 is served at this cap. */
const ROWS_CAP = 200;

/** Every accepted lowercase spelling, mapped to the canonical mediatype it searches. */
const MEDIATYPE_BY_SPELLING = new Map<string, string>([
  ...MEDIATYPES.map((m): [string, string] => [m, m]),
  ['text', 'texts'],
  ['book', 'texts'],
  ['books', 'texts'],
  ['movie', 'movies'],
  ['video', 'movies'],
  ['videos', 'movies'],
  ['images', 'image'],
  ['collections', 'collection'],
]);

/** A string-or-list field as one line of text. */
const listText = (value: string | string[]): string =>
  Array.isArray(value) ? value.join(', ') : value;

export const iaSearchItems = tool('ia_search_items', {
  title: 'Search Internet Archive Items',
  description:
    'Search the Internet Archive library (40M+ items) using the Advanced Search (Solr) API. ' +
    'Filter by media type (texts, audio, movies, software, image, etc.), collection, creator, date ' +
    'range, and language. Sort by downloads (the default), date, title, or random. Supports ' +
    'pagination via page/rows. ' +
    'Returns identifiers, titles, creators (the first 10, with creator_count when a record lists ' +
    'more), media types, dates, download counts, collections (without fav- favorites lists), ' +
    'total_found, and current page/rows for pagination context. Use ia_get_item with a returned ' +
    'identifier to get full metadata and file manifests.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .trim()
      .min(1, 'Must not be blank — provide search terms or a Solr query.')
      .max(
        2_047,
        'Must be 2,047 characters or fewer — the longest query Advanced Search accepts, filters included.',
      )
      .describe(
        'Solr query string. Supports field prefixes such as title:"war and peace", ' +
          'creator:dickens, subject:history. Plain keywords search all fields. Put a URL in ' +
          'quotes. At most 2,047 characters, a limit the filters below also count toward.',
      ),
    mediatype: z
      .string()
      .optional()
      .describe(
        'Filter by media type: texts, movies, audio, software, image, data, web, collection, ' +
          'etree (live concert recordings), or account. Case-insensitive; text, book, and books ' +
          'mean texts, movie, video, and videos mean movies, images means image, and collections ' +
          'means collection. Any other value is rejected.',
      ),
    collection: z
      .string()
      .optional()
      .describe(
        'Filter to items within a specific collection identifier, e.g. "gutenberg" or "librivoxaudio".',
      ),
    creator: z.string().optional().describe('Filter by creator name, e.g. "Charles Dickens".'),
    date_from: z
      .string()
      .optional()
      .describe('Start of date range filter in YYYY-MM-DD format. Example: "1900-01-01".'),
    date_to: z
      .string()
      .optional()
      .describe('End of date range filter in YYYY-MM-DD format. Example: "1999-12-31".'),
    language: z
      .string()
      .optional()
      .describe('Filter by language code or name, e.g. "eng" or "English".'),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort order in Solr format: a sortable field followed by asc or desc, e.g. ' +
          '"downloads desc", "date asc", "publicdate desc", "titleSorter asc", or "random". ' +
          'Default: "downloads desc". Advanced Search has no relevance sort. Except under ' +
          'random, results tied under the sort are ordered by identifier, so consecutive pages ' +
          'neither repeat nor skip an item.',
      ),
    rows: z
      .number()
      .int()
      .min(1)
      .max(RESULT_WINDOW)
      .default(50)
      .describe(
        'Number of results per page (default 50). One call returns at most 200: on page 1 a ' +
          'larger value (up to 10,000) is served as 200 with a notice naming the next page; on ' +
          'later pages a value above 200 is rejected.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Page number (1-indexed). Combine with rows for pagination. Advanced Search serves only ' +
          'the first 10,000 results, so page × rows ≤ 10,000 (page 50 at 200 rows, page 200 at 50).',
      ),
  }),

  output: z.object({
    items: z
      .array(
        z
          .object({
            identifier: z
              .string()
              .describe('Internet Archive item identifier. Use with ia_get_item.'),
            title: z
              .union([
                z.string().describe('Single title.'),
                z.array(z.string().describe('Title value.')).describe('Multiple title values.'),
              ])
              .optional()
              .describe('Item title; a few records carry a list, relayed as received.'),
            creator: z
              .union([
                z.string().describe('Single creator name.'),
                z.array(z.string().describe('Creator name.')).describe('Multiple creator names.'),
              ])
              .optional()
              .describe('Creator or author name(s) — the first 10 when the record lists more.'),
            creator_count: z
              .number()
              .optional()
              .describe(
                'Total creators on the record, present only when creator lists the first 10; ' +
                  'ia_get_item returns them all.',
              ),
            mediatype: z.string().optional().describe('Media type (texts, audio, movies, etc.).'),
            date: z
              .union([
                z.string().describe('Single date.'),
                z.array(z.string().describe('Date value.')).describe('Multiple date values.'),
              ])
              .optional()
              .describe(
                'Publication or upload date; a few records carry a list, relayed as received.',
              ),
            downloads: z.number().optional().describe('Total download count.'),
            collection: z
              .union([
                z.string().describe('Single collection identifier.'),
                z
                  .array(z.string().describe('Collection identifier.'))
                  .describe('Multiple collection identifiers.'),
              ])
              .optional()
              .describe(
                'Collection(s) this item belongs to, in upstream order. Per-account favorites ' +
                  'lists (fav-<account>) are left out; omitted when nothing else remains.',
              ),
          })
          .describe('A single Internet Archive item.'),
      )
      .describe('Items matching the search query.'),
    total_found: z.number().describe('Total number of matching items across all pages.'),
    page: z.number().describe('Current page number (1-indexed).'),
    rows: z
      .number()
      .describe(
        'Rows per page applied: the requested rows, or 200 when a larger value was capped.',
      ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when rows above 200 was served at 200 and more results remain.'),
    shown: z.number().optional().describe('Number of items returned.'),
    cap: z.number().optional().describe('The per-call cap applied to rows (200).'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the page came back empty — nothing matched (naming the mediatype filter ' +
          'applied, if any), or the requested page is past the last page of results — or when ' +
          'rows was capped, naming the rows and page that continue.',
      ),
  },

  errors: [
    {
      reason: 'invalid_mediatype',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'mediatype is not an Internet Archive media type or one of its recognized spellings.',
      recovery: `Set mediatype to one of ${MEDIATYPES.join(', ')}, or omit it to search every media type.`,
      severity: 'warning',
    },
    {
      reason: 'page_limit_exceeded',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'page × rows exceeds 10,000, the last result Advanced Search serves.',
      recovery:
        'Request a page at or below the last reachable one named in the message, or narrow the ' +
        'query with filters (mediatype, collection, creator, date range) or a different sort so ' +
        'the results you need fall within the first 10,000.',
      severity: 'warning',
    },
    {
      reason: 'rows_over_cap',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'rows is above 200 on a page after the first.',
      recovery:
        'Keep rows at 200 or fewer on every page, or request page 1, where a larger rows value ' +
        'is served as 200; pages are rows-sized blocks, so use the same rows on each page.',
      severity: 'warning',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Advanced Search rejected the query syntax, an unquoted URL, the query length, or the sort field.',
      recovery:
        'Fix the query named in the message: close every parenthesis, quote, and range bracket, ' +
        'write field prefixes as field:value, put a URL in quotes, keep the query and its ' +
        'filters within 2,047 characters, and sort by a sortable field such as downloads, ' +
        'date, publicdate, or titleSorter followed by asc or desc.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'search_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when:
        'Advanced Search failed, rate-limited the request, returned an unreadable response, ' +
        'timed out, or could not be reached (network error).',
      recovery:
        'The search backend fails on a bare operator (AND, OR, NOT), an empty field prefix ' +
        '(title:), a doubled operator (AND AND), or &, %, /, !, or ; inside a word (AT&T, ' +
        '100%, 1/2): quote such a phrase behind a field prefix (title:"AT&T") or replace the ' +
        'character with a space. A query with none of these hit a backend fault; try a simpler ' +
        'query.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getArchiveSearchService();

    const requestedMediatype = input.mediatype?.trim();
    const mediatype = requestedMediatype
      ? MEDIATYPE_BY_SPELLING.get(requestedMediatype.toLowerCase())
      : undefined;
    if (requestedMediatype && !mediatype) {
      throw ctx.fail(
        'invalid_mediatype',
        `mediatype "${requestedMediatype}" is not an Internet Archive media type.`,
        ctx.recoveryFor('invalid_mediatype'),
      );
    }

    if (input.rows > ROWS_CAP && input.page > 1) {
      throw ctx.fail(
        'rows_over_cap',
        `rows ${input.rows} is above the cap of ${ROWS_CAP} per call, which only page 1 serves ` +
          `at the cap; page ${input.page} needs rows of ${ROWS_CAP} or fewer.`,
        ctx.recoveryFor('rows_over_cap'),
      );
    }
    const rows = Math.min(input.rows, ROWS_CAP);
    if (input.page * rows > RESULT_WINDOW) {
      throw ctx.fail(
        'page_limit_exceeded',
        `Page ${input.page} at ${rows} per page ends at result ${(input.page * rows).toLocaleString('en-US')}, ` +
          `past the 10,000 results Advanced Search serves; the last reachable page at ${rows} per ` +
          `page is ${Math.floor(RESULT_WINDOW / rows)}.`,
        ctx.recoveryFor('page_limit_exceeded'),
      );
    }

    const result = await svc.search(
      {
        query: input.query,
        mediatype,
        collection: input.collection?.trim() || undefined,
        creator: input.creator?.trim() || undefined,
        dateFrom: input.date_from?.trim() || undefined,
        dateTo: input.date_to?.trim() || undefined,
        language: input.language?.trim() || undefined,
        sort: input.sort?.trim() || undefined,
        rows,
        page: input.page,
      },
      ctx,
    );

    ctx.log.info('Item search completed', {
      query: input.query,
      totalFound: result.totalFound,
      returned: result.items.length,
    });

    if (result.items.length === 0) {
      ctx.enrich.notice(
        result.totalFound > 0
          ? `Page ${result.page} is past the last page of ${result.totalFound.toLocaleString('en-US')} ` +
              `results at ${result.rows} per page; request page ` +
              `${Math.ceil(result.totalFound / result.rows)} or lower.`
          : `No items matched "${input.query}"${mediatype ? ` with mediatype "${mediatype}"` : ''}. ` +
              'Try broader search terms, remove filters, or verify the query syntax ' +
              '(Solr field prefixes: title:, creator:, subject:).',
      );
    } else if (rows < input.rows && result.totalFound > result.items.length) {
      const total = result.totalFound;
      ctx.enrich.truncated({
        shown: result.items.length,
        cap: ROWS_CAP,
        guidance:
          `rows ${input.rows} is above the cap of ${ROWS_CAP} per call, so this page holds ` +
          `results 1–${result.items.length} of ${total.toLocaleString('en-US')}. Request ` +
          `rows: ${ROWS_CAP}, page: 2 for results ${ROWS_CAP + 1}–${Math.min(2 * ROWS_CAP, total)}.`,
      });
    }

    return {
      items: result.items,
      total_found: result.totalFound,
      page: result.page,
      rows: result.rows,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.total_found.toLocaleString()} total results** — Page ${result.page} (${result.items.length} shown, ${result.rows} per page)`,
      '',
    ];
    for (const item of result.items) {
      lines.push(`## ${item.title ? listText(item.title) : item.identifier}`);
      lines.push(`**Identifier:** ${item.identifier}`);
      if (item.mediatype) lines.push(`**Media Type:** ${item.mediatype}`);
      if (item.creator) {
        const cut =
          item.creator_count != null
            ? ` (${Array.isArray(item.creator) ? item.creator.length : 1} of ${item.creator_count}; ia_get_item lists all)`
            : '';
        lines.push(`**Creator:** ${listText(item.creator)}${cut}`);
      }
      if (item.date) lines.push(`**Date:** ${listText(item.date)}`);
      if (item.downloads != null) lines.push(`**Downloads:** ${item.downloads.toLocaleString()}`);
      if (item.collection) lines.push(`**Collection:** ${listText(item.collection)}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
