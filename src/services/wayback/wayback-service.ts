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
import { fetchWithTimeout, isRecord, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getUserAgent } from '@/config/server-config.js';
import type { CallDeadline } from '../call-deadline.js';
import { type AnchoredText, htmlToText, htmlToTextAndAnchors } from '../html-text.js';
import {
  bodyReadError,
  isHtmlPage,
  isRetriedFailure,
  rateLimitError,
  statusOf,
  transportError,
  unansweredRequestError,
  waitPhrase,
} from '../upstream-errors.js';
import { decodeHtml, decodeText } from './html-charset.js';
import type {
  ArchivedRedirect,
  CdxHistoryResult,
  CdxRecord,
  ClosestSnapshot,
  PageLink,
  RedirectDeadEnd,
  SnapshotContent,
} from './types.js';
import { captureOf, hrefTarget, WAYBACK_HOSTS } from './wayback-capture-url.js';

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

/**
 * The statuses a replay redirects with: Wayback's own redirect to the nearest capture, or the
 * replay of a capture that is itself an archived redirect, carrying the status the site sent.
 */
const REDIRECT_STATUSES = new Set([300, 301, 302, 303, 307, 308]);

/**
 * The most redirects one replay request follows; the next ends it without a capture. Observed
 * archived-redirect chains run to 3, and an archived redirect usually costs two (its own, then
 * Wayback's to the target's nearest capture), so 10 admits five stacked archived redirects.
 */
export const MAX_REPLAY_REDIRECTS = 10;

/** The URL schemes a replay redirect is followed to. */
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

const AVAILABILITY_BASE = 'https://archive.org/wayback/available';
const CDX_BASE = 'https://web.archive.org/cdx/search/cdx';
const WAYBACK_ORIGIN = 'https://web.archive.org';
const WAYBACK_FETCH_BASE = `${WAYBACK_ORIGIN}/web`;
const CDX_FIELDS = 'timestamp,statuscode,mimetype,original,digest,length';

/** Cursor keys use the tenant-scoped store; expiry is in seconds. */
const HISTORY_CURSOR_PREFIX = 'ia-history-v1/';
const HISTORY_CURSOR_TTL = 3_600;
/** The continuation notice for an exact URL paged by a CDX key the server did not issue. */
const LEGACY_HISTORY_NOTICE =
  'CDX raw continuation can omit captures at page boundaries. Restarting without resume_key pages an exact URL through server resume keys, which omit none on a stable index.';
/** The continuation notice for a wildcard url, which always pages by CDX's own key. */
const WILDCARD_HISTORY_NOTICE =
  'CDX raw continuation pages a wildcard url and can omit the row at each page boundary or return it as a later capture of the same URL; a limit that holds the whole listing (up to 10,000 rows) avoids both.';

/**
 * Where a resumed `digest` page starts within the second it resumes at: the digest of the
 * lookahead row it resumes on, and how many rows of the listing at that second earlier pages
 * returned (`resumedDigestRows`).
 */
const DigestResume = z.object({
  digest: z.string(),
  returned: z.number().int().min(0),
});
type DigestResume = z.infer<typeof DigestResume>;

/**
 * A server history cursor: the query it continues and the unreturned lookahead row's timestamp,
 * which the next page resumes at inclusively. Only a `digest` cursor carries `digestResume`, so a
 * cursor written before it existed still parses.
 */
const HistoryCursor = z.object({
  url: z.string(),
  collapse: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  statusFilter: z.string().optional(),
  nextTimestamp: z.string().regex(/^\d{14}$/),
  digestResume: DigestResume.optional(),
});

/**
 * How CDX reads a `url`: a leading `*.` asks for a domain and its subdomains, a trailing `*` for
 * every URL under a prefix, and anything else is one exact URL — a `*` elsewhere in it included,
 * which CDX matches literally.
 */
export function cdxMatchType(url: string): 'domain' | 'exact' | 'prefix' {
  if (url.startsWith('*.')) return 'domain';
  return url.endsWith('*') ? 'prefix' : 'exact';
}

/**
 * The rows of a resumed `digest` page from its lookahead row on. CDX restarts the collapse at the
 * page's `from`, the lookahead's second, so it first re-lists the rows of the listing at that second
 * which earlier pages returned, preceded by a capture the unpaged listing collapsed whenever one
 * shares that second: the lookahead's digest, which differs from the row before it in the listing,
 * tells whether that capture is there. Dropping by count rather than by the first row carrying the
 * digest keeps a second whose digests run A, B, A from resuming on its first A again.
 */
function resumedDigestRows(
  records: CdxRecord[],
  { timestamp, digest, returned }: DigestResume & { timestamp: string },
): CdxRecord[] {
  const atResume = (i: number) => records[i]?.timestamp === timestamp;
  let drop = 0;
  while (drop < returned && atResume(drop)) drop++;
  if (
    atResume(drop + 1) &&
    records[drop]?.digest !== digest &&
    records[drop + 1]?.digest === digest
  )
    drop++;
  return records.slice(drop);
}

/** CDX rows read around the requested timestamp when the Availability API cannot answer. */
const CDX_CLOSEST_WINDOW = 10;

/**
 * The most the CDX closest-capture fallback's single attempt gets, when the request timeout
 * and what remains of the call deadline both allow more. Measured `sort=closest` latencies
 * ran 2.5–23 s for about half the URLs tried and 31 s to over 60 s for the rest, so 25 s
 * keeps every answer the default 30 s request timeout could have allowed while leaving
 * headroom under it.
 */
const CDX_FALLBACK_CEILING_MS = 25_000;

/** A closest-capture lookup: what it resolves, and the call deadline its requests run under. */
interface ClosestLookup {
  deadline: CallDeadline;
  timestamp: string | undefined;
  url: string;
}

/** What one request is sent under: the abort signal it honors and its timeout. */
interface RequestLimits {
  signal: AbortSignal;
  timeoutMs: number;
}

/** A replay whose redirects ended on a 2xx: the response, the URL that served it, and the archived redirects passed. */
interface ServedReplay {
  redirects: ArchivedRedirect[];
  replayUrl: string;
  response: Response;
}

/** A replay 3xx: its status, its `Location`, and its capture timestamp when it is an archived redirect. */
interface ReplayRedirect {
  captureTimestamp: string | undefined;
  location: string | undefined;
  status: number;
}

/**
 * Where a caller can go when the closest-capture lookup cannot answer: captures listed in
 * history mode, then read by an exact timestamp, which needs no lookup. History rows run
 * oldest first and a URL's latest capture can predate this year, so the latest-capture
 * route names no fixed year and says to step back when a year lists nothing.
 */
function nearbyCaptures(timestamp: string | undefined): string {
  const list =
    timestamp === undefined
      ? 'list captures with ia_find_snapshots in history mode and status_filter "200", from a recent year (rows run oldest first; pass an earlier year when none are listed)'
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

  constructor(config: AppConfig, _storage: StorageService) {
    this.headers = { 'User-Agent': getUserAgent(config.mcpServerVersion) };
  }

  /**
   * Find the capture nearest `timestamp`, a 1–14 digit Wayback timestamp, or the latest
   * capture when it is undefined. The Availability API answers first. When it answers
   * without a usable capture, or answers with a failure — a 429, a 5xx, 408, or 425 after
   * its retries, an HTML or unparseable body, or an `error` in place of a capture, which is
   * not retried — CDX's closest query (`closest` + `sort=closest`, on a different host)
   * answers instead; it also finds captures the Availability API sometimes misses. No answer
   * at all (a timeout, a network error, or a redirect chain `fetchWithTimeout` refused to
   * follow), a 4xx refusal, and a caller cancellation never fall back.
   *
   * The Availability attempts and backoffs run under what remains of the call's `deadline`,
   * and the fallback's single attempt gets `CDX_FALLBACK_CEILING_MS`, the request timeout, or
   * what remains, whichever is least. Throws `no_snapshot_available`, carrying the calling
   * tool's recovery hint, when the sources that answered have no capture or either answers
   * 403, 410, or 451. A lookup that cannot answer is never a miss: `availability_unavailable`
   * when the Availability API failed and its fallback did not answer either, or the deadline
   * ran out on it; `cdx_unavailable` when only the fallback after an empty answer failed.
   */
  async findClosest(
    url: string,
    timestamp: string | undefined,
    ctx: Context,
    deadline: CallDeadline,
  ): Promise<ClosestSnapshot> {
    const lookup: ClosestLookup = { url, timestamp, deadline };
    let answer: ClosestSnapshot | undefined;
    let failure: McpError | undefined;
    try {
      const answered = await this.attempts(ctx, deadline, (limits) =>
        this.queryAvailability(lookup, limits, ctx),
      );
      if (answered instanceof McpError) failure = answered;
      else answer = answered;
    } catch (err) {
      failure = failedAnswer(err, lookup, ctx);
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
   * Fetch paginated capture history from the CDX API. Every CDX request — the page, and the
   * re-query a cursor-storage outage falls back to — runs under what remains of the call's
   * `deadline`. A page with no `records` is CDX listing no rows for the query, and nothing
   * else. Throws `cdx_unavailable` on an HTTP 5xx or network error (after retries), a 429, a
   * timeout, or a redirect chain `fetchWithTimeout` refused to follow (after one request), an
   * HTML page, an unparseable body or JSON that is not a list of rows (after retries), or the
   * deadline running out, mid-request or mid-backoff.
   *
   * An exact URL pages through server cursors under every collapse: each page asks CDX for one
   * row past `limit`, and the next page resumes at that unreturned lookahead row's timestamp,
   * inclusively, sending no CDX key. A resumed `digest` page also drops what CDX re-lists ahead
   * of the lookahead (`resumedDigestRows`), asking for that many more rows. A wildcard url, or a
   * resume key the server did not issue, pages by CDX's own key, with a notice of what that can
   * omit whenever a key is returned or consumed.
   */
  async fetchHistory(
    params: FetchHistoryParams,
    ctx: Context,
    deadline: CallDeadline,
  ): Promise<CdxHistoryResult> {
    let query = params;
    let originalBounds = params.from;
    let digestResume: (DigestResume & { timestamp: string }) | undefined;
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
      if (stored.digestResume)
        digestResume = { ...stored.digestResume, timestamp: stored.nextTimestamp };
      query = { ...stored, limit: params.limit, from: stored.nextTimestamp };
    }
    const collapse = query.collapse ?? 'timestamp:8';
    const exact = cdxMatchType(query.url) === 'exact';
    if (!exact || (token && !serverCursor) || !ctx.state) {
      const result = await this.historyPage(query, ctx, deadline);
      const notice = exact ? LEGACY_HISTORY_NOTICE : WILDCARD_HISTORY_NOTICE;
      return { ...result, ...((token || result.resumeKey) && { notice }) };
    }
    const limit = query.limit ?? 100;
    // At most the rows earlier pages returned at the resumed second, and one collapsed capture.
    const droppable = digestResume ? digestResume.returned + 1 : 0;
    const page = await this.historyPage({ ...query, limit: limit + 1 + droppable }, ctx, deadline);
    const records = digestResume ? resumedDigestRows(page.records, digestResume) : page.records;
    const dropped = page.records.length - records.length;
    const lookahead = records[limit];
    if (!lookahead)
      return {
        ...page,
        records,
        ...(page.resumeKey ? { notice: LEGACY_HISTORY_NOTICE } : { complete: true }),
      };
    const returned = records.slice(0, limit);
    const key = `${HISTORY_CURSOR_PREFIX}${crypto.randomUUID()}`;
    // Preserve original bounds in the cursor, separately from the inclusive seek bound.
    const cursor = {
      url: query.url,
      collapse,
      ...(originalBounds && { from: originalBounds }),
      ...(query.to && { to: query.to }),
      ...(query.statusFilter && { statusFilter: query.statusFilter }),
      nextTimestamp: lookahead.timestamp,
      ...(collapse === 'digest' && {
        digestResume: {
          digest: lookahead.digest,
          // The listing's rows at the lookahead's second before it: this page's, plus those
          // earlier pages returned when this page resumed at that same second.
          returned:
            returned.filter((r) => r.timestamp === lookahead.timestamp).length +
            (digestResume?.timestamp === lookahead.timestamp ? digestResume.returned : 0),
        } satisfies DigestResume,
      }),
    };
    try {
      await ctx.state.set(key, cursor, { ttl: HISTORY_CURSOR_TTL });
    } catch (error) {
      ctx.signal.throwIfAborted();
      // Generated cursor values are JSON-safe; a typed storage failure can degrade to the
      // legacy path. Re-query at the original limit, plus the rows a resumed digest page
      // dropped ahead of it, so its raw key loses no extra row.
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
      const raw = await this.historyPage({ ...query, limit: limit + dropped }, ctx, deadline);
      return {
        ...raw,
        records: raw.records.slice(dropped),
        notice: `History cursor storage is unavailable. ${LEGACY_HISTORY_NOTICE}`,
      };
    }
    return { records: returned, resumeKey: key };
  }

  /** One CDX page, retaining the raw trailer for legacy paging and storage fallback. */
  private historyPage(
    params: FetchHistoryParams,
    ctx: Context,
    deadline: CallDeadline,
  ): Promise<CdxHistoryResult> {
    return this.retry(CDX_API, ctx, deadline, async (limits) => {
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

      // First row is the header: ["timestamp","statuscode","mimetype","original","digest","length"]
      const [header, ...body] = await this.queryCdx(qp, ctx, limits);
      if (!header) {
        return { records: [] };
      }
      const colIndex = (col: string) => header.indexOf(col);

      /**
       * Detect the trailing resume-key rows. Under `showResumeKey=true` CDX closes
       * the body with a blank separator row followed by a single-cell row holding
       * the key. The separator arrives as `[]`; accept any all-empty row so the
       * documented `[""]` spelling is handled too. Missing the trailer would emit
       * both rows as captures and drop the key.
       */
      let resumeKey: string | undefined;
      let dataRows = body;

      if (dataRows.length >= 2) {
        const secondLast = dataRows[dataRows.length - 2];
        const last = dataRows[dataRows.length - 1];
        const key = last?.length === 1 ? last[0] : undefined;
        if (secondLast?.every((cell) => cell === '') && key) {
          resumeKey = key;
          dataRows = dataRows.slice(0, -2);
        }
      }

      const records: CdxRecord[] = dataRows.map((r) => ({
        timestamp: r[colIndex('timestamp')] ?? '',
        statuscode: r[colIndex('statuscode')] ?? '',
        mimetype: r[colIndex('mimetype')] ?? '',
        original: r[colIndex('original')] ?? '',
        digest: r[colIndex('digest')] ?? '',
        ...(r[colIndex('length')] ? { length: r[colIndex('length')] } : {}),
      }));

      return { records, ...(resumeKey ? { resumeKey } : {}) };
    });
  }

  /**
   * Fetch archived content for a snapshot URL and extract readable text. Reports the
   * capture Wayback served and the HTTP status it replayed that capture with. The replay's
   * redirects are followed by `followReplay`: the served capture differs from the requested
   * one when Wayback redirects a timestamp that is not itself a capture to the nearest one,
   * and when the capture requested is an archived redirect, which `redirects` then lists.
   *
   * The replay's `Content-Type` decides the read before any body byte is taken. An HTML
   * page, or a capture with no media type, is read from the replay itself and stripped to
   * its text. Any other text type — `text/*`, JSON, XML, JavaScript, a `+xml` or `+json`
   * type — has its replay body cancelled unread, because that form rewrites the URLs inside
   * it, and is read as stored from the capture's `id_` form in a second request with the
   * same retries, within what remains of the call's `deadline`. A body of any other type is
   * cancelled unread and throws `NotFound` with `mediaType`, `replayUrl`, and the archived
   * `redirects` passed, when there were any. The body read is streamed up to
   * `REPLAY_BYTE_CEILING` bytes — a longer body is cut there, the upstream read cancelled, and
   * `truncatedAtBytes` set — then decoded with the charset the response declares, or the one
   * Wayback guessed for the capture.
   *
   * With `options.links`, `links` lists an HTML page's links, read by `pageLinks` from the
   * same bytes, and so the same scan, as its text; a capture read as another text type has
   * none, `[]`. Without it no link is read and `links` is absent.
   *
   * A non-2xx carrying `Memento-Datetime` is an archived error page, not a Wayback failure:
   * it is not retried and throws `NotFound` with `status` and `captureTimestamp`. Any other
   * 4xx but a 404, 408, 425, or 429 is Wayback refusing the request — a 403 is its answer
   * for a site excluded from the archive — and throws `NotFound` with `status` alone,
   * after one request. Redirects that reach no readable capture throw `NotFound` with
   * `deadEnd` (see `followReplay`), after one attempt. Otherwise a 5xx, 408, 425, or network
   * error on any request of the chain is retried, the chain starting again, and a 429 or a
   * timeout answered after one attempt, each as `ServiceUnavailable` (a 429 with a hint to
   * wait), which `ia_get_snapshot` remaps onto its declared `content_fetch_failed`; so is the
   * call's `deadline` running out, mid-request, mid-backoff, or before a request, its message
   * naming the deadline. A 404 and a caller cancellation propagate as the fetch threw them.
   * No error carries the replay's body. The text is returned whole; `ia_get_snapshot` pages it.
   */
  async fetchContent(
    snapshotUrl: string,
    ctx: Context,
    deadline: CallDeadline,
    options: { links?: boolean } = {},
  ): Promise<SnapshotContent> {
    const served = await this.retry(REPLAY, ctx, deadline, async (limits) => {
      const { response, replayUrl, redirects } = await this.followReplay(
        snapshotUrl,
        ctx,
        deadline,
        limits,
      );
      const guessedCharset = response.headers.get('x-archive-guessed-charset');
      const capture = { replayUrl, status: String(response.status), guessedCharset, redirects };
      const mediaType = mediaTypeOf(response.headers.get('content-type'));
      const kind = bodyKind(mediaType);
      if (kind === 'html') {
        const linksOf = options.links ? replayUrl : undefined;
        return { ...capture, body: await readBody(response, 'html', guessedCharset, linksOf) };
      }
      await response.body?.cancel();
      if (kind === 'other') {
        throw notFound(`The capture at ${replayUrl} is ${mediaType}, not text.`, {
          mediaType,
          replayUrl,
          ...(redirects.length > 0 && { redirects }),
        });
      }
      return capture;
    });
    const body =
      'body' in served
        ? served.body
        : await this.readRawText(served.replayUrl, served.guessedCharset, ctx, deadline);

    return {
      text: body.text,
      replayUrl: served.replayUrl,
      timestamp: captureTimestamp(served.replayUrl),
      status: served.status,
      ...(served.redirects.length > 0 && { redirects: served.redirects }),
      ...(body.truncated && { truncatedAtBytes: REPLAY_BYTE_CEILING }),
      ...(options.links && { links: body.links ?? [] }),
    };
  }

  /** Build the Wayback replay URL for a resolved timestamp+url. */
  buildReplayUrl(timestamp: string, url: string): string {
    return `${WAYBACK_FETCH_BASE}/${timestamp}/${url}`;
  }

  /**
   * A text capture's body as stored, from the `id_` form of `replayUrl`, under the same
   * retries as the replay request and within what remains of the call's `deadline`. The
   * `id_` response carries no guessed charset, so the one Wayback sent with the replay stands
   * in for it. Its redirects are followed as the replay's are. The replay already served this
   * capture, so an `id_` 4xx — a refusal, a 404, or an archived error page — or redirects that
   * reach no readable capture say nothing about the capture: each is `ServiceUnavailable`
   * marked `retryable: false`, with a hint naming the replay URL, never the `NotFound`
   * `ia_get_snapshot` reads as no capture.
   */
  private readRawText(
    replayUrl: string,
    guessedCharset: string | null,
    ctx: Context,
    deadline: CallDeadline,
  ): Promise<ReplayBody> {
    const rawUrl = rawReplayUrl(replayUrl);
    return this.retry(REPLAY, ctx, deadline, async (limits) => {
      const { response } = await this.followReplay(rawUrl, ctx, deadline, limits).catch(
        (err: unknown) => {
          if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.NotFound) throw err;
          // A dead end's status is its chain's last answer, which a later hop may have given.
          throw serviceUnavailable(
            err.data?.deadEnd === undefined
              ? `The Wayback Machine replayed this capture but answered its unmodified form, ${rawUrl}, with HTTP ${err.data?.status ?? statusOf(err)}.`
              : `The Wayback Machine replayed this capture but the redirects of its unmodified form, ${rawUrl}, reached no readable capture.`,
            {
              retryable: false,
              recovery: {
                hint: `Wayback replayed this capture but refused its unmodified form, so a retry is unlikely to help; open ${replayUrl} to read the capture, or pick another one with ia_find_snapshots in history mode.`,
              },
            },
            { cause: err },
          );
        },
      );
      return readBody(response, 'text', guessedCharset);
    });
  }

  /**
   * The replay of `url` with its redirects followed here, not by the runtime's `fetch`, which
   * under Bun refuses a relative `Location` that embeds a scheme — the root-relative
   * `/web/<timestamp>/http://…` form Wayback writes for many archived redirects. Runs within
   * one retry attempt, so a retried attempt starts the chain again from `url`.
   *
   * Each 3xx's `Location` is resolved against the URL that answered it, and the next request
   * goes only to an http(s) URL on a `WAYBACK_HOSTS` host the chain has not requested, for at
   * most `MAX_REPLAY_REDIRECTS` redirects. Every URL the chain requests, compares, records, and
   * reports — `url` included — is the parsed form without its fragment, which is what a request
   * sends on either runtime. `first` limits the first request; each later one is sent only
   * while the call `deadline` has time left, with the request timeout or what remains,
   * whichever is less. A 3xx carrying `Memento-Datetime` replays a capture that is itself an
   * archived redirect, and is recorded in `redirects`; one without it is Wayback's own
   * redirect to the nearest capture.
   *
   * A chain that cannot reach a readable capture throws `NotFound`, which the retry loop does
   * not retry, carrying `deadEnd`, the archived `redirects` passed, and the last answer's
   * `status` — so does a 404, a refusal, or an archived error page after an archived
   * redirect, which concerns its target rather than the URL requested. Every other failure
   * propagates as `fetchUpstream` threw it.
   */
  private async followReplay(
    url: string,
    ctx: Context,
    deadline: CallDeadline,
    first: RequestLimits,
  ): Promise<ServedReplay> {
    const requested = new Set<string>();
    const redirects: ArchivedRedirect[] = [];
    let current = withoutFragment(new URL(url));
    let limits = first;
    for (let followed = 0; ; followed++) {
      requested.add(current);
      let redirect: ReplayRedirect;
      try {
        const response = await this.fetchUpstream(current, REPLAY, ctx, limits);
        return { response, replayUrl: waybackUrl(current) ?? current, redirects };
      } catch (err) {
        const answer = redirectOf(err);
        if (!answer) throw redirects.length > 0 ? targetFailure(err, redirects) : err;
        redirect = answer;
      }

      const { status, location, captureTimestamp } = redirect;
      const archived = captureTimestamp === undefined ? {} : { captureTimestamp };
      if (location === undefined) {
        throw deadEnd(status, redirects, { kind: 'no_location', status, ...archived });
      }
      const next = URL.parse(location, current);
      if (!next || !HTTP_PROTOCOLS.has(next.protocol) || !WAYBACK_HOSTS.has(next.hostname)) {
        const href = next?.href ?? location;
        throw deadEnd(status, redirects, {
          kind: 'bad_location',
          status,
          location: href,
          ...archived,
        });
      }
      const nextUrl = withoutFragment(next);
      if (captureTimestamp !== undefined) {
        const target = captureOf(nextUrl)?.original ?? nextUrl;
        redirects.push({ status, captureTimestamp, target });
      }
      if (requested.has(nextUrl)) {
        throw deadEnd(status, redirects, { kind: 'loop', url: nextUrl });
      }
      if (followed === MAX_REPLAY_REDIRECTS) {
        throw deadEnd(status, redirects, { kind: 'too_many_redirects' });
      }
      deadline.assertTimeLeft();
      limits = { signal: first.signal, timeoutMs: deadline.nextTimeoutMs() };
      current = nextUrl;
    }
  }

  /**
   * One attempt at the Availability API's closest capture, sent under `limits` — the retry
   * loop's signal, which the call deadline and the caller's cancellation abort, and the
   * request timeout or what remains of the deadline. Undefined when the API names no capture
   * on web.archive.org; the declared `availability_unavailable` failure, returned for the CDX
   * fallback to stand in for, when it answers with an `error` in place of a capture.
   */
  private async queryAvailability(
    { url, timestamp }: ClosestLookup,
    limits: RequestLimits,
    ctx: Context,
  ): Promise<ClosestSnapshot | McpError | undefined> {
    // Without a timestamp the API answers with the latest capture; a blank one draws HTTP 500.
    const params = new URLSearchParams({ url, ...(timestamp !== undefined && { timestamp }) });
    const response = await this.fetchUpstream(
      `${AVAILABILITY_BASE}?${params}`,
      AVAILABILITY_API,
      ctx,
      { ...limits, target: url },
    );
    const raw = (await readJson(response, AVAILABILITY_API, ctx)) as {
      archived_snapshots?: {
        closest?: { url?: string; timestamp?: string; status?: string; available?: boolean };
      };
      error?: unknown;
    } | null;

    // An empty archived_snapshots means no answer, and so does a URL off web.archive.org:
    // the service fetches only Wayback replay URLs.
    const closest = raw?.archived_snapshots?.closest;
    const snapshotUrl = closest?.url ? waybackUrl(closest.url) : undefined;
    if (snapshotUrl && closest?.timestamp) {
      return { snapshotUrl, timestamp: closest.timestamp, status: closest.status ?? '200' };
    }
    /**
     * An HTTP 200 whose body carries an `error` — the API's own lookup timing out, as
     * `{"code": "timeout"}` — is a failed answer, not an empty one. It is returned rather
     * than thrown, so the retry loop leaves it alone: a lookup the API could not finish in
     * its own time is what the CDX fallback's longer ceiling is for.
     */
    if (raw?.error == null) return;
    const code = isRecord(raw.error) ? raw.error.code : undefined;
    return serviceUnavailable(
      `${AVAILABILITY_API.name} answered with an error${code === 'timeout' ? ' (its own lookup timed out)' : ''} in place of a capture.`,
      declaredReason(AVAILABILITY_API, ctx),
    );
  }

  /**
   * The CDX fallback, after an empty Availability answer or a `failure`: one attempt, no
   * retries, under `CDX_FALLBACK_CEILING_MS`, the request timeout, or what remains of the
   * call deadline, whichever is least. With 1 ms or less remaining it sends nothing, since
   * the request could only time out — unless the caller has already left, when the fetch
   * fails at once as the cancellation it is. Any upstream failure or timeout becomes
   * `lookupFailed`'s declared failure, never a miss: a timeout, a network error, or a
   * redirect chain `fetchWithTimeout` refused to follow is first named by what CDX did
   * (`unansweredRequestError`), a timeout by the limit the attempt was sent under, while the
   * call deadline running out stays for `lookupFailed` to name. A URL the Wayback Machine
   * does not serve and a caller cancellation pass through untouched.
   */
  private async closestFromCdx(
    lookup: ClosestLookup,
    ctx: Context,
    failure?: McpError,
  ): Promise<ClosestSnapshot | undefined> {
    try {
      lookup.deadline.assertTimeLeft();
    } catch {
      throw this.lookupFailed(lookup, failure);
    }
    const timeoutMs = Math.min(CDX_FALLBACK_CEILING_MS, lookup.deadline.nextTimeoutMs());
    try {
      return await this.queryCdxClosest(lookup, timeoutMs, ctx);
    } catch (err) {
      if (
        !(err instanceof McpError) ||
        ctx.signal.aborted ||
        err.code === JsonRpcErrorCode.RequestCancelled ||
        err.data?.reason === 'no_snapshot_available'
      ) {
        throw err;
      }
      const answer = lookup.deadline.isExpiry(err)
        ? err
        : unansweredRequestError(err, CDX_API.name, timeoutMs, declaredReason(CDX_API, ctx));
      throw this.lookupFailed(lookup, failure, answer);
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
    { url, timestamp, deadline }: ClosestLookup,
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
    // The CDX check went unsent, was cut off by the call deadline, or failed on its own.
    const within = `within the ${deadline.budgetSeconds} s call deadline.`;
    const cutOff = fallbackErr !== undefined && deadline.isExpiry(fallbackErr);
    const afterFailure =
      fallbackErr === undefined
        ? `No time remained for the CDX closest-capture check ${within}`
        : cutOff
          ? `The CDX closest-capture check it fell back to did not finish ${within}`
          : `The CDX closest-capture check it fell back to did not complete either: ${fallbackErr.message}`;
    const afterEmpty =
      fallbackErr === undefined
        ? `no time remained for the CDX closest-capture check ${within}`
        : cutOff
          ? `the CDX closest-capture check did not finish ${within}`
          : `the CDX closest-capture check did not complete: ${fallbackErr.message}`;
    const message = failure
      ? `The closest-capture lookup for ${url}${near(timestamp)} did not complete: ${failure.message} ${afterFailure}`
      : `The Availability API found no capture of ${url}${near(timestamp)}, and ${afterEmpty}`;
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
   * call deadline expiring mid-request, mid-backoff, or before a request, which leaves the
   * fallback no time, or a timeout, a network error, or a refused redirect chain under the
   * declared reason (`transportError`). A refusal, a URL the Wayback Machine does not serve,
   * and a cancellation leave as thrown — a refusal that completed as the deadline ran out
   * included.
   */
  private availabilityError(
    err: unknown,
    { url, timestamp, deadline }: ClosestLookup,
    ctx: Context,
  ): unknown {
    const mapped = transportError(
      err,
      AVAILABILITY_API.name,
      deadline,
      declaredReason(AVAILABILITY_API, ctx),
    );
    if (!deadline.isExpiry(err) || mapped === (err as McpError).cause) return mapped;
    const { retryAttempts } = (err as McpError).data ?? {};
    return serviceUnavailable(
      `The closest-capture lookup for ${url}${near(timestamp)} did not finish within the ${deadline.budgetSeconds} s call deadline: the Availability API did not answer in time.`,
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
   * request on the caller's signal under `timeoutMs`, the fallback's limit. CDX reads a blank
   * `closest` as the latest capture.
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
      { signal: ctx.signal, timeoutMs },
    );

    const captures = rows.slice(1);
    const [captureTs, original, status = '-'] =
      captures.find((row) => row[2] === '200') ?? captures[0] ?? [];
    if (!captureTs || !original) return;

    return { snapshotUrl: this.buildReplayUrl(captureTs, original), timestamp: captureTs, status };
  }

  /**
   * Rows of a CDX JSON query, empty only when CDX listed none. Throws `cdx_unavailable` on a
   * 5xx, a 429, another 4xx, an HTML page, unparseable text, or JSON that is not a list of
   * rows of strings, and `no_snapshot_available` on a `NOT_SERVED` status.
   */
  private async queryCdx(
    params: URLSearchParams,
    ctx: Context,
    limits: RequestLimits,
  ): Promise<string[][]> {
    const response = await this.fetchUpstream(`${CDX_BASE}?${params}`, CDX_API, ctx, {
      ...limits,
      target: params.get('url') ?? '',
    });
    const rows = await readJson(response, CDX_API, ctx);
    if (
      !Array.isArray(rows) ||
      !rows.every(
        (row): row is string[] =>
          Array.isArray(row) && row.every((cell) => typeof cell === 'string'),
      )
    ) {
      throw serviceUnavailable(
        `${CDX_API.name} returned JSON that is not a list of rows.`,
        declaredReason(CDX_API, ctx),
      );
    }
    return rows;
  }

  /**
   * `fetchWithTimeout` with an upstream 5xx, 408, 425, or 429 rethrown as `api`'s declared
   * reason. It runs inside the caller's retry closure. A 5xx, 408, or 425 keeps the fields
   * the retry loop reads (`retryAfter`, `retryable`) and is retried like a 5xx, so the error
   * surfacing after the last attempt carries the reason and its recovery hint.
   * A 429 carries a hint to wait and is answered after one request by the retry predicate —
   * the upstream asked the client to slow down. A replay request is sent with
   * `redirect: 'manual'`, capturing `Memento-Datetime` and `Location` on a non-2xx: its 3xx
   * propagates untouched, for `followReplay` to follow, and a replay non-2xx carrying
   * `Memento-Datetime` is an archived error page, thrown as `NotFound`. Any other replay 4xx
   * except a 404 is `replayRefusal`; any other lookup 4xx is `lookupRefusal`, about the
   * looked-up `target` URL. Every other failure, timeouts and caller cancellation included,
   * propagates untouched. A `NOT_SERVED` status, a replay 404, and a replay redirect are
   * expected answers, so the fetch logs them at debug rather than error.
   */
  private async fetchUpstream(
    url: string,
    api: UpstreamApi,
    ctx: Context,
    { timeoutMs, signal, target = url }: RequestLimits & { target?: string },
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(url, timeoutMs, ctx, {
        headers: this.headers,
        signal,
        ...(api === REPLAY
          ? {
              redirect: 'manual' as const,
              expectedStatuses: [...NOT_SERVED, 404, ...REDIRECT_STATUSES],
              errorHeaders: [MEMENTO_DATETIME, 'location'],
            }
          : { expectedStatuses: [...NOT_SERVED] }),
      });
    } catch (err) {
      const status = statusOf(err);
      if (status === undefined || (api === REPLAY && REDIRECT_STATUSES.has(status))) throw err;
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
   * Run `fn` under `attempts`. A timeout, a network error once its retries are spent, a
   * redirect chain `fetchWithTimeout` refused to follow, or the call `deadline` running out
   * surfaces as `api`'s declared reason (`transportError`); everything else leaves as it was
   * thrown.
   */
  private retry<T>(
    api: UpstreamApi,
    ctx: Context,
    deadline: CallDeadline,
    fn: (limits: RequestLimits) => Promise<T>,
  ): Promise<T> {
    return this.attempts(ctx, deadline, fn).catch((err: unknown) => {
      throw transportError(err, api.name, deadline, declaredReason(api, ctx));
    });
  }

  /**
   * Run `fn` under the framework retry loop for what remains of the call's `deadline`, every
   * attempt, backoff, and honored `Retry-After` included. An attempt is sent only while more
   * than 1 ms remains, with the request timeout or what remains, whichever is less, and the
   * loop's signal, which the deadline and the caller's cancellation abort; the loop itself
   * takes only the caller's signal, so it tells the two apart. A timeout or a 429 is not
   * retried (`isRetriedFailure`). Failures leave as thrown. No `operation` label is passed:
   * `withRetry` copies it into an exhausted error's `data`, which reaches the caller.
   */
  private attempts<T>(
    ctx: Context,
    deadline: CallDeadline,
    fn: (limits: RequestLimits) => Promise<T>,
  ): Promise<T> {
    return withRetry(
      ({ signal }) => {
        deadline.assertTimeLeft();
        return fn({ signal, timeoutMs: deadline.nextTimeoutMs() });
      },
      {
        context: ctx,
        baseDelayMs: 1_000,
        signal: ctx.signal,
        deadlineMs: deadline.remainingMs(),
        isTransient: isRetriedFailure,
      },
    );
  }
}

/**
 * The failed Availability answer the CDX closest query stands in for: a 429, a 5xx, 408, or
 * 425 after its retries, or an HTML page or unparseable body — including one the call
 * deadline overtook before the retry loop could report it. Before `transportError` maps
 * them, the only other Availability failures declared `availability_unavailable` are 4xx
 * refusals; a timeout, a network error, a URL the Wayback Machine does not serve, and a
 * cancellation carry no such reason. Undefined for all of those, and once the caller left.
 */
function failedAnswer(
  err: unknown,
  { deadline }: ClosestLookup,
  ctx: Context,
): McpError | undefined {
  if (ctx.signal.aborted) return;
  const answer = deadline.isExpiry(err) ? (err as McpError).cause : err;
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
  const timestamp = mementoTimestamp(datetime);
  return notFound(
    `The capture at ${timestamp} is an archived HTTP ${status} page.`,
    { status, captureTimestamp: timestamp },
    { cause: err },
  );
}

/** The 14-digit timestamp a `Memento-Datetime` names, or the header as sent when it is not an HTTP date. */
function mementoTimestamp(datetime: string): string {
  const captured = Date.parse(datetime);
  return Number.isNaN(captured)
    ? datetime
    : new Date(captured).toISOString().replace(/\D/g, '').slice(0, 14);
}

/** The redirect a replay failure is, when `fetchUpstream` passed on a 3xx; undefined for any other failure. */
function redirectOf(err: unknown): ReplayRedirect | undefined {
  const status = statusOf(err);
  if (status === undefined || !REDIRECT_STATUSES.has(status)) return;
  const headers = (err as McpError).data?.headers as Record<string, string> | undefined;
  const datetime = headers?.[MEMENTO_DATETIME];
  return {
    status,
    location: headers?.location,
    captureTimestamp: datetime === undefined ? undefined : mementoTimestamp(datetime),
  };
}

/**
 * A replay chain that reached no readable capture, as a `NotFound` the retry loop does not
 * retry: the last answer's `status`, the archived `redirects` passed, and how it ended.
 */
function deadEnd(
  status: number,
  redirects: ArchivedRedirect[],
  end: RedirectDeadEnd,
  cause?: unknown,
): McpError {
  return notFound(
    `The replay's redirects reached no readable capture (${end.kind}).`,
    { status, redirects, deadEnd: end },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * A request for an archived redirect's target that failed as `NotFound` — Wayback has not
 * archived the target (a 404 with no `Memento-Datetime`), its capture is an archived error
 * page, or Wayback refused the replay — as the dead end it is. Any other failure is returned
 * as it is.
 */
function targetFailure(err: unknown, redirects: ArchivedRedirect[]): unknown {
  if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.NotFound) return err;
  const { status, captureTimestamp } = err.data ?? {};
  if (typeof status !== 'number') return err;
  const end: RedirectDeadEnd =
    typeof captureTimestamp === 'string'
      ? { kind: 'archived_error', status, captureTimestamp }
      : status === 404
        ? { kind: 'not_archived' }
        : { kind: 'refused', status };
  return deadEnd(status, redirects, end, err);
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

/** `url` as a request sends it: serialized without its fragment, `#` included. */
function withoutFragment(url: URL): string {
  const sent = new URL(url);
  sent.hash = '';
  return sent.href;
}

/**
 * An http(s) URL on a `WAYBACK_HOSTS` host in its `https://web.archive.org` form, the rest of
 * it kept as written; undefined for any other URL. Every replay URL the service reports or
 * builds on takes this form, so `captureTimestamp` and `rawReplayUrl` read it.
 */
function waybackUrl(url: string): string | undefined {
  const scheme = /^https?:\/\//i.exec(url)?.[0];
  if (!scheme) return;
  const slash = url.indexOf('/', scheme.length);
  if (slash < 0 || !WAYBACK_HOSTS.has(url.slice(scheme.length, slash).toLowerCase())) return;
  return `${WAYBACK_ORIGIN}${url.slice(slash)}`;
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

/**
 * The text of a replay body, whether the read stopped at `REPLAY_BYTE_CEILING`, and an HTML
 * page's links when they were asked for.
 */
interface ReplayBody {
  links?: PageLink[];
  text: string;
  truncated: boolean;
}

/**
 * A replay body streamed up to `REPLAY_BYTE_CEILING` and decoded with the charset its
 * response declares, else `guessedCharset`; an HTML body is then stripped to its text, and
 * given `linksOf`, the replay URL it was served from, its links are read with that text.
 */
async function readBody(
  response: Response,
  kind: 'html' | 'text',
  guessedCharset: string | null,
  linksOf?: string,
): Promise<ReplayBody> {
  const { bytes, truncated } = await readCapped(response, REPLAY_BYTE_CEILING).catch(
    (err: unknown) => {
      throw bodyReadError(err, REPLAY.name);
    },
  );
  const source = { contentType: response.headers.get('content-type'), guessedCharset, truncated };
  if (kind === 'text') return { text: decodeText(bytes, source), truncated };
  const html = decodeHtml(bytes, source);
  if (linksOf === undefined) return { text: htmlToText(html), truncated };
  const page = htmlToTextAndAnchors(html);
  return { text: page.text, truncated, links: pageLinks(page, linksOf) };
}

/**
 * The links of a page served from `replayUrl`: each anchor's target read by `hrefTarget`
 * against the page's base — the first `<base href>`, read the same way against the page's
 * own URL, or else that URL, the original `replayUrl` names. A target is kept when it is
 * http(s) and, its fragment dropped, is not the page's own URL. Each target is listed once,
 * at its first anchor, with the first non-empty text among its anchors.
 */
function pageLinks({ anchors, baseHref }: AnchoredText, replayUrl: string): PageLink[] {
  const original = captureOf(replayUrl)?.original;
  const page = original === undefined ? undefined : (URL.parse(original) ?? undefined);
  const base = (baseHref !== undefined && hrefTarget(baseHref, page)) || page;
  const self = page && withoutFragment(page);
  const links = new Map<string, PageLink>();
  for (const { href, offset, text } of anchors) {
    const target = hrefTarget(href, base);
    if (!target || !HTTP_PROTOCOLS.has(target.protocol)) continue;
    const url = withoutFragment(target);
    const listed = links.get(url);
    if (listed) {
      if (listed.text === '') listed.text = text;
    } else if (url !== self) {
      links.set(url, { offset, text, url });
    }
  }
  return [...links.values()];
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
