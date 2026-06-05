/**
 * @fileoverview Archive Search service wrapping the Internet Archive Advanced Search (Solr) API.
 * @module services/archive-search/archive-search-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, getUserAgent } from '@/config/server-config.js';
import type { SearchResult, SearchResultItem } from './types.js';

const SEARCH_BASE = 'https://archive.org/advancedsearch.php';

const SEARCH_FIELDS = [
  'identifier',
  'title',
  'creator',
  'mediatype',
  'date',
  'downloads',
  'collection',
];

/** Parameters for the search method. */
export interface SearchParams {
  collection?: string | undefined;
  creator?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  language?: string | undefined;
  mediatype?: string | undefined;
  page?: number | undefined;
  query: string;
  rows?: number | undefined;
  sort?: string | undefined;
}

export class ArchiveSearchService {
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  constructor(config: AppConfig, _storage: StorageService) {
    this.userAgent = getUserAgent(config.mcpServerVersion);
    this.timeoutMs = getServerConfig().requestTimeoutMs;
  }

  private get headers(): Record<string, string> {
    return { 'User-Agent': this.userAgent };
  }

  /** Search the Internet Archive library. */
  search(params: SearchParams, ctx: Context): Promise<SearchResult> {
    if (!params.query.trim()) {
      throw validationError('Search query must not be empty.', {
        reason: 'empty_query',
      });
    }

    return withRetry(
      async () => {
        // Build the Solr query string, appending metadata filters as needed
        let q = params.query.trim();
        if (params.mediatype) q += ` AND mediatype:${params.mediatype}`;
        if (params.collection) q += ` AND collection:${params.collection}`;
        if (params.creator) q += ` AND creator:"${params.creator}"`;
        if (params.language) q += ` AND language:${params.language}`;
        if (params.dateFrom || params.dateTo) {
          const from = params.dateFrom ?? '*';
          const to = params.dateTo ?? '*';
          q += ` AND date:[${from} TO ${to}]`;
        }

        const qp = new URLSearchParams({
          q,
          output: 'json',
          rows: String(params.rows ?? 50),
          page: String(params.page ?? 1),
        });
        // fl[] and sort[] use the repeating-key form that URLSearchParams handles
        for (const field of SEARCH_FIELDS) {
          qp.append('fl[]', field);
        }
        if (params.sort) {
          qp.append('sort[]', params.sort);
        } else {
          qp.append('sort[]', 'downloads desc');
        }

        const response = await fetchWithTimeout(
          `${SEARCH_BASE}?${qp}`,
          this.timeoutMs,
          ctx as unknown as Parameters<typeof fetchWithTimeout>[2],
          { headers: this.headers, signal: ctx.signal },
        );

        const text = await response.text();

        // HTML response = empty query or auth error
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'Advanced Search API returned HTML instead of JSON — likely an invalid query or server error.',
          );
        }

        let parsed: {
          response?: { numFound?: number; start?: number; docs?: unknown[] };
        };
        try {
          parsed = JSON.parse(text) as typeof parsed;
        } catch {
          throw serviceUnavailable('Advanced Search API returned unparseable response.');
        }

        const docs = parsed.response?.docs ?? [];
        const totalFound = parsed.response?.numFound ?? 0;
        const page = params.page ?? 1;
        const rows = params.rows ?? 50;

        const items: SearchResultItem[] = docs.map((doc) => {
          const d = doc as Record<string, unknown>;
          return {
            identifier: (d.identifier as string) ?? '',
            ...(d.title ? { title: d.title as string } : {}),
            ...(d.creator ? { creator: d.creator as string | string[] } : {}),
            ...(d.mediatype ? { mediatype: d.mediatype as string } : {}),
            ...(d.date ? { date: d.date as string } : {}),
            ...(typeof d.downloads === 'number' ? { downloads: d.downloads } : {}),
            ...(d.collection ? { collection: d.collection as string | string[] } : {}),
          };
        });

        ctx.log.debug('Search completed', { query: q, totalFound, count: items.length });
        return { items, totalFound, page, rows };
      },
      {
        operation: 'ArchiveSearchService.search',
        // biome-ignore lint/suspicious/noExplicitAny: framework withRetry context type mismatch
        context: ctx as any,
        baseDelayMs: 1_000,
        signal: ctx.signal,
      },
    );
  }
}

// --- Init/accessor pattern ---

let _service: ArchiveSearchService | undefined;

export function initArchiveSearchService(config: AppConfig, storage: StorageService): void {
  _service = new ArchiveSearchService(config, storage);
}

export function getArchiveSearchService(): ArchiveSearchService {
  if (!_service) {
    throw new Error(
      'ArchiveSearchService not initialized — call initArchiveSearchService() in setup()',
    );
  }
  return _service;
}
