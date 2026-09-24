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

export const iaSearchItems = tool('ia_search_items', {
  title: 'Search Internet Archive Items',
  description:
    'Search the Internet Archive library (40M+ items) using the Advanced Search (Solr) API. ' +
    'Filter by media type (texts, audio, movies, software, image, etc.), collection, creator, date ' +
    'range, and language. Sort by relevance, date, or downloads. Supports pagination via page/rows. ' +
    'Returns identifiers, titles, creators, media types, dates, download counts, total_found, and ' +
    'current page/rows for pagination context. Use ia_get_item with a returned identifier to get ' +
    'full metadata and file manifests.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .trim()
      .min(1, 'Must not be blank — provide search terms or a Solr query.')
      .describe(
        'Solr query string. Supports field prefixes such as title:"war and peace", ' +
          'creator:dickens, subject:history. Plain keywords search all fields.',
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
        'Sort order in Solr format. Examples: "downloads desc", "date asc", "titleSorter asc". ' +
          'Default: "downloads desc".',
      ),
    rows: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Number of results per page (default 50, max 200).'),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('Page number (1-indexed). Combine with rows for pagination.'),
  }),

  output: z.object({
    items: z
      .array(
        z
          .object({
            identifier: z
              .string()
              .describe('Internet Archive item identifier. Use with ia_get_item.'),
            title: z.string().optional().describe('Item title.'),
            creator: z
              .union([
                z.string().describe('Single creator name.'),
                z.array(z.string().describe('Creator name.')).describe('Multiple creator names.'),
              ])
              .optional()
              .describe('Creator or author name(s).'),
            mediatype: z.string().optional().describe('Media type (texts, audio, movies, etc.).'),
            date: z.string().optional().describe('Publication or upload date.'),
            downloads: z.number().optional().describe('Total download count.'),
            collection: z
              .union([
                z.string().describe('Single collection identifier.'),
                z
                  .array(z.string().describe('Collection identifier.'))
                  .describe('Multiple collection identifiers.'),
              ])
              .optional()
              .describe('Collection(s) this item belongs to.'),
          })
          .describe('A single Internet Archive item.'),
      )
      .describe('Items matching the search query.'),
    total_found: z.number().describe('Total number of matching items across all pages.'),
    page: z.number().describe('Current page number (1-indexed).'),
    rows: z.number().describe('Number of rows requested per page.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the page came back empty: nothing matched (naming the mediatype filter ' +
          'applied, if any), or the requested page is past the last page of results.',
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
        rows: input.rows,
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
              `results at ${result.rows} rows per page; request page ` +
              `${Math.ceil(result.totalFound / result.rows)} or lower.`
          : `No items matched "${input.query}"${mediatype ? ` with mediatype "${mediatype}"` : ''}. ` +
              'Try broader search terms, remove filters, or verify the query syntax ' +
              '(Solr field prefixes: title:, creator:, subject:).',
      );
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
      `**${result.total_found.toLocaleString()} total results** — Page ${result.page} (${result.items.length} of ${result.rows} requested)`,
      '',
    ];
    for (const item of result.items) {
      lines.push(`## ${item.title ?? item.identifier}`);
      lines.push(`**Identifier:** ${item.identifier}`);
      if (item.mediatype) lines.push(`**Media Type:** ${item.mediatype}`);
      if (item.creator) {
        const creators = Array.isArray(item.creator) ? item.creator.join(', ') : item.creator;
        lines.push(`**Creator:** ${creators}`);
      }
      if (item.date) lines.push(`**Date:** ${item.date}`);
      if (item.downloads != null) lines.push(`**Downloads:** ${item.downloads.toLocaleString()}`);
      if (item.collection) {
        const cols = Array.isArray(item.collection) ? item.collection.join(', ') : item.collection;
        lines.push(`**Collection:** ${cols}`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
