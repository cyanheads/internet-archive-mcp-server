/**
 * @fileoverview Tool for searching the Internet Archive library (40M+ items).
 * @module mcp-server/tools/definitions/ia-search-items
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getArchiveSearchService } from '@/services/archive-search/archive-search-service.js';

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
      .describe(
        'Solr query string. Supports field prefixes such as title:"war and peace", ' +
          'creator:dickens, subject:history. Plain keywords search all fields.',
      ),
    mediatype: z
      .string()
      .optional()
      .describe(
        'Filter by media type. Common values: texts, audio, movies, software, image, ' +
          'data, web, collection, account.',
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
    notice: z.string().optional().describe('Guidance when the search returned no results.'),
  },

  async handler(input, ctx) {
    const svc = getArchiveSearchService();

    const result = await svc.search(
      {
        query: input.query,
        mediatype: input.mediatype?.trim() || undefined,
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
        `No items matched "${input.query}". Try broader search terms, remove filters, ` +
          `or verify the query syntax (Solr field prefixes: title:, creator:, subject:).`,
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
