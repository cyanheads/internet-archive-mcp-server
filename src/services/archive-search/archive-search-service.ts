/**
 * @fileoverview Archive Search service wrapping the Internet Archive Advanced Search (Solr) API.
 * @module services/archive-search/archive-search-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { invalidParams, type McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, getUserAgent } from '@/config/server-config.js';
import {
  bodyReadError,
  isHtmlPage,
  isRetriedFailure,
  rateLimitError,
  statusOf,
  transportError,
} from '../upstream-errors.js';
import type { SearchResult, SearchResultItem } from './types.js';

const SEARCH_BASE = 'https://archive.org/advancedsearch.php';

/** How error messages name this upstream. */
const UPSTREAM = 'Advanced Search';

/**
 * Upstream error tags that blame the request rather than the service: an unsortable field, a
 * bare URL in the query, and a query past 2,047 characters. An `error` body with no `[TAG]`
 * prefix is a query parse error, which also blames the request.
 */
const QUERY_ERROR_TAGS = new Set(['UNSUPPORTED_SORT', 'MALFORMED_QUERY', 'UNSUPPORTED_VALUE']);

const DEFAULT_SORT = 'downloads desc';

/**
 * The second sort key on every non-random search. Advanced Search orders ties under the sort
 * arbitrarily from one request to the next, so consecutive pages repeat and skip tied rows
 * (28 and 43 of 200 in two runs of `downloads:0 AND subject:news`); `identifier` is unique,
 * so it fixes the order.
 */
const TIE_BREAK_SORT = 'identifier asc';

/** A random sort, which Advanced Search accepts only as the sole sort. */
const RANDOM_SORT = /^random\b/i;

/** Prefix of the per-account favorites lists Advanced Search returns among an item's collections. */
const FAVORITES_PREFIX = 'fav-';

/**
 * Creators returned per result. Above every creator list in an 8,613-item sample (max 8);
 * large collaborations run to hundreds (`arxiv-1402.6728` lists 409).
 */
const CREATOR_LIMIT = 10;

/** Characters of an upstream `error` string relayed in a message. */
const UPSTREAM_ERROR_CHARS = 500;

/**
 * The hint an outage carries — a timeout, a network error, a 5xx, or an unreadable body —
 * in place of the declared recovery, whose query-text advice fits only an `error` body.
 */
const OUTAGE_HINT = `${UPSTREAM} is down or unreachable; call again in a few minutes.`;

const SEARCH_FIELDS = [
  'identifier',
  'title',
  'creator',
  'mediatype',
  'date',
  'downloads',
  'collection',
];

/**
 * Escape a string value for safe embedding inside a Solr phrase query ("value").
 * Backslash-escapes double-quotes and backslashes so the phrase boundary cannot be closed early.
 */
function solrEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Validate and return a Solr date range boundary.
 * Accepts YYYY-MM-DD strings or undefined (returns "*").
 * Rejects anything that doesn't match the expected date format to prevent range injection.
 */
function sanitizeDateRange(value: string | undefined): string {
  if (!value) return '*';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  // Fall back to wildcard for anything that doesn't look like a date
  return '*';
}

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
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: AppConfig, _storage: StorageService) {
    this.headers = { 'User-Agent': getUserAgent(config.mcpServerVersion) };
    this.timeoutMs = getServerConfig().requestTimeoutMs;
  }

  /**
   * Search the Internet Archive library. Advanced Search reports a rejected request as an
   * HTTP 200 whose body holds `error` and no `response`; that body is answered after one
   * request, as `invalid_query` when the error blames the query or sort and as
   * `search_unavailable` otherwise. An HTTP 5xx, a network error (a connection dropped
   * mid-body included), an HTML page, an unparseable body, or a body with neither key is
   * `search_unavailable` after the retry loop; a 429, another 4xx, or a request timeout
   * (headers or body) is `search_unavailable` after one request, a 429 with a hint to wait.
   * Every outage — a timeout, a network error, a 5xx, or an unreadable body — carries the
   * outage hint in place of the declared query-text recovery.
   * A caller cancellation or caller-side deadline propagates as the fetch threw it.
   */
  search(params: SearchParams, ctx: Context): Promise<SearchResult> {
    return withRetry(
      async () => {
        // Build the Solr query string, appending metadata filters as needed.
        // All filter values are quoted or validated to prevent Solr query injection.
        let q = params.query.trim();
        if (params.mediatype) q += ` AND mediatype:"${solrEscape(params.mediatype)}"`;
        if (params.collection) q += ` AND collection:"${solrEscape(params.collection)}"`;
        if (params.creator) q += ` AND creator:"${solrEscape(params.creator)}"`;
        if (params.language) q += ` AND language:"${solrEscape(params.language)}"`;
        if (params.dateFrom || params.dateTo) {
          const from = sanitizeDateRange(params.dateFrom);
          const to = sanitizeDateRange(params.dateTo);
          q += ` AND date:[${from} TO ${to}]`;
        }

        const page = params.page ?? 1;
        const rows = params.rows ?? 50;
        const qp = new URLSearchParams({
          q,
          output: 'json',
          rows: String(rows),
          page: String(page),
        });
        // fl[] and sort[] use the repeating-key form that URLSearchParams handles
        for (const field of SEARCH_FIELDS) {
          qp.append('fl[]', field);
        }
        const sort = params.sort ?? DEFAULT_SORT;
        qp.append('sort[]', sort);
        if (!RANDOM_SORT.test(sort)) qp.append('sort[]', TIE_BREAK_SORT);

        const response = await this.fetchUpstream(`${SEARCH_BASE}?${qp}`, ctx);
        const text = await response.text().catch((err: unknown) => {
          throw bodyReadError(err, UPSTREAM);
        });
        const body = readEnvelope(text, ctx);

        const docs = body.docs ?? [];
        const totalFound = body.numFound ?? 0;

        const items: SearchResultItem[] = docs.map((doc) => {
          const d = doc as Record<string, unknown>;
          const collection = d.collection
            ? withoutFavorites(d.collection as string | string[])
            : undefined;
          return {
            identifier: (d.identifier as string) ?? '',
            ...(d.title ? { title: d.title as string | string[] } : {}),
            ...(d.creator ? creators(d.creator as string | string[]) : {}),
            ...(d.mediatype ? { mediatype: d.mediatype as string } : {}),
            ...(d.date ? { date: d.date as string | string[] } : {}),
            ...(typeof d.downloads === 'number' ? { downloads: d.downloads } : {}),
            ...(collection ? { collection } : {}),
          };
        });

        ctx.log.debug('Search completed', { query: q, totalFound, count: items.length });
        return { items, totalFound, page, rows };
      },
      {
        operation: 'ArchiveSearchService.search',
        context: ctx,
        baseDelayMs: 1_000,
        signal: ctx.signal,
        isTransient: isRetriedFailure,
      },
    ).catch((err: unknown) => {
      throw transportError(err, UPSTREAM, this.timeoutMs, outage());
    });
  }

  /**
   * `fetchWithTimeout` with an upstream non-2xx rethrown as `search_unavailable`, without the
   * upstream body. It runs inside the retry closure: a 5xx keeps the fields the retry loop
   * reads (`retryAfter`, `retryable`), so it is retried as before; a 429 carries a hint to
   * wait and is answered after one request by the retry predicate; any other 4xx is marked
   * `retryable: false`, with a hint that repeating it will not help (Advanced Search answers
   * a control character in the query with a 400). Every other failure, timeouts and caller
   * cancellation included, propagates untouched.
   */
  private async fetchUpstream(url: string, ctx: Context): Promise<Response> {
    try {
      return await fetchWithTimeout(url, this.timeoutMs, ctx, {
        headers: this.headers,
        signal: ctx.signal,
      });
    } catch (err) {
      const status = statusOf(err);
      if (status === undefined) throw err;
      const { retryAfter, retryable } = (err as McpError).data ?? {};
      if (status === 429) throw rateLimitError(err, UPSTREAM, UPSTREAM, 'search_unavailable');
      throw serviceUnavailable(
        `${UPSTREAM} returned HTTP ${status}.`,
        {
          ...outage(),
          status,
          ...(retryAfter !== undefined && { retryAfter }),
          ...(status < 500
            ? {
                retryable: false,
                recovery: {
                  hint: `${UPSTREAM} refused this request with HTTP ${status}, so repeating it unchanged will not help; remove control characters from the query, or simplify it.`,
                },
              }
            : retryable !== undefined && { retryable }),
        },
        { cause: err },
      );
    }
  }
}

/**
 * `collection` without the `fav-<account>` entries Advanced Search indexes for every account
 * that favorited the item — account names, not collections, and thousands of them on popular
 * items. Filtered by prefix, never by position: real collections can follow a `fav-` entry.
 * Undefined when nothing is left.
 */
function withoutFavorites(collection: string | string[]): string | string[] | undefined {
  if (!Array.isArray(collection))
    return collection.startsWith(FAVORITES_PREFIX) ? undefined : collection;
  const kept = collection.filter((c) => !c.startsWith(FAVORITES_PREFIX));
  return kept.length > 0 ? kept : undefined;
}

/** `creator` cut to its first `CREATOR_LIMIT` values, with `creator_count` when it was cut. */
function creators(creator: string | string[]): Pick<SearchResultItem, 'creator' | 'creator_count'> {
  if (!Array.isArray(creator) || creator.length <= CREATOR_LIMIT) return { creator };
  return { creator: creator.slice(0, CREATOR_LIMIT), creator_count: creator.length };
}

/** Fields of the Advanced Search `response` object this service reads. */
interface SearchEnvelope {
  docs?: unknown[];
  numFound?: number;
}

/**
 * The `response` object of an Advanced Search body. An `error` body throws after this one
 * request: `invalid_query` when it blames the query or sort, otherwise `search_unavailable`
 * marked `retryable: false`. An HTML page, unparseable text, or a body with neither key throws
 * `search_unavailable` with the outage hint, which the retry loop retries like a 5xx.
 */
function readEnvelope(text: string, ctx: Context): SearchEnvelope {
  if (isHtmlPage(text)) {
    throw serviceUnavailable('Advanced Search returned an HTML page instead of JSON.', outage());
  }
  let parsed: { error?: unknown; response?: SearchEnvelope };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw serviceUnavailable('Advanced Search returned an unparseable response.', outage());
  }
  if (parsed?.error != null) throw upstreamError(parsed.error, ctx);
  if (!parsed?.response) {
    throw serviceUnavailable(
      'Advanced Search returned a body with neither results nor an error.',
      outage(),
    );
  }
  return parsed.response;
}

/**
 * An Advanced Search `error` body as the declared reason it maps to; neither is retried. The
 * relayed text is one line: whitespace runs, newlines included, collapse to one space.
 */
function upstreamError(error: unknown, ctx: Context): McpError {
  const text =
    typeof error === 'string'
      ? error.replace(/\s+/g, ' ').trim().slice(0, UPSTREAM_ERROR_CHARS)
      : '';
  const tag = /^\[([A-Z_]+)\]/.exec(text)?.[1];
  if (text && (tag === undefined || QUERY_ERROR_TAGS.has(tag))) {
    return invalidParams(`Advanced Search rejected the request: ${text}`, {
      reason: 'invalid_query',
      ...ctx.recoveryFor('invalid_query'),
    });
  }
  return serviceUnavailable(
    `Advanced Search could not answer the request${text ? `: ${text}` : '.'}`,
    { reason: 'search_unavailable', ...ctx.recoveryFor('search_unavailable'), retryable: false },
  );
}

/** `search_unavailable` with the outage hint, as error `data` fields. */
function outage(): Record<string, unknown> {
  return { reason: 'search_unavailable', recovery: { hint: OUTAGE_HINT } };
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
