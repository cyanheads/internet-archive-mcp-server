/**
 * @fileoverview Wayback Machine service wrapping the Availability and CDX APIs.
 * @module services/wayback/wayback-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, getUserAgent } from '@/config/server-config.js';
import { decodeHtml } from './html-charset.js';
import { htmlToText } from './html-text.js';
import type { CdxHistoryResult, CdxRecord, ClosestSnapshot, SnapshotContent } from './types.js';

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

/** A Wayback lookup API and the declared reason its upstream failures surface as. */
interface UpstreamApi {
  name: string;
  reason: 'availability_unavailable' | 'cdx_unavailable';
}

const AVAILABILITY_API: UpstreamApi = {
  name: 'Availability API',
  reason: 'availability_unavailable',
};
const CDX_API: UpstreamApi = { name: 'CDX API', reason: 'cdx_unavailable' };

const AVAILABILITY_BASE = 'https://archive.org/wayback/available';
const CDX_BASE = 'https://web.archive.org/cdx/search/cdx';
const WAYBACK_ORIGIN = 'https://web.archive.org';
const WAYBACK_FETCH_BASE = `${WAYBACK_ORIGIN}/web`;
const CDX_FIELDS = 'timestamp,statuscode,mimetype,original,digest,length';

/** CDX rows read around the requested timestamp when the Availability API has no answer. */
const CDX_CLOSEST_WINDOW = 10;

/**
 * The single attempt the CDX closest-capture fallback gets. Measured `sort=closest`
 * latencies ran 2.5–23 s for about half the URLs tried and 31 s to over 60 s for the rest,
 * so 25 s keeps every answer the default 30 s request timeout could have allowed while
 * leaving headroom under it.
 */
const CDX_FALLBACK_DEADLINE_MS = 25_000;

/** Where a caller can go when the closest-capture lookup cannot answer. */
const NEARBY_CAPTURES =
  'list nearby captures with ia_find_snapshots in history mode, passing from and to around the timestamp';

/**
 * Bytes of a replay body read before the rest is abandoned. Measured on 2024 captures of
 * large pages, the heaviest (a 3.0 MB edition.cnn.com front page) yields all of its text
 * within its first 1.3 MB, and Wikipedia articles reach 50,000 characters of text within
 * 440 KB; 4 MiB leaves about three times that headroom.
 */
export const REPLAY_BYTE_CEILING = 4 * 1024 * 1024;

export class WaybackService {
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: AppConfig, _storage: StorageService) {
    this.headers = { 'User-Agent': getUserAgent(config.mcpServerVersion) };
    this.timeoutMs = getServerConfig().requestTimeoutMs;
  }

  /**
   * Find the capture nearest `timestamp`. Asks the Availability API first; only when it
   * answers without a usable capture does it query CDX (`closest` + `sort=closest`), which
   * finds captures the Availability API sometimes misses. Throws `no_snapshot_available`,
   * carrying the calling tool's recovery hint, only when both sources answer with none. A
   * failed or cancelled Availability request propagates as it is and never triggers the
   * fallback; a fallback that fails or runs out of time is `cdx_unavailable`, never a miss.
   */
  async findClosest(url: string, timestamp: string, ctx: Context): Promise<ClosestSnapshot> {
    const closest =
      (await this.retry('findClosest', ctx, () => this.queryAvailability(url, timestamp, ctx))) ??
      (await this.closestFromCdx(url, timestamp, ctx));
    if (closest) return closest;

    throw notFound(`No snapshot available for ${url} near ${timestamp}.`, {
      reason: 'no_snapshot_available',
      url,
      timestamp,
      ...ctx.recoveryFor('no_snapshot_available'),
    });
  }

  /**
   * Fetch paginated capture history from the CDX API.
   * Throws `cdx_unavailable` on an HTTP 5xx (after retries) or 429, an HTML page, or an unparseable body.
   */
  fetchHistory(params: FetchHistoryParams, ctx: Context): Promise<CdxHistoryResult> {
    return this.retry('fetchHistory', ctx, async () => {
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

      const rows = await this.queryCdx(qp, ctx);
      if (rows.length === 0) {
        return { records: [] };
      }

      // First row is the header: ["timestamp","statuscode","mimetype","original","digest","length"]
      const header = rows[0] as string[];
      const colIndex = (col: string) => header.indexOf(col);

      /**
       * Detect the trailing resume-key rows. Under `showResumeKey=true` CDX closes
       * the body with a blank separator row followed by a single-cell row holding
       * the key. The separator arrives as `[]`; accept any all-empty row so the
       * documented `[""]` spelling is handled too. Missing the trailer would emit
       * both rows as captures and drop the key.
       */
      let resumeKey: string | undefined;
      let dataRows = rows.slice(1);

      if (dataRows.length >= 2) {
        const secondLast = dataRows[dataRows.length - 2];
        const last = dataRows[dataRows.length - 1];
        const key = Array.isArray(last) && last.length === 1 ? last[0] : undefined;
        if (
          Array.isArray(secondLast) &&
          secondLast.every((cell) => cell === '') &&
          typeof key === 'string' &&
          key !== ''
        ) {
          resumeKey = key;
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
    });
  }

  /**
   * Fetch archived content for a snapshot URL and extract readable text. Reports the
   * capture Wayback served, which differs from the requested one when Wayback redirects
   * a timestamp that is not itself a capture, and the HTTP status it replayed that capture
   * with. The body is streamed and read up to `REPLAY_BYTE_CEILING` bytes — a longer body
   * is cut there, the upstream read cancelled, and `truncatedAtBytes` set — then decoded
   * with the charset the page declares. A 429 is answered after one request, as
   * `ServiceUnavailable` with `retryable: false` and a hint to wait; every other failure
   * propagates as the status-mapped error from the fetch. `ia_get_snapshot` remaps a
   * `ServiceUnavailable` onto its declared `content_fetch_failed` contract entry. Text is
   * capped at `maxChars` characters (defaults to `maxSnapshotChars` from server config).
   */
  fetchContent(snapshotUrl: string, ctx: Context, maxChars?: number): Promise<SnapshotContent> {
    const cap = maxChars ?? getServerConfig().maxSnapshotChars;
    return this.retry('fetchContent', ctx, async () => {
      const response = await fetchWithTimeout(snapshotUrl, this.timeoutMs, ctx, {
        headers: this.headers,
        signal: ctx.signal,
      }).catch((err: unknown) => {
        throw statusOf(err) === 429 ? rateLimitError('Wayback Machine', err as McpError) : err;
      });

      const { bytes, truncated } = await readCapped(response, REPLAY_BYTE_CEILING);
      const html = decodeHtml(bytes, {
        contentType: response.headers.get('content-type'),
        guessedCharset: response.headers.get('x-archive-guessed-charset'),
        truncated,
      });
      const replayUrl = waybackUrl(response.url) ?? snapshotUrl;

      return {
        text: htmlToText(html).slice(0, cap),
        replayUrl,
        timestamp: captureTimestamp(replayUrl),
        status: String(response.status),
        ...(truncated && { truncatedAtBytes: REPLAY_BYTE_CEILING }),
      };
    });
  }

  /** Build the Wayback replay URL for a resolved timestamp+url. */
  buildReplayUrl(timestamp: string, url: string): string {
    return `${WAYBACK_FETCH_BASE}/${timestamp}/${url}`;
  }

  /** The Availability API's closest capture, or undefined when it names none on web.archive.org. */
  private async queryAvailability(
    url: string,
    timestamp: string,
    ctx: Context,
  ): Promise<ClosestSnapshot | undefined> {
    const params = new URLSearchParams({ url, timestamp });
    const response = await this.fetchUpstream(
      `${AVAILABILITY_BASE}?${params}`,
      AVAILABILITY_API,
      ctx,
    );
    const raw = (await readJson(response, AVAILABILITY_API, ctx)) as {
      archived_snapshots?: {
        closest?: { url?: string; timestamp?: string; status?: string; available?: boolean };
      };
    } | null;

    // An empty archived_snapshots means no answer, and so does a URL off web.archive.org:
    // the service fetches only Wayback replay URLs.
    const closest = raw?.archived_snapshots?.closest;
    const snapshotUrl = closest?.url ? waybackUrl(closest.url) : undefined;
    if (!snapshotUrl || !closest?.timestamp) return;

    return { snapshotUrl, timestamp: closest.timestamp, status: closest.status ?? '200' };
  }

  /**
   * The CDX fallback: one attempt under its own deadline, no retries. Any upstream failure
   * or timeout becomes `cdx_unavailable` saying the lookup could not finish, never a
   * miss; a caller cancellation passes through untouched.
   */
  private async closestFromCdx(
    url: string,
    timestamp: string,
    ctx: Context,
  ): Promise<ClosestSnapshot | undefined> {
    try {
      return await this.queryCdxClosest(url, timestamp, ctx);
    } catch (err) {
      if (!(err instanceof McpError) || err.code === JsonRpcErrorCode.RequestCancelled) throw err;
      const { status, retryAfter, retryable } = err.data ?? {};
      const hint =
        status === 429
          ? `The CDX API is rate-limiting requests; ${waitPhrase(retryAfter)}, then ${NEARBY_CAPTURES}.`
          : `Retry later, or ${NEARBY_CAPTURES}.`;
      throw serviceUnavailable(
        `The Availability API found no capture of ${url} near ${timestamp}, and the CDX closest-capture check did not complete: ${err.message}`,
        {
          reason: 'cdx_unavailable',
          ...(retryAfter !== undefined && { retryAfter }),
          ...(retryable !== undefined && { retryable }),
          recovery: { hint },
        },
        { cause: err },
      );
    }
  }

  /** The capture CDX ranks nearest `timestamp`, preferring a 200 within the first rows. */
  private async queryCdxClosest(
    url: string,
    timestamp: string,
    ctx: Context,
  ): Promise<ClosestSnapshot | undefined> {
    const rows = await this.queryCdx(
      new URLSearchParams({
        url,
        closest: timestamp,
        sort: 'closest',
        limit: String(CDX_CLOSEST_WINDOW),
        output: 'json',
        fl: 'timestamp,original,statuscode',
      }),
      ctx,
      Math.min(CDX_FALLBACK_DEADLINE_MS, this.timeoutMs),
    );

    const captures = rows.slice(1) as string[][];
    const [captureTs, original, status = '-'] =
      captures.find((row) => row[2] === '200') ?? captures[0] ?? [];
    if (!captureTs || !original) return;

    return { snapshotUrl: this.buildReplayUrl(captureTs, original), timestamp: captureTs, status };
  }

  /** Rows of a CDX JSON query. Throws `cdx_unavailable` on a 5xx, a 429, an HTML page, or unparseable text. */
  private async queryCdx(
    params: URLSearchParams,
    ctx: Context,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown[][]> {
    const response = await this.fetchUpstream(`${CDX_BASE}?${params}`, CDX_API, ctx, timeoutMs);
    const rows = await readJson(response, CDX_API, ctx);
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * `fetchWithTimeout` with an upstream 5xx or 429 rethrown as `api`'s declared reason.
   * It runs inside the caller's retry closure. A 5xx keeps the code and the fields the
   * retry loop reads (`retryAfter`, `retryable`), so the attempt count is unchanged and
   * the error surfacing after the last attempt carries the reason and its recovery hint.
   * A 429 is marked `retryable: false` — the upstream asked the client to slow down, so
   * it is answered after one request with a hint to wait. Every other failure, caller
   * cancellation included, propagates untouched.
   */
  private async fetchUpstream(
    url: string,
    api: UpstreamApi,
    ctx: Context,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(url, timeoutMs, ctx, {
        headers: this.headers,
        signal: ctx.signal,
      });
    } catch (err) {
      const status = statusOf(err);
      if (status === undefined || (status < 500 && status !== 429)) throw err;
      if (status === 429) throw rateLimitError(api.name, err as McpError, api.reason);
      const { retryAfter, retryable } = (err as McpError).data ?? {};
      throw serviceUnavailable(
        `${api.name} returned HTTP ${status}.`,
        {
          reason: api.reason,
          status,
          ...(retryAfter !== undefined && { retryAfter }),
          ...(retryable !== undefined && { retryable }),
          ...ctx.recoveryFor(api.reason),
        },
        { cause: err },
      );
    }
  }

  /** Run `fn` under the framework retry loop, bound to the request's cancellation signal. */
  private retry<T>(operation: string, ctx: Context, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      operation: `WaybackService.${operation}`,
      context: ctx,
      baseDelayMs: 1_000,
      signal: ctx.signal,
    });
  }
}

/**
 * A lookup API's JSON body. An HTML page or unparseable text — what the Wayback APIs
 * serve when overloaded — throws `api`'s declared reason as `ServiceUnavailable`, which
 * the retry loop retries like a 5xx.
 */
async function readJson(response: Response, api: UpstreamApi, ctx: Context): Promise<unknown> {
  const text = await response.text();
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
    throw serviceUnavailable(`${api.name} returned HTML — likely overloaded.`, {
      reason: api.reason,
      ...ctx.recoveryFor(api.reason),
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw serviceUnavailable(`${api.name} returned unparseable response.`, {
      reason: api.reason,
      ...ctx.recoveryFor(api.reason),
    });
  }
}

/**
 * The first `ceiling` bytes of a response body, streamed. When the body runs past the
 * ceiling the read stops there and the upstream stream is cancelled rather than drained.
 */
async function readCapped(
  response: Response,
  ceiling: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= ceiling) {
    const { done, value } = await reader.read();
    if (done) return { bytes: concatBytes(chunks, size), truncated: false };
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel();
  return { bytes: concatBytes(chunks, ceiling), truncated: true };
}

/** The first `length` bytes of `chunks` joined. */
function concatBytes(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    if (at >= length) break;
    bytes.set(chunk.subarray(0, length - at), at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The upstream HTTP status a `fetchWithTimeout` error carries, if it came from a response. */
function statusOf(err: unknown): number | undefined {
  const status = err instanceof McpError ? err.data?.statusCode : undefined;
  return typeof status === 'number' ? status : undefined;
}

/**
 * A 429 from `upstream`, rethrown as `ServiceUnavailable` that the retry loop does not
 * retry (`retryable: false`), with the `Retry-After` value and a hint to wait — the
 * upstream asked the client to slow down, so retrying would only extend the limit.
 */
function rateLimitError(upstream: string, err: McpError, reason?: UpstreamApi['reason']): McpError {
  const { retryAfter } = err.data ?? {};
  return serviceUnavailable(
    `${upstream} returned HTTP 429 (rate limited).`,
    {
      ...(reason && { reason }),
      status: 429,
      ...(retryAfter !== undefined && { retryAfter }),
      retryable: false,
      recovery: {
        hint: `The ${upstream} is rate-limiting requests; ${waitPhrase(retryAfter)} before retrying.`,
      },
    },
    { cause: err },
  );
}

/** How long a rate-limited caller should wait, from a `Retry-After` value when one was sent. */
function waitPhrase(retryAfter: unknown): string {
  if (typeof retryAfter === 'string' && /^\d+$/.test(retryAfter.trim())) {
    return `wait ${retryAfter.trim()} seconds`;
  }
  const until = typeof retryAfter === 'string' ? Date.parse(retryAfter) : Number.NaN;
  return Number.isNaN(until)
    ? 'wait several minutes'
    : `wait until ${new Date(until).toUTCString()}`;
}

/** The https form of a web.archive.org URL; undefined for any other URL. */
function waybackUrl(url: string): string | undefined {
  const prefix = /^https?:\/\/web\.archive\.org\//i.exec(url)?.[0];
  return prefix ? `${WAYBACK_ORIGIN}/${url.slice(prefix.length)}` : undefined;
}

/** The 14-digit capture timestamp in a Wayback replay URL. */
function captureTimestamp(replayUrl: string): string | undefined {
  return /^https:\/\/web\.archive\.org\/web\/(\d{14})(?:[a-z]{2}_)?\//.exec(replayUrl)?.[1];
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
