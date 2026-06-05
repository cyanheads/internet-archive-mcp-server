/**
 * @fileoverview Wayback Machine service wrapping the Availability and CDX APIs.
 * @module services/wayback/wayback-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, getUserAgent } from '@/config/server-config.js';
import type { AvailabilityResult, CdxHistoryResult, CdxRecord, SnapshotContent } from './types.js';

/** Parameters for fetching CDX capture history. */
export interface FetchHistoryParams {
  collapse?: string | undefined;
  from?: string | undefined;
  limit?: number | undefined;
  resumeKey?: string | undefined;
  statusFilter?: string | undefined;
  to?: string | undefined;
  url: string;
}

const AVAILABILITY_BASE = 'https://archive.org/wayback/available';
const CDX_BASE = 'https://web.archive.org/cdx/search/cdx';
const WAYBACK_FETCH_BASE = 'https://web.archive.org/web';
const CDX_FIELDS = 'timestamp,statuscode,mimetype,original,digest,length';

export class WaybackService {
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  constructor(config: AppConfig, _storage: StorageService) {
    this.userAgent = getUserAgent(config.mcpServerVersion);
    this.timeoutMs = getServerConfig().requestTimeoutMs;
  }

  private get headers(): Record<string, string> {
    return { 'User-Agent': this.userAgent };
  }

  /**
   * Find the closest snapshot to a given timestamp using the Availability API.
   * Throws `not_found` data when archived_snapshots is empty.
   */
  findClosest(url: string, timestamp: string, ctx: Context): Promise<AvailabilityResult> {
    return withRetry(
      async () => {
        const params = new URLSearchParams({ url, timestamp });
        const response = await fetchWithTimeout(
          `${AVAILABILITY_BASE}?${params}`,
          this.timeoutMs,
          ctx as unknown as Parameters<typeof fetchWithTimeout>[2],
          { headers: this.headers, signal: ctx.signal },
        );

        const raw = (await response.json()) as {
          archived_snapshots?: {
            closest?: { url?: string; timestamp?: string; status?: string; available?: boolean };
          };
        };

        const closest = raw.archived_snapshots?.closest;
        if (!closest?.url || !closest.timestamp) {
          // Availability API returned archived_snapshots: {} — no capture near timestamp
          throw notFound(`No snapshot available for ${url} near ${timestamp}.`, {
            reason: 'no_snapshot_available',
            url,
            timestamp,
          });
        }

        return {
          snapshotUrl: closest.url,
          timestamp: closest.timestamp,
          status: closest.status ?? '200',
        };
      },
      {
        operation: 'WaybackService.findClosest',
        // biome-ignore lint/suspicious/noExplicitAny: framework withRetry context type mismatch
        context: ctx as any,
        baseDelayMs: 1_000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Fetch paginated capture history from the CDX API.
   * Throws `cdx_unavailable` on 503/504 or parse failure.
   */
  fetchHistory(params: FetchHistoryParams, ctx: Context): Promise<CdxHistoryResult> {
    return withRetry(
      async () => {
        const qp = new URLSearchParams({
          url: params.url,
          output: 'json',
          fl: CDX_FIELDS,
          collapse: params.collapse ?? 'timestamp:8',
          limit: String(params.limit ?? 100),
          showResumeKey: 'true',
        });
        if (params.from) qp.set('from', params.from);
        if (params.to) qp.set('to', params.to);
        if (params.statusFilter) qp.set('filter', `statuscode:${params.statusFilter}`);
        if (params.resumeKey) qp.set('resumeKey', params.resumeKey);

        const response = await fetchWithTimeout(
          `${CDX_BASE}?${qp}`,
          this.timeoutMs,
          ctx as unknown as Parameters<typeof fetchWithTimeout>[2],
          { headers: this.headers, signal: ctx.signal },
        );

        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('CDX API returned HTML — likely overloaded.', {
            reason: 'cdx_unavailable',
          });
        }

        let rows: unknown[][];
        try {
          rows = JSON.parse(text) as unknown[][];
        } catch {
          throw serviceUnavailable('CDX API returned unparseable response.', {
            reason: 'cdx_unavailable',
          });
        }

        if (!Array.isArray(rows) || rows.length === 0) {
          return { records: [] };
        }

        // First row is the header: ["timestamp","statuscode","mimetype","original","digest","length"]
        const header = rows[0] as string[];
        const colIndex = (col: string) => header.indexOf(col);

        // Detect trailing resume-key rows: CDX appends [[""], ["<key>"]] at the end
        let resumeKey: string | undefined;
        let dataRows = rows.slice(1);

        if (dataRows.length >= 2) {
          const secondLast = dataRows[dataRows.length - 2];
          const last = dataRows[dataRows.length - 1];
          if (
            Array.isArray(secondLast) &&
            secondLast.length === 1 &&
            secondLast[0] === '' &&
            Array.isArray(last) &&
            last.length === 1 &&
            typeof last[0] === 'string' &&
            last[0] !== ''
          ) {
            resumeKey = last[0] as string;
            dataRows = dataRows.slice(0, -2);
          }
        }

        const records: CdxRecord[] = dataRows.map((row) => {
          const r = row as string[];
          return {
            timestamp: r[colIndex('timestamp')] ?? '',
            statuscode: r[colIndex('statuscode')] ?? '',
            mimetype: r[colIndex('mimetype')] ?? '',
            original: r[colIndex('original')] ?? '',
            digest: r[colIndex('digest')] ?? '',
            ...(r[colIndex('length')] ? { length: r[colIndex('length')] } : {}),
          };
        });

        return { records, ...(resumeKey ? { resumeKey } : {}) };
      },
      {
        operation: 'WaybackService.fetchHistory',
        // biome-ignore lint/suspicious/noExplicitAny: framework withRetry context type mismatch
        context: ctx as any,
        baseDelayMs: 1_000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Fetch archived content for a resolved snapshot URL and extract readable text.
   * Throws `content_fetch_failed` if the fetch fails.
   */
  fetchContent(snapshotUrl: string, ctx: Context): Promise<SnapshotContent> {
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(
          snapshotUrl,
          this.timeoutMs,
          ctx as unknown as Parameters<typeof fetchWithTimeout>[2],
          { headers: this.headers, signal: ctx.signal },
        );

        const html = await response.text();
        const text = stripHtml(html);

        return { text, replayUrl: snapshotUrl };
      },
      {
        operation: 'WaybackService.fetchContent',
        // biome-ignore lint/suspicious/noExplicitAny: framework withRetry context type mismatch
        context: ctx as any,
        baseDelayMs: 1_000,
        signal: ctx.signal,
      },
    );
  }

  /** Build the Wayback replay URL for a resolved timestamp+url. */
  buildReplayUrl(timestamp: string, url: string): string {
    return `${WAYBACK_FETCH_BASE}/${timestamp}/${url}`;
  }
}

/** Strip HTML tags and normalize whitespace to produce readable plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// --- Init/accessor pattern ---

let _service: WaybackService | undefined;

export function initWaybackService(config: AppConfig, storage: StorageService): void {
  _service = new WaybackService(config, storage);
}

export function getWaybackService(): WaybackService {
  if (!_service) {
    throw new Error('WaybackService not initialized — call initWaybackService() in setup()');
  }
  return _service;
}
