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
import { fetchWithTimeout, type RetryOptions, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, getUserAgent } from '@/config/server-config.js';
import { htmlToText } from '../html-text.js';
import {
  bodyReadError,
  isHtmlPage,
  isRetriedFailure,
  rateLimitError,
  statusOf,
  transportError,
  waitPhrase,
} from '../upstream-errors.js';
import { decodeHtml, decodeText } from './html-charset.js';
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
  'No capture of this URL can be read from the Wayback Machine at any timestamp, so another timestamp or a retry will not help; look for the content under a different URL.';

/** The message for a URL the Wayback Machine answered with a `NOT_SERVED` status. */
export function notServedMessage(url: string, status: number): string {
  return `The Wayback Machine does not serve captures of ${url} (HTTP ${status}${status === 403 ? ', its answer for a site excluded from the archive' : ''}).`;
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

/** CDX rows read around the requested timestamp when the Availability API cannot answer. */
const CDX_CLOSEST_WINDOW = 10;

/**
 * The most the CDX closest-capture fallback's single attempt gets, and how far past the
 * request timeout a closest-capture lookup's deadline reaches. Measured `sort=closest`
 * latencies ran 2.5–23 s for about half the URLs tried and 31 s to over 60 s for the rest,
 * so 25 s keeps every answer the default 30 s request timeout could have allowed while
 * leaving headroom under it. At that default the whole lookup ends within 55 s, inside the
 * 60 s MCP SDK clients wait for a tool call.
 */
const CDX_FALLBACK_DEADLINE_MS = 25_000;

/** A closest-capture lookup: what it resolves, and when its attempts, backoffs, and fallback must be done. */
interface ClosestLookup {
  /** Epoch milliseconds past which no request of the lookup runs. */
  deadlineAtMs: number;
  timestamp: string | undefined;
  url: string;
}

/**
 * Where a caller can go when the closest-capture lookup cannot answer: captures listed in
 * history mode, then read by an exact timestamp, which needs no lookup.
 */
function nearbyCaptures(timestamp: string | undefined): string {
  const list =
    timestamp === undefined
      ? `list recent captures with ia_find_snapshots in history mode, passing from "${new Date().getUTCFullYear()}"`
      : 'list nearby captures with ia_find_snapshots in history mode, passing from and to around the timestamp';
  return `${list}, then read one with ia_get_snapshot and its exact 14-digit timestamp, which needs no lookup`;
}

/** How messages name a lookup's target: near its timestamp, or nothing more for the latest capture. */
function near(timestamp: string | undefined): string {
  return timestamp === undefined ? '' : ` near ${timestamp}`;
}

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
  /** How long a closest-capture lookup may take: the request timeout plus the fallback's ceiling. */
  private readonly lookupBudgetMs: number;

  constructor(config: AppConfig, _storage: StorageService) {
    this.headers = { 'User-Agent': getUserAgent(config.mcpServerVersion) };
    this.timeoutMs = getServerConfig().requestTimeoutMs;
    this.lookupBudgetMs = this.timeoutMs + CDX_FALLBACK_DEADLINE_MS;
  }

  /**
   * Find the capture nearest `timestamp`, a 1–14 digit Wayback timestamp, or the latest
   * capture when it is undefined. The Availability API answers first. When it answers
   * without a usable capture, or answers with a failure — a 429, a 5xx, 408, or 425 after
   * its retries, or an HTML or unparseable body — CDX's closest query (`closest` +
   * `sort=closest`, on a different host) answers instead; it also finds captures the
   * Availability API sometimes misses. No answer at all (a timeout or a network error), a
   * 4xx refusal, and a caller cancellation never fall back.
   *
   * One deadline, the request timeout plus `CDX_FALLBACK_DEADLINE_MS`, spans every
   * Availability attempt and backoff, which run under the retry loop's clock, and the
   * fallback's single attempt, which gets that ceiling or what remains, whichever is less.
   * Throws `no_snapshot_available`, carrying the calling tool's recovery hint, when the
   * sources that answered have no capture or either answers 403, 410, or 451. A lookup that
   * cannot answer is never a miss: `availability_unavailable` when the Availability API
   * failed and its fallback did not answer either, or the deadline ran out on it;
   * `cdx_unavailable` when only the fallback after an empty answer failed.
   */
  async findClosest(
    url: string,
    timestamp: string | undefined,
    ctx: Context,
  ): Promise<ClosestSnapshot> {
    const lookup: ClosestLookup = {
      url,
      timestamp,
      deadlineAtMs: Date.now() + this.lookupBudgetMs,
    };
    let answer: ClosestSnapshot | undefined;
    let failure: McpError | undefined;
    try {
      answer = await withRetry(({ signal }) => this.queryAvailability(lookup, signal, ctx), {
        ...this.retryOptions('findClosest', ctx),
        deadlineMs: this.lookupBudgetMs,
      });
    } catch (err) {
      failure = failedAnswer(err, ctx);
      if (!failure) throw this.availabilityError(err, lookup, ctx);
    }
    const closest = answer ?? (await this.closestFromCdx(lookup, ctx, failure));
    if (closest) return closest;

    throw notFound(`No snapshot available for ${url}${near(timestamp)}.`, {
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
   * with.
   *
   * The replay's `Content-Type` decides the read before any body byte is taken. An HTML
   * page, or a capture with no media type, is read from the replay itself and stripped to
   * its text. Any other text type — `text/*`, JSON, XML, JavaScript, a `+xml` or `+json`
   * type — has its replay body cancelled unread, because that form rewrites the URLs inside
   * it, and is read as stored from the capture's `id_` form in a second request with the
   * same timeout and retries. A body of any other type is cancelled unread and throws
   * `NotFound` with `mediaType` and `replayUrl`. The body read is streamed up to
   * `REPLAY_BYTE_CEILING` bytes — a longer body is cut there, the upstream read cancelled,
   * and `truncatedAtBytes` set — then decoded with the charset the response declares, or
   * the one Wayback guessed for the capture.
   *
   * A non-2xx carrying `Memento-Datetime` is an archived error page, not a Wayback failure:
   * it is not retried and throws `NotFound` with `status` and `captureTimestamp`. Any other
   * 4xx but a 404, 408, 425, or 429 is Wayback refusing the request — a 403 is its answer
   * for a site excluded from the archive — and throws `NotFound` with `status` alone,
   * after one request. Otherwise a 5xx, 408, 425, or network error is retried, and a 429
   * or a timeout answered after one request, each as `ServiceUnavailable` (a 429 with a
   * hint to wait), which `ia_get_snapshot` remaps onto its declared `content_fetch_failed`;
   * a 404 and a caller cancellation propagate as the fetch threw them. No error carries
   * the replay's body. The text is returned whole; `ia_get_snapshot` pages it.
   */
  async fetchContent(snapshotUrl: string, ctx: Context): Promise<SnapshotContent> {
    const served = await this.retry('fetchContent', REPLAY, ctx, async () => {
      const response = await this.fetchUpstream(snapshotUrl, REPLAY, ctx, {
        errorHeaders: [MEMENTO_DATETIME],
      });
      const replayUrl = waybackUrl(response.url) ?? snapshotUrl;
      const guessedCharset = response.headers.get('x-archive-guessed-charset');
      const capture = { replayUrl, status: String(response.status), guessedCharset };
      const mediaType = mediaTypeOf(response.headers.get('content-type'));
      const kind = bodyKind(mediaType);
      if (kind === 'html') {
        return { ...capture, body: await readBody(response, 'html', guessedCharset) };
      }
      await response.body?.cancel();
      if (kind === 'other') {
        throw notFound(`The capture at ${replayUrl} is ${mediaType}, not text.`, {
          mediaType,
          replayUrl,
        });
      }
      return capture;
    });
    const body =
      'body' in served
        ? served.body
        : await this.readRawText(served.replayUrl, served.guessedCharset, ctx);

    return {
      text: body.text,
      replayUrl: served.replayUrl,
      timestamp: captureTimestamp(served.replayUrl),
      status: served.status,
      ...(body.truncated && { truncatedAtBytes: REPLAY_BYTE_CEILING }),
    };
  }

  /** Build the Wayback replay URL for a resolved timestamp+url. */
  buildReplayUrl(timestamp: string, url: string): string {
    return `${WAYBACK_FETCH_BASE}/${timestamp}/${url}`;
  }

  /**
   * A text capture's body as stored, from the `id_` form of `replayUrl`, under the same
   * timeout and retries as the replay request. The `id_` response carries no guessed
   * charset, so the one Wayback sent with the replay stands in for it. The replay already
   * served this capture, so an `id_` 4xx — a refusal, a 404, or an archived error page — says
   * nothing about the capture: it is `ServiceUnavailable` marked `retryable: false`, with a
   * hint naming the replay URL, never the `NotFound` `ia_get_snapshot` reads as no capture.
   */
  private readRawText(
    replayUrl: string,
    guessedCharset: string | null,
    ctx: Context,
  ): Promise<ReplayBody> {
    const rawUrl = rawReplayUrl(replayUrl);
    return this.retry('fetchContent', REPLAY, ctx, async () => {
      const response = await this.fetchUpstream(rawUrl, REPLAY, ctx, {
        errorHeaders: [MEMENTO_DATETIME],
      }).catch((err: unknown) => {
        if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.NotFound) throw err;
        throw serviceUnavailable(
          `The Wayback Machine replayed this capture but answered its unmodified form, ${rawUrl}, with HTTP ${err.data?.status ?? statusOf(err)}.`,
          {
            retryable: false,
            recovery: {
              hint: `Wayback replayed this capture but refused its unmodified form, so a retry is unlikely to help; open ${replayUrl} to read the capture, or pick another one with ia_find_snapshots in history mode.`,
            },
          },
          { cause: err },
        );
      });
      return readBody(response, 'text', guessedCharset);
    });
  }

  /**
   * One attempt at the Availability API's closest capture, aborted by `signal` — the retry
   * loop's, which carries the lookup's deadline and the caller's cancellation. Undefined when
   * the API names no capture on web.archive.org.
   */
  private async queryAvailability(
    { url, timestamp }: ClosestLookup,
    signal: AbortSignal,
    ctx: Context,
  ): Promise<ClosestSnapshot | undefined> {
    // Without a timestamp the API answers with the latest capture; a blank one draws HTTP 500.
    const params = new URLSearchParams({ url, ...(timestamp !== undefined && { timestamp }) });
    const response = await this.fetchUpstream(
      `${AVAILABILITY_BASE}?${params}`,
      AVAILABILITY_API,
      ctx,
      { target: url, signal },
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
   * The CDX fallback, after an empty Availability answer or a `failure`: one attempt, no
   * retries, under `CDX_FALLBACK_DEADLINE_MS`, the request timeout, or what remains of the
   * lookup's deadline, whichever is least. With none remaining it sends nothing, since the
   * request could only time out — unless the caller has already left, when the fetch fails
   * at once as the cancellation it is. Any upstream failure or timeout becomes
   * `lookupFailed`'s declared failure, never a miss. A URL the Wayback Machine does not
   * serve and a caller cancellation pass through untouched.
   */
  private async closestFromCdx(
    lookup: ClosestLookup,
    ctx: Context,
    failure?: McpError,
  ): Promise<ClosestSnapshot | undefined> {
    const remainingMs = lookup.deadlineAtMs - Date.now();
    if (remainingMs <= 0 && !ctx.signal.aborted) throw this.lookupFailed(lookup, failure);
    try {
      return await this.queryCdxClosest(
        lookup,
        Math.min(CDX_FALLBACK_DEADLINE_MS, this.timeoutMs, remainingMs),
        ctx,
      );
    } catch (err) {
      if (
        !(err instanceof McpError) ||
        ctx.signal.aborted ||
        err.code === JsonRpcErrorCode.RequestCancelled ||
        err.data?.reason === 'no_snapshot_available'
      ) {
        throw err;
      }
      throw this.lookupFailed(lookup, failure, err);
    }
  }

  /**
   * A closest-capture lookup whose CDX fallback did not answer — `fallbackErr` when it
   * failed, none when no time remained to send it — as its callers' declared reason. After
   * an empty Availability answer that is `cdx_unavailable`. After a `failure` it stays
   * `availability_unavailable`, keeping that answer's status and attempts, and names the
   * lookup rather than either API. The hint names the route that needs no lookup, after the
   * wait the first rate-limited answer asked for, and promises no retry only when every
   * answer refused the request outright.
   */
  private lookupFailed(
    { url, timestamp }: ClosestLookup,
    failure?: McpError,
    fallbackErr?: McpError,
  ): McpError {
    const answers = [failure, fallbackErr].filter((err) => err !== undefined);
    const limited = answers.find((err) => err.data?.status === 429);
    const { retryAfter } = (limited ?? answers.find((err) => err.data?.retryAfter))?.data ?? {};
    const refused = answers.length > 0 && answers.every((err) => err.data?.retryable === false);
    const nearby = nearbyCaptures(timestamp);
    const hint = limited
      ? `The Wayback Machine is rate-limiting the closest-capture lookup; ${waitPhrase(retryAfter)}, then ${nearby}.`
      : refused
        ? `A retry will not help; ${nearby}.`
        : `Retry later, or ${nearby}.`;
    const unsent = `time remained for the CDX closest-capture check within the ${this.lookupBudgetMs / 1000} s lookup deadline.`;
    const message = failure
      ? `The closest-capture lookup for ${url}${near(timestamp)} did not complete: ${failure.message} ${fallbackErr ? `The CDX closest-capture check it fell back to did not complete either: ${fallbackErr.message}` : `No ${unsent}`}`
      : `The Availability API found no capture of ${url}${near(timestamp)}, and ${fallbackErr ? `the CDX closest-capture check did not complete: ${fallbackErr.message}` : `no ${unsent}`}`;
    const { status, retryAttempts } = failure?.data ?? {};
    return serviceUnavailable(
      message,
      {
        reason: failure ? 'availability_unavailable' : 'cdx_unavailable',
        ...(status !== undefined && { status }),
        ...(retryAttempts !== undefined && { retryAttempts }),
        ...(retryAfter !== undefined && { retryAfter }),
        ...(refused && { retryable: false }),
        recovery: { hint },
      },
      { cause: fallbackErr ?? failure },
    );
  }

  /**
   * An Availability failure the CDX fallback does not stand in for, as callers see it: the
   * lookup's deadline expiring mid-request or mid-backoff, which leaves the fallback no time,
   * or a timeout or network error under the declared reason (`transportError`). A refusal, a
   * URL the Wayback Machine does not serve, and a cancellation leave as thrown.
   */
  private availabilityError(
    err: unknown,
    { url, timestamp }: ClosestLookup,
    ctx: Context,
  ): unknown {
    if (!isDeadlineExpiry(err)) {
      return transportError(
        err,
        AVAILABILITY_API.name,
        this.timeoutMs,
        declaredReason(AVAILABILITY_API, ctx),
      );
    }
    const { retryAttempts } = err.data ?? {};
    return serviceUnavailable(
      `The closest-capture lookup for ${url}${near(timestamp)} did not finish within its ${this.lookupBudgetMs / 1000} s deadline: the Availability API did not answer in time.`,
      {
        reason: AVAILABILITY_API.reason,
        ...(retryAttempts !== undefined && { retryAttempts }),
        recovery: { hint: `Retry later, or ${nearbyCaptures(timestamp)}.` },
      },
      { cause: err },
    );
  }

  /**
   * The capture CDX ranks nearest `timestamp`, preferring a 200 within the first rows, in one
   * request bounded by `timeoutMs`. CDX reads a blank `closest` as the latest capture.
   */
  private async queryCdxClosest(
    { url, timestamp }: ClosestLookup,
    timeoutMs: number,
    ctx: Context,
  ): Promise<ClosestSnapshot | undefined> {
    const rows = await this.queryCdx(
      new URLSearchParams({
        url,
        closest: timestamp ?? '',
        sort: 'closest',
        limit: String(CDX_CLOSEST_WINDOW),
        output: 'json',
        fl: 'timestamp,original,statuscode',
      }),
      ctx,
      timeoutMs,
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
      signal = ctx.signal,
    }: { errorHeaders?: string[]; signal?: AbortSignal; target?: string; timeoutMs?: number } = {},
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(url, timeoutMs, ctx, {
        headers: this.headers,
        signal,
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
   * Run `fn` under the framework retry loop (`retryOptions`). A timeout, or a network error
   * once its retries are spent, surfaces as `api`'s declared reason; everything else leaves
   * as it was thrown.
   */
  private retry<T>(
    operation: string,
    api: UpstreamApi,
    ctx: Context,
    fn: () => Promise<T>,
  ): Promise<T> {
    return withRetry(fn, this.retryOptions(operation, ctx)).catch((err: unknown) => {
      throw transportError(err, api.name, this.timeoutMs, declaredReason(api, ctx));
    });
  }

  /**
   * The framework retry loop's options for `operation`, bound to the request's cancellation
   * signal: a timeout or a 429 is not retried (`isRetriedFailure`).
   */
  private retryOptions(operation: string, ctx: Context): RetryOptions {
    return {
      operation: `WaybackService.${operation}`,
      context: ctx,
      baseDelayMs: 1_000,
      signal: ctx.signal,
      isTransient: isRetriedFailure,
    };
  }
}

/** The retry loop's own deadline running out, mid-attempt or mid-backoff. */
function isDeadlineExpiry(err: unknown): err is McpError {
  return err instanceof McpError && err.data?.reason === 'retry_deadline_exceeded';
}

/**
 * The failed Availability answer the CDX closest query stands in for: a 429, a 5xx, 408, or
 * 425 after its retries, or an HTML page or unparseable body — including one the lookup's
 * deadline overtook before the retry loop could report it. Before `transportError` maps
 * them, the only other Availability failures declared `availability_unavailable` are 4xx
 * refusals; a timeout, a network error, a URL the Wayback Machine does not serve, and a
 * cancellation carry no such reason. Undefined for all of those, and once the caller left.
 */
function failedAnswer(err: unknown, ctx: Context): McpError | undefined {
  if (ctx.signal.aborted) return;
  const answer = isDeadlineExpiry(err) ? err.cause : err;
  if (!(answer instanceof McpError) || answer.data?.reason !== AVAILABILITY_API.reason) return;
  const status = answer.data?.status;
  const refusal = typeof status === 'number' && status < 500 && ![408, 425, 429].includes(status);
  return refusal ? undefined : answer;
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

/** A replay URL's `web/<timestamp><modifier>/` prefix, capturing the 14-digit timestamp. */
const REPLAY_PREFIX = /^https:\/\/web\.archive\.org\/web\/(\d{14})(?:[a-z]{2}_)?\//;

/** The 14-digit capture timestamp in a Wayback replay URL. */
function captureTimestamp(replayUrl: string): string | undefined {
  return REPLAY_PREFIX.exec(replayUrl)?.[1];
}

/**
 * The `id_` form of a replay URL, which serves the capture's body as archived, without the
 * URL rewriting the replay applies. Every replay URL the service fetches carries a
 * 14-digit timestamp, so one without is a bug.
 */
function rawReplayUrl(replayUrl: string): string {
  const prefix = REPLAY_PREFIX.exec(replayUrl);
  if (!prefix) throw new Error(`Not a Wayback replay URL with a capture timestamp: ${replayUrl}`);
  return `${WAYBACK_FETCH_BASE}/${prefix[1]}id_/${replayUrl.slice(prefix[0].length)}`;
}

/** Media types outside `text/*`, `+xml`, and `+json` whose bodies are text. */
const TEXT_MEDIA_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/x-javascript',
  'application/xml',
]);

/**
 * The media type of a `Content-Type` value: the part before its parameters, trimmed and
 * lowercased. Undefined when there is none, or when it names no subtype — a type no
 * parser accepts, so it is read as an absent one.
 */
function mediaTypeOf(contentType: string | null): string | undefined {
  const type = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return type?.includes('/') ? type : undefined;
}

/**
 * How a replay body is read: an HTML page, or a capture with no media type, is
 * extracted as HTML; another text type is read as stored; anything else holds no text.
 */
function bodyKind(mediaType: string | undefined): 'html' | 'text' | 'other' {
  if (!mediaType || mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
    return 'html';
  }
  return mediaType.startsWith('text/') ||
    mediaType.endsWith('+xml') ||
    mediaType.endsWith('+json') ||
    TEXT_MEDIA_TYPES.has(mediaType)
    ? 'text'
    : 'other';
}

/** The text of a replay body and whether the read stopped at `REPLAY_BYTE_CEILING`. */
interface ReplayBody {
  text: string;
  truncated: boolean;
}

/**
 * A replay body streamed up to `REPLAY_BYTE_CEILING` and decoded with the charset its
 * response declares, else `guessedCharset`; an HTML body is then stripped to its text.
 */
async function readBody(
  response: Response,
  kind: 'html' | 'text',
  guessedCharset: string | null,
): Promise<ReplayBody> {
  const { bytes, truncated } = await readCapped(response, REPLAY_BYTE_CEILING).catch(
    (err: unknown) => {
      throw bodyReadError(err, REPLAY.name);
    },
  );
  const source = { contentType: response.headers.get('content-type'), guessedCharset, truncated };
  return {
    text: kind === 'html' ? htmlToText(decodeHtml(bytes, source)) : decodeText(bytes, source),
    truncated,
  };
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
