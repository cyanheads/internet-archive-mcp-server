/**
 * @fileoverview Wayback Machine service wrapping the Availability and CDX APIs.
 * @module services/wayback/wayback-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
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
  waitPhrase,
} from '../upstream-errors.js';
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

/**
 * A Wayback upstream, the declared reason its failures surface as, and what a caller can
 * check when it refuses a request with a 4xx no retry fixes. The replay fetch has neither:
 * `ia_get_snapshot`, its only caller, maps its failures onto its own reasons.
 */
interface UpstreamApi {
  name: string;
  reason?: 'availability_unavailable' | 'cdx_unavailable';
  refusalCheck?: string;
}

const AVAILABILITY_API: UpstreamApi = {
  name: 'Availability API',
  reason: 'availability_unavailable',
  refusalCheck: 'check url and timestamp',
};
const CDX_API: UpstreamApi = {
  name: 'CDX API',
  reason: 'cdx_unavailable',
  refusalCheck: 'check url, from, to, and resume_key',
};
const REPLAY: UpstreamApi = { name: 'Wayback Machine' };

/**
 * Statuses with which the Wayback Machine declines to serve a URL at all — 403 is its
 * answer for a site excluded from the archive — so no timestamp can help. The replay and
 * both lookup APIs answer them alike.
 */
export const NOT_SERVED = new Set([403, 410, 451]);

/** The recovery for a URL the Wayback Machine does not serve: no retry or timestamp helps. */
export const NOT_SERVED_HINT =
  'No capture of this URL can be read from the Wayback Machine at any timestamp, so another ' +
  'timestamp or a retry will not help; look for the content under a different URL.';

/** The message for a URL the Wayback Machine answered with a `NOT_SERVED` status. */
export function notServedMessage(url: string, status: number): string {
  return (
    `The Wayback Machine does not serve captures of ${url} (HTTP ${status}` +
    `${status === 403 ? ', its answer for a site excluded from the archive' : ''}).`
  );
}

/**
 * The header only an archived representation carries (RFC 7089 §2.1.1). A replay non-2xx
 * with it is a capture of the site's own error page; without it, Wayback itself failed.
 */
const MEMENTO_DATETIME = 'memento-datetime';

const AVAILABILITY_BASE = 'https://archive.org/wayback/available';
const CDX_BASE = 'https://web.archive.org/cdx/search/cdx';
const WAYBACK_ORIGIN = 'https://web.archive.org';
const WAYBACK_FETCH_BASE = `${WAYBACK_ORIGIN}/web`;
const CDX_FIELDS = 'timestamp,statuscode,mimetype,original,digest,length';

/** Cursor keys use the tenant-scoped store; expiry is in seconds. */
const HISTORY_CURSOR_PREFIX = 'ia-history-v1/';
const HISTORY_CURSOR_TTL = 3_600;
const HISTORY_DEADLINE_MS = 45_000;
const LEGACY_HISTORY_NOTICE =
  'CDX raw continuation can omit captures when collapse is enabled. For complete paging on a stable index, restart with an exact URL and timestamp:N collapse (N=1–14).';
const HistoryCursor = z.object({
  url: z.string(),
  collapse: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  statusFilter: z.string().optional(),
  nextTimestamp: z.string().regex(/^\d{14}$/),
});

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
   * carrying the calling tool's recovery hint, when both sources answer with none or either
   * answers 403, 410, or 451. A
   * failed Availability request, thrown as `availability_unavailable`, or a cancelled one
   * never triggers the fallback; a fallback that fails or runs out of time is
   * `cdx_unavailable`, never a miss.
   */
  async findClosest(url: string, timestamp: string, ctx: Context): Promise<ClosestSnapshot> {
    const closest =
      (await this.retry('findClosest', AVAILABILITY_API, ctx, () =>
        this.queryAvailability(url, timestamp, ctx),
      )) ?? (await this.closestFromCdx(url, timestamp, ctx));
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
   * Throws `cdx_unavailable` on an HTTP 5xx or network error (after retries), a 429 or a
   * timeout (after one request), an HTML page, or an unparseable body.
   */
  async fetchHistory(params: FetchHistoryParams, ctx: Context): Promise<CdxHistoryResult> {
    let query = params;
    let originalBounds = params.from;
    const token = params.resumeKey;
    const serverCursor = token?.startsWith(HISTORY_CURSOR_PREFIX);
    if (token && serverCursor) {
      const id = token.slice(HISTORY_CURSOR_PREFIX.length);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
        !ctx.state
      ) {
        throw validationError('resume_key is not a usable history cursor.', {
          reason: 'invalid_resume_key',
          ...ctx.recoveryFor('invalid_resume_key'),
        });
      }
      const stored = await ctx.state.get(token, HistoryCursor);
      if (!stored)
        throw validationError('resume_key has expired or is unavailable for this caller.', {
          reason: 'invalid_resume_key',
          ...ctx.recoveryFor('invalid_resume_key'),
        });
      for (const field of ['url', 'collapse', 'from', 'to', 'statusFilter'] as const) {
        if (params[field] !== undefined && params[field] !== stored[field]) {
          throw validationError(
            `resume_key conflicts with ${field === 'statusFilter' ? 'status_filter' : field}.`,
            { reason: 'resume_key_conflict', ...ctx.recoveryFor('resume_key_conflict') },
          );
        }
      }
      originalBounds = stored.from;
      query = { ...stored, limit: params.limit, from: stored.nextTimestamp };
    }
    const collapse = query.collapse ?? 'timestamp:8';
    const exact = !query.url.includes('*');
    const eligible =
      exact &&
      /^timestamp:(?:[1-9]|1[0-4])$/.test(collapse) &&
      (!token || serverCursor) &&
      !!ctx.state;
    if (!eligible) {
      const result = await this.historyPage(query, ctx);
      return { ...result, ...((token || result.resumeKey) && { notice: LEGACY_HISTORY_NOTICE }) };
    }
    // Both the lookahead and a storage-outage fallback share this total deadline.
    const bounded = {
      ...ctx,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(HISTORY_DEADLINE_MS)]),
    };
    const limit = query.limit ?? 100;
    const result = await this.historyPage({ ...query, limit: limit + 1 }, bounded);
    const lookahead = result.records[limit];
    if (!lookahead)
      return {
        ...result,
        ...(result.resumeKey ? { notice: LEGACY_HISTORY_NOTICE } : { complete: true }),
      };
    const key = `${HISTORY_CURSOR_PREFIX}${crypto.randomUUID()}`;
    // Preserve original bounds in the cursor, separately from the inclusive seek bound.
    const cursor = {
      url: query.url,
      collapse,
      ...(originalBounds && { from: originalBounds }),
      ...(query.to && { to: query.to }),
      ...(query.statusFilter && { statusFilter: query.statusFilter }),
      nextTimestamp: lookahead.timestamp,
    };
    try {
      await bounded.state.set(key, cursor, { ttl: HISTORY_CURSOR_TTL });
    } catch (error) {
      bounded.signal.throwIfAborted();
      // Generated cursor values are JSON-safe; a typed storage failure can degrade to
      // the legacy path. Re-query at the original limit so its raw key loses no extra row.
      if (
        !(error instanceof McpError) ||
        ![
          JsonRpcErrorCode.InternalError,
          JsonRpcErrorCode.ConfigurationError,
          JsonRpcErrorCode.ServiceUnavailable,
          JsonRpcErrorCode.Timeout,
        ].includes(error.code)
      )
        throw error;
      const raw = await this.historyPage(query, bounded);
      return { ...raw, notice: `History cursor storage is unavailable. ${LEGACY_HISTORY_NOTICE}` };
    }
    return { records: result.records.slice(0, limit), resumeKey: key };
  }

  /** One CDX page, retaining the raw trailer for legacy paging and storage fallback. */
  private historyPage(params: FetchHistoryParams, ctx: Context): Promise<CdxHistoryResult> {
    return this.retry('fetchHistory', CDX_API, ctx, async () => {
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
   * with the charset the page declares.
   *
   * A non-2xx carrying `Memento-Datetime` is an archived error page, not a Wayback failure:
   * it is not retried and throws `NotFound` with `status` and `captureTimestamp`. Any other
   * 4xx but a 404, 408, 425, or 429 is Wayback refusing the request — a 403 is its answer
   * for a site excluded from the archive — and throws `NotFound` with `status` alone,
   * after one request. Otherwise a 5xx, 408, 425, or network error is retried, and a 429
   * or a timeout answered after one request, each as `ServiceUnavailable` (a 429 with a
   * hint to wait), which `ia_get_snapshot` remaps onto its declared `content_fetch_failed`;
   * a 404 and a caller cancellation propagate as the fetch threw them. No error carries
   * the replay's body. Text is capped at `maxChars` characters (defaults to
   * `maxSnapshotChars` from server config).
   */
  fetchContent(snapshotUrl: string, ctx: Context, maxChars?: number): Promise<SnapshotContent> {
    const cap = maxChars ?? getServerConfig().maxSnapshotChars;
    return this.retry('fetchContent', REPLAY, ctx, async () => {
      const response = await this.fetchUpstream(snapshotUrl, REPLAY, ctx, {
        errorHeaders: [MEMENTO_DATETIME],
      });

      const { bytes, truncated } = await readCapped(response, REPLAY_BYTE_CEILING).catch(
        (err: unknown) => {
          throw bodyReadError(err, REPLAY.name);
        },
      );
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
      { target: url },
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
   * miss — one marked `retryable: false` (a 4xx refusal, a 501) without promising a
   * retry. A URL the Wayback Machine does not serve and a caller cancellation pass
   * through untouched.
   */
  private async closestFromCdx(
    url: string,
    timestamp: string,
    ctx: Context,
  ): Promise<ClosestSnapshot | undefined> {
    try {
      return await this.queryCdxClosest(url, timestamp, ctx);
    } catch (err) {
      if (
        !(err instanceof McpError) ||
        err.code === JsonRpcErrorCode.RequestCancelled ||
        err.data?.reason === 'no_snapshot_available'
      ) {
        throw err;
      }
      const { status, retryAfter, retryable } = err.data ?? {};
      const hint =
        status === 429
          ? `The CDX API is rate-limiting requests; ${waitPhrase(retryAfter)}, then ${NEARBY_CAPTURES}.`
          : retryable === false
            ? `A retry will not help; ${NEARBY_CAPTURES}.`
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

  /**
   * Rows of a CDX JSON query. Throws `cdx_unavailable` on a 5xx, a 429, another 4xx, an
   * HTML page, or unparseable text, and `no_snapshot_available` on a `NOT_SERVED` status.
   */
  private async queryCdx(
    params: URLSearchParams,
    ctx: Context,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown[][]> {
    const response = await this.fetchUpstream(`${CDX_BASE}?${params}`, CDX_API, ctx, {
      timeoutMs,
      target: params.get('url') ?? '',
    });
    const rows = await readJson(response, CDX_API, ctx);
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * `fetchWithTimeout` with an upstream 5xx, 408, 425, or 429 rethrown as `api`'s declared
   * reason. It runs inside the caller's retry closure. A 5xx, 408, or 425 keeps the fields
   * the retry loop reads (`retryAfter`, `retryable`) and is retried like a 5xx, so the error
   * surfacing after the last attempt carries the reason and its recovery hint.
   * A 429 carries a hint to wait and is answered after one request by the retry predicate —
   * the upstream asked the client to slow down. A non-2xx whose `errorHeaders`
   * capture includes `Memento-Datetime` is an archived error page, thrown as `NotFound`.
   * Any other replay 4xx except a 404 is `replayRefusal`; any other lookup 4xx is
   * `lookupRefusal`, about the looked-up `target` URL. Every other failure, timeouts and
   * caller cancellation included, propagates untouched. A `NOT_SERVED` status, and a replay
   * 404, is an expected answer, so the fetch logs it at debug rather than error.
   */
  private async fetchUpstream(
    url: string,
    api: UpstreamApi,
    ctx: Context,
    {
      timeoutMs = this.timeoutMs,
      errorHeaders,
      target = url,
    }: { errorHeaders?: string[]; target?: string; timeoutMs?: number } = {},
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(url, timeoutMs, ctx, {
        headers: this.headers,
        signal: ctx.signal,
        expectedStatuses: api === REPLAY ? [...NOT_SERVED, 404] : [...NOT_SERVED],
        ...(errorHeaders && { errorHeaders }),
      });
    } catch (err) {
      const status = statusOf(err);
      if (status === undefined) throw err;
      const archived = archivedCaptureError(err as McpError, status);
      if (archived) throw archived;
      if (status === 429) throw rateLimitError(err, api.name, `The ${api.name}`, api.reason);
      if (status < 500 && status !== 408 && status !== 425) {
        if (api !== REPLAY) throw lookupRefusal(err as McpError, status, api, target);
        throw status !== 404 ? replayRefusal(err as McpError, status) : err;
      }
      const { retryAfter, retryable } = (err as McpError).data ?? {};
      throw serviceUnavailable(
        `${api.name} returned HTTP ${status}.`,
        {
          ...declaredReason(api, ctx),
          status,
          ...(retryAfter !== undefined && { retryAfter }),
          ...(retryable !== undefined && { retryable }),
        },
        { cause: err },
      );
    }
  }

  /**
   * Run `fn` under the framework retry loop, bound to the request's cancellation signal.
   * A timeout or a 429 is not retried (`isRetriedFailure`). A timeout, or a network error
   * once its retries are spent, surfaces as `api`'s declared reason; everything else leaves
   * as it was thrown.
   */
  private retry<T>(
    operation: string,
    api: UpstreamApi,
    ctx: Context,
    fn: () => Promise<T>,
  ): Promise<T> {
    return withRetry(fn, {
      operation: `WaybackService.${operation}`,
      context: ctx,
      baseDelayMs: 1_000,
      signal: ctx.signal,
      isTransient: isRetriedFailure,
    }).catch((err: unknown) => {
      throw transportError(err, api.name, this.timeoutMs, declaredReason(api, ctx));
    });
  }
}

/**
 * A lookup API's JSON body. An HTML page or unparseable text — what the Wayback APIs
 * serve when overloaded — throws `api`'s declared reason as `ServiceUnavailable`, which
 * the retry loop retries like a 5xx.
 */
async function readJson(response: Response, api: UpstreamApi, ctx: Context): Promise<unknown> {
  const text = await response.text().catch((err: unknown) => {
    throw bodyReadError(err, api.name);
  });
  if (isHtmlPage(text)) {
    throw serviceUnavailable(
      `${api.name} returned HTML — likely overloaded.`,
      declaredReason(api, ctx),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw serviceUnavailable(
      `${api.name} returned unparseable response.`,
      declaredReason(api, ctx),
    );
  }
}

/** `api`'s declared reason with the calling tool's recovery hint, as error `data` fields. */
function declaredReason(api: UpstreamApi, ctx: Context): Record<string, unknown> {
  return api.reason ? { reason: api.reason, ...ctx.recoveryFor(api.reason) } : {};
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

/**
 * A replay non-2xx carrying `Memento-Datetime` — Wayback replaying the error page the site
 * returned when it was captured — as a `NotFound` the retry loop does not retry, naming the
 * archived status and the capture's 14-digit timestamp. Undefined for any other failure.
 */
function archivedCaptureError(err: McpError, status: number): McpError | undefined {
  const headers = err.data?.headers as Record<string, string> | undefined;
  const datetime = headers?.[MEMENTO_DATETIME];
  if (typeof datetime !== 'string') return;
  const captured = Date.parse(datetime);
  const timestamp = Number.isNaN(captured)
    ? datetime
    : new Date(captured).toISOString().replace(/\D/g, '').slice(0, 14);
  return notFound(
    `The capture at ${timestamp} is an archived HTTP ${status} page.`,
    { status, captureTimestamp: timestamp },
    { cause: err },
  );
}

/**
 * A replay 4xx without `Memento-Datetime` — Wayback refusing the request rather than
 * replaying a capture, as with the 403 it answers for a site excluded from the archive —
 * as a `NotFound` the retry loop does not retry, carrying the status and never the
 * playback page Wayback sent as its body.
 */
function replayRefusal(err: McpError, status: number): McpError {
  return notFound(
    `The Wayback Machine answered the replay request with HTTP ${status} and no capture.`,
    { status },
    { cause: err },
  );
}

/**
 * A lookup API 4xx (not a 408, 425, or 429) about `target`, never carrying the upstream
 * body, and answered after one request. A `NOT_SERVED` status is the Wayback Machine
 * declining the URL itself, thrown as the declared `no_snapshot_available` with a hint that
 * no timestamp or retry helps. Any other is `api`'s declared reason marked
 * `retryable: false`, with a hint naming what the caller can check.
 */
function lookupRefusal(err: McpError, status: number, api: UpstreamApi, target: string): McpError {
  if (NOT_SERVED.has(status)) {
    return notFound(
      notServedMessage(target, status),
      { reason: 'no_snapshot_available', status, recovery: { hint: NOT_SERVED_HINT } },
      { cause: err },
    );
  }
  return serviceUnavailable(
    `${api.name} returned HTTP ${status}.`,
    {
      ...(api.reason && { reason: api.reason }),
      status,
      retryable: false,
      recovery: {
        hint: `The ${api.name} refused this request with HTTP ${status}, so repeating it unchanged will not help; ${api.refusalCheck}.`,
      },
    },
    { cause: err },
  );
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
