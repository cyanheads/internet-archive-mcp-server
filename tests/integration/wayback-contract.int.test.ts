/**
 * @fileoverview Tool-contract integration coverage for ia_find_snapshots and
 * ia_get_snapshot — both tools run against the real WaybackService, the real
 * fetchWithTimeout, and the real retry loop, with only the upstream HTTP boundary
 * stubbed. Covers closest resolution (Availability, then CDX), the capture Wayback
 * actually served, charset and text extraction, routing by the replay's media type,
 * snapshot paging, upstream 5xx, timeout, and network-error reasons, the one deadline
 * each call runs under, archived error captures, and caller cancellation, on both the
 * structuredContent and content[] surfaces.
 * @module tests/integration/wayback-contract.int.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  type FetchMockResponder,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { iaFindSnapshots } from '@/mcp-server/tools/definitions/ia-find-snapshots.tool.js';
import { iaGetSnapshot } from '@/mcp-server/tools/definitions/ia-get-snapshot.tool.js';
import { initWaybackService } from '@/services/wayback/wayback-service.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Unmatched requests throw — no test in this file reaches the network. */
const http = createFetchMock();

const isAvailability = (r: Request) => r.url.startsWith('https://archive.org/wayback/available?');
const isCdx = (r: Request) => r.url.startsWith('https://web.archive.org/cdx/search/cdx?');
const isReplay = (r: Request) => r.url.startsWith('https://web.archive.org/web/');

const routeAvailability = (respond: FetchMockResponder) =>
  http.route({ match: isAvailability, respond });
const routeCdx = (respond: FetchMockResponder) => http.route({ match: isCdx, respond });
const routeReplay = (respond: FetchMockResponder) => http.route({ match: isReplay, respond });

const EMPTY_AVAILABILITY = () => Response.json({ archived_snapshots: {} });
const cdxRows =
  (...rows: [string, string, string][]) =>
  () =>
    Response.json([['timestamp', 'original', 'statuscode'], ...rows]);

/** A capture replayed as a page: `body`, served as HTML unless `headers` say otherwise. */
const replay =
  (body: BodyInit, headers: Record<string, string> = {}) =>
  () =>
    new Response(body, { headers: { 'content-type': 'text/html', ...headers } });

/** Wayback's own redirect to the nearest capture: a 302 with `x-archive-redirect-reason` and no Memento-Datetime. */
const nearestCapture = (location: string) => () =>
  new Response(null, {
    status: 302,
    headers: { location, 'x-archive-redirect-reason': 'found capture at 20200101000000' },
  });

/** The replay of a capture that is itself an archived redirect: the site's status, its Memento-Datetime, and its Location. */
const archivedRedirect = (status: number, mementoDatetime: string, location: string) => () =>
  new Response(null, { status, headers: { location, 'memento-datetime': mementoDatetime } });

/** What a failed or timed-out CDX fallback says on both surfaces, whichever tool asked. */
const FALLBACK_MESSAGE = /Availability API found no capture.*CDX .*did not complete/;
const FALLBACK_HINT = 'history mode';

/** What a lookup says when the Availability API failed and its CDX fallback did not answer either. */
const LOOKUP_FAILED_MESSAGE =
  /^The closest-capture lookup for \S+ near \d+ did not complete: Availability API .+ The CDX closest-capture check it fell back to did not complete either: /;

/** The route a lookup that could not answer names: history mode, then the exact-timestamp read. */
const NO_LOOKUP_ROUTE =
  /history mode, passing from and to around the timestamp, then read one with ia_get_snapshot and its exact 14-digit timestamp/;

/** A responder that answers with `respond()` after `ms`, unless the request's signal aborts first. */
const answerAfter =
  (ms: number, respond: () => Response): FetchMockResponder =>
  (request) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(respond()), ms);
      request.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(request.signal.reason);
      });
    });

const UNAVAILABLE = () => new Response('Service Unavailable', { status: 503 });

/** A 429 exactly as archive.org sent it (no Retry-After). */
const RATE_LIMITED = () =>
  new Response('<html><body><h1>429 Too Many Requests</h1></body></html>', { status: 429 });

/** A responder that never answers until the request's signal aborts. */
const hang: FetchMockResponder = (request) =>
  new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason));
  });

/** The type a body arrives as: JSON from the lookup APIs, an HTML page from a replay. */
const bodyType = (request: Request) => ({
  'content-type': isReplay(request) ? 'text/html' : 'application/json',
});

/** Headers arrive with `head` as the first body bytes; the rest never comes until the request's signal aborts. */
const stall =
  (head: string): FetchMockResponder =>
  (request) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(head));
          request.signal.addEventListener('abort', () => controller.error(request.signal.reason));
        },
      }),
      { headers: bodyType(request) },
    );

/** A refused connection, as the runtime's `fetch` rejects with it. */
const refused: FetchMockResponder = () =>
  Promise.reject(
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
        code: 'ECONNREFUSED',
      }),
    }),
  );

/** Headers and `head` arrive, then the connection drops, as undici rejects the body read. */
const dropped =
  (head: string): FetchMockResponder =>
  (request) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(head));
          queueMicrotask(() => controller.error(new TypeError('terminated')));
        },
      }),
      { headers: bodyType(request) },
    );

/** A replay of an archived error page: the capture's own status, with its Memento-Datetime. */
const archivedError = (status: number, mementoDatetime: string) => () =>
  new Response('<html><body>archived error page</body></html>', {
    status,
    headers: { 'content-type': 'text/html', 'memento-datetime': mementoDatetime },
  });

const calls = (match: (r: Request) => boolean) => http.calls.filter((c) => match(c.request));

/** The replay URLs requested, in order. */
const replayUrls = () => calls(isReplay).map((c) => c.request.url);

/** Answers any replay URL no exact route names, so an extra hop shows in the request count. */
const routeUnrouted = () => routeReplay(() => new Response('unrouted', { status: 400 }));

const contentText = (result: ToolResult): string =>
  result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

const hint = (
  errors: readonly { reason: string; recovery: string }[] | undefined,
  reason: string,
) => {
  const entry = errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`contract declares no ${reason}`);
  return entry.recovery;
};

/** Runs a tool under fake timers so the real retry loop's backoff elapses instantly. */
const runWithRetries = async (run: () => Promise<ToolResult>): Promise<ToolResult> => {
  vi.useFakeTimers();
  const pending = run();
  await vi.runAllTimersAsync();
  return pending;
};

beforeAll(() => {
  initWaybackService({ mcpServerVersion: '0.0.0-test' } as AppConfig, createInMemoryStorage());
  http.install();
});

afterAll(() => {
  http.restore();
});

beforeEach(() => {
  http.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ia_find_snapshots closest mode', () => {
  const closest = { url: 'nasa.gov', mode: 'closest', timestamp: '20200101' } as const;

  it('returns the Availability capture as an https replay URL without querying CDX', async () => {
    routeAvailability(() =>
      Response.json({
        archived_snapshots: {
          closest: {
            url: 'http://web.archive.org/web/20200101004937/https://www.nasa.gov/',
            timestamp: '20200101004937',
            status: '200',
            available: true,
          },
        },
      }),
    );

    const result = await runToolContract(iaFindSnapshots, closest);

    const replayUrl = 'https://web.archive.org/web/20200101004937/https://www.nasa.gov/';
    expect(result.structuredContent).toMatchObject({
      snapshots: [{ timestamp: '20200101004937', replay_url: replayUrl, statuscode: '200' }],
    });
    expect(contentText(result)).toContain(`**Replay URL:** [${replayUrl}](<${replayUrl}>)`);
    expect(calls(isCdx)).toHaveLength(0);
  });

  it('falls back to CDX when the Availability API answers empty', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(
      cdxRows(
        ['20200101231916', 'https://www.nasa.gov/', '200'],
        ['20200101230622', 'http://nasa.gov/', '301'],
      ),
    );

    const result = await runToolContract(iaFindSnapshots, closest);

    const replayUrl = 'https://web.archive.org/web/20200101231916/https://www.nasa.gov/';
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      snapshots: [{ timestamp: '20200101231916', replay_url: replayUrl, statuscode: '200' }],
    });
    const text = contentText(result);
    expect(text).toContain('## 20200101231916');
    expect(text).toContain(`**Replay URL:** [${replayUrl}](<${replayUrl}>)`);
    expect(text).toContain('**Status:** 200');
    expect(calls(isAvailability)).toHaveLength(1);
    const cdx = new URL(calls(isCdx)[0]?.request.url ?? '');
    expect(cdx.searchParams.get('closest')).toBe('20200101');
    expect(cdx.searchParams.get('sort')).toBe('closest');
  });

  it('reports no_snapshot_available on both surfaces only when both sources are empty', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(cdxRows());

    const result = await runToolContract(iaFindSnapshots, closest);

    const recovery = hint(iaFindSnapshots.errors, 'no_snapshot_available');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_snapshot_available', recovery: { hint: recovery } },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${recovery}`);
    expect(calls(isCdx)).toHaveLength(1);
  });

  it('returns the CDX capture after retrying an Availability 503, on both surfaces', async () => {
    routeAvailability(UNAVAILABLE);
    routeCdx(cdxRows(['20200101231916', 'https://www.nasa.gov/', '200']));

    const result = await runWithRetries(() => runToolContract(iaFindSnapshots, closest));

    const replayUrl = 'https://web.archive.org/web/20200101231916/https://www.nasa.gov/';
    expect(result.structuredContent).toMatchObject({
      snapshots: [{ timestamp: '20200101231916', replay_url: replayUrl, statuscode: '200' }],
    });
    expect(contentText(result)).toContain(`**Replay URL:** [${replayUrl}](<${replayUrl}>)`);
    expect(calls(isAvailability)).toHaveLength(4);
    expect(calls(isCdx)).toHaveLength(1);
    expect(new URL(calls(isCdx)[0]?.request.url ?? '').searchParams.get('closest')).toBe(
      '20200101',
    );
  });

  it('surfaces availability_unavailable naming the lookup when the fallback after four 503s fails too', async () => {
    routeAvailability(UNAVAILABLE);
    routeCdx(() => new Response('Temporarily Offline', { status: 503 }));

    const result = await runWithRetries(() => runToolContract(iaFindSnapshots, closest));

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(LOOKUP_FAILED_MESSAGE),
        data: {
          reason: 'availability_unavailable',
          status: 503,
          retryAttempts: 4,
          recovery: { hint: expect.stringMatching(NO_LOOKUP_ROUTE) },
        },
      },
    });
    const text = contentText(result);
    expect(text).toMatch(/closest-capture lookup for nasa\.gov near 20200101 did not complete/);
    expect(text).toMatch(new RegExp(`Recovery: Retry later, or .*${NO_LOOKUP_ROUTE.source}`));
    expect(text).not.toMatch(/found no capture/);
    expect(calls(isAvailability)).toHaveLength(4);
    expect(calls(isCdx)).toHaveLength(1);
  });

  it('surfaces cdx_unavailable after one fallback CDX 503, not four', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(() => new Response('Temporarily Offline', { status: 503 }));

    const result = await runWithRetries(() => runToolContract(iaFindSnapshots, closest));

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(FALLBACK_MESSAGE),
        data: {
          reason: 'cdx_unavailable',
          recovery: { hint: expect.stringContaining(FALLBACK_HINT) },
        },
      },
    });
    expect(calls(isAvailability)).toHaveLength(1);
    expect(calls(isCdx)).toHaveLength(1);
  });

  it('surfaces cdx_unavailable when the CDX fallback outlasts its 25 s ceiling', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(hang);
    vi.useFakeTimers();

    const pending = runToolContract(iaFindSnapshots, closest);
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await pending;

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(FALLBACK_MESSAGE),
        data: {
          reason: 'cdx_unavailable',
          recovery: { hint: expect.stringContaining(FALLBACK_HINT) },
        },
      },
    });
    expect(contentText(result)).toMatch(/Recovery: .*history mode/);
    expect(calls(isCdx)).toHaveLength(1);
  });

  it('resolves through CDX after one Availability 429', async () => {
    routeAvailability(RATE_LIMITED);
    routeCdx(cdxRows(['20200101231916', 'https://www.nasa.gov/', '200']));

    const result = await runWithRetries(() => runToolContract(iaFindSnapshots, closest));

    expect(result.structuredContent).toMatchObject({
      snapshots: [{ timestamp: '20200101231916', statuscode: '200' }],
    });
    expect(contentText(result)).toContain('## 20200101231916');
    expect(calls(isAvailability)).toHaveLength(1);
    expect(calls(isCdx)).toHaveLength(1);
  });

  it('answers an Availability 429 whose CDX fallback is empty as no_snapshot_available', async () => {
    routeAvailability(RATE_LIMITED);
    routeCdx(cdxRows());

    const result = await runWithRetries(() => runToolContract(iaFindSnapshots, closest));

    const recovery = hint(iaFindSnapshots.errors, 'no_snapshot_available');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_snapshot_available', recovery: { hint: recovery } },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${recovery}`);
  });

  it('answers an Availability 429 whose fallback fails with a wait hint, after one request each', async () => {
    routeAvailability(RATE_LIMITED);
    routeCdx(() => new Response('Temporarily Offline', { status: 503 }));

    const result = await runWithRetries(() => runToolContract(iaFindSnapshots, closest));

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(LOOKUP_FAILED_MESSAGE),
        data: {
          reason: 'availability_unavailable',
          status: 429,
          recovery: {
            hint: expect.stringMatching(/rate-limiting.*wait several minutes, then list/),
          },
        },
      },
    });
    expect((result.structuredContent as { error: { data: object } }).error.data).not.toHaveProperty(
      'retryable',
    );
    expect(contentText(result)).not.toContain('not retryable');
    expect(calls(isAvailability)).toHaveLength(1);
    expect(calls(isCdx)).toHaveLength(1);
  });

  it('answers a CDX fallback 429 after one request with the wait-then-history-mode hint', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(() => new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } }));

    const result = await runWithRetries(() => runToolContract(iaFindSnapshots, closest));

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(FALLBACK_MESSAGE),
        data: {
          reason: 'cdx_unavailable',
          retryAfter: '60',
          recovery: { hint: expect.stringMatching(/rate-limiting.*wait 60 seconds.*history mode/) },
        },
      },
    });
    expect(contentText(result)).not.toContain('not retryable');
    expect(calls(isAvailability)).toHaveLength(1);
    expect(calls(isCdx)).toHaveLength(1);
  });

  it('never reports an Availability HTML page as a ValidationError, falling back once', async () => {
    routeAvailability(() => new Response('<html><body>Temporarily Offline</body></html>'));
    routeCdx(() => new Response('Temporarily Offline', { status: 503 }));

    const result = await runWithRetries(() => runToolContract(iaFindSnapshots, closest));

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(LOOKUP_FAILED_MESSAGE),
        data: { reason: 'availability_unavailable' },
      },
    });
    expect(calls(isAvailability)).toHaveLength(4);
    expect(calls(isCdx)).toHaveLength(1);
  });

  it('keeps a caller cancellation during the Availability call a cancellation, with no fallback', async () => {
    routeAvailability(hang);
    const controller = new AbortController();

    const pending = runToolContract(iaFindSnapshots, closest, {
      context: { signal: controller.signal },
    });
    await vi.waitFor(() => expect(calls(isAvailability)).toHaveLength(1));
    controller.abort();
    const result = await pending;

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(
      (result.structuredContent as { error: { data?: { reason?: string } } }).error.data?.reason,
    ).toBeUndefined();
    expect(calls(isCdx)).toHaveLength(0);
  });

  it('keeps a caller cancellation during the CDX fallback a cancellation, not a miss', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(hang);
    const controller = new AbortController();

    const pending = runToolContract(iaFindSnapshots, closest, {
      context: { signal: controller.signal },
    });
    await vi.waitFor(() => expect(calls(isCdx)).toHaveLength(1));
    controller.abort();
    const result = await pending;

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(calls(isCdx)).toHaveLength(1);
  });

  describe('under the 55 s call deadline (#53, #55)', () => {
    /** Runs the lookup under fake timers to completion, reporting the fake time it took. */
    const runTimed = async () => {
      vi.useFakeTimers();
      const start = Date.now();
      const pending = runToolContract(iaFindSnapshots, closest);
      await vi.runAllTimersAsync();
      const result = await pending;
      return { result, elapsedMs: Date.now() - start };
    };

    it('ends at 55 s when each Availability attempt answers 503 just inside the request timeout, never reaching CDX', async () => {
      routeAvailability(answerAfter(29_900, UNAVAILABLE));
      routeCdx(hang);

      const { result, elapsedMs } = await runTimed();

      expect(elapsedMs).toBe(55_000);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message:
            'The closest-capture lookup for nasa.gov near 20200101 did not finish within the 55 s call deadline: the Availability API did not answer in time.',
          data: {
            reason: 'availability_unavailable',
            retryAttempts: 2,
            recovery: { hint: expect.stringMatching(NO_LOOKUP_ROUTE) },
          },
        },
      });
      expect(contentText(result)).toMatch(/did not finish within the 55 s call deadline/);
      expect(calls(isAvailability)).toHaveLength(2);
      expect(calls(isCdx)).toHaveLength(0);
    });

    it('gives the CDX attempt only what remains after four 503s, so it ends at the deadline too', async () => {
      // Backoff without jitter: 1 s, 2 s, then 4 s, so the fourth 503 lands at 51 s.
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        routeAvailability(answerAfter(11_000, UNAVAILABLE));
        routeCdx(hang);

        const { result, elapsedMs } = await runTimed();

        expect(elapsedMs).toBe(55_000);
        const message =
          'The closest-capture lookup for nasa.gov near 20200101 did not complete: Availability API returned HTTP 503. (failed after 4 attempts) The CDX closest-capture check it fell back to did not finish within the 55 s call deadline.';
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ServiceUnavailable,
            message,
            data: { reason: 'availability_unavailable', status: 503, retryAttempts: 4 },
          },
        });
        expect(contentText(result)).toContain(`Error: ${message}`);
        expect(calls(isAvailability)).toHaveLength(4);
        expect(calls(isCdx)).toHaveLength(1);
      } finally {
        random.mockRestore();
      }
    });

    it('fails as cdx_unavailable naming the deadline when the CDX check after a late empty answer runs out of it', async () => {
      // A 503 at 29.9 s, then an empty answer at about 40 s: the CDX check gets the ~15 s left.
      http.route({ match: isAvailability, once: true, respond: answerAfter(29_900, UNAVAILABLE) });
      routeAvailability(answerAfter(9_100, EMPTY_AVAILABILITY));
      routeCdx(hang);

      const { result, elapsedMs } = await runTimed();

      expect(elapsedMs).toBe(55_000);
      const message =
        'The Availability API found no capture of nasa.gov near 20200101, and the CDX closest-capture check did not finish within the 55 s call deadline.';
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message,
          data: {
            reason: 'cdx_unavailable',
            recovery: { hint: expect.stringMatching(/^Retry later, or list nearby captures/) },
          },
        },
      });
      expect(contentText(result)).toContain(`Error: ${message}`);
      expect(calls(isAvailability)).toHaveLength(2);
      expect(calls(isCdx)).toHaveLength(1);
    });

    it('keeps the 25 s CDX ceiling after a fast 429', async () => {
      routeAvailability(RATE_LIMITED);
      routeCdx(hang);

      const { result, elapsedMs } = await runTimed();

      expect(elapsedMs).toBe(25_000);
      expect(result.structuredContent).toMatchObject({
        error: {
          message: expect.stringMatching(LOOKUP_FAILED_MESSAGE),
          data: { reason: 'availability_unavailable', status: 429 },
        },
      });
    });
  });
});

describe('ia_find_snapshots history mode', () => {
  it('surfaces cdx_unavailable with its hint after retrying a CDX 503', async () => {
    routeCdx(() => new Response('Temporarily Offline', { status: 503 }));

    const result = await runWithRetries(() =>
      runToolContract(iaFindSnapshots, { url: 'example.com', mode: 'history' }),
    );

    const recovery = hint(iaFindSnapshots.errors, 'cdx_unavailable');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'cdx_unavailable', retryAttempts: 4, recovery: { hint: recovery } },
      },
    });
    expect((result.structuredContent as { error: { data: object } }).error.data).not.toHaveProperty(
      'operation',
    );
    expect(contentText(result)).toContain(`Recovery: ${recovery}`);
    expect(calls(isCdx)).toHaveLength(4);
  });
});

describe('ia_find_snapshots history-mode limit above the 10,000 cap', () => {
  const RESUME_KEY = 'com%2Cexample%29%2F+20150612000000';

  /** A CDX history answer of `limit` captures, as CDX sends it, with a resume key when more remain. */
  const cdxHistory = (total: number) => (request: Request) => {
    const limit = Number(new URL(request.url).searchParams.get('limit'));
    const n = Math.min(limit, total);
    const rows = Array.from({ length: n }, (_, i) => [
      `2015${String(i).padStart(10, '0')}`,
      '200',
      'text/html',
      'http://example.com/',
      `DIGEST${i}`,
      '1256',
    ]);
    return Response.json([
      ['timestamp', 'statuscode', 'mimetype', 'original', 'digest', 'length'],
      ...rows,
      ...(n < total ? [[], [RESUME_KEY]] : []),
    ]);
  };

  const sentLimits = () =>
    calls(isCdx).map((c) => new URL(c.request.url).searchParams.get('limit'));

  type History = {
    snapshots: { timestamp: string }[];
    resume_key?: string;
    truncated?: boolean;
    shown?: number;
    cap?: number;
    notice?: string;
  };
  const historyOf = (result: ToolResult) => result.structuredContent as History;

  const history = (input: Record<string, unknown>) =>
    runToolContract(iaFindSnapshots, {
      url: 'example.com',
      mode: 'history',
      from: '2015',
      to: '2016',
      ...input,
    });

  it('sends limit 20000 to CDX as 10000 and discloses the cap with the resume_key', async () => {
    routeCdx(cdxHistory(25_000));

    const result = await history({ limit: 20_000 });

    expect(result.isError).toBeFalsy();
    expect(sentLimits()).toEqual(['10001']);
    const out = historyOf(result);
    expect(out.snapshots).toHaveLength(10_000);
    expect(out).toMatchObject({
      resume_key: expect.stringMatching(/^ia-history-v1\//),
      truncated: true,
      shown: 10_000,
      cap: 10_000,
    });
    expect(out.notice).toContain('limit 20000 is above the cap of 10,000 per call');
    expect(out.notice).toContain('resume_key');
    const text = contentText(result);
    expect(text).toContain('limit 20000 is above the cap of 10,000 per call');
    expect(text).toContain(`**Resume Key:** ${out.resume_key}`);
  });

  it('returns the same captures and resume_key as limit 10000', async () => {
    routeCdx(cdxHistory(25_000));

    const capped = historyOf(await history({ limit: 20_000 }));
    const atCap = historyOf(await history({ limit: 10_000 }));

    expect(sentLimits()).toEqual(['10001', '10001']);
    expect(capped.snapshots).toEqual(atCap.snapshots);
    expect(capped.resume_key).toMatch(/^ia-history-v1\//);
    expect(atCap.resume_key).toMatch(/^ia-history-v1\//);
    expect(atCap).toMatchObject({ truncated: true, cap: 10_000 });
    expect(atCap.notice).toContain('resume_key');
    expect(atCap.notice).not.toContain('above the cap');
  });

  it('serves the 150,000 ceiling at 10,000', async () => {
    routeCdx(cdxHistory(25_000));

    const result = await history({ limit: 150_000 });

    expect(sentLimits()).toEqual(['10001']);
    expect(historyOf(result)).toMatchObject({ truncated: true, shown: 10_000, cap: 10_000 });
  });

  it('sets no truncation or notice when the clamp withheld nothing', async () => {
    routeCdx(cdxHistory(42));

    const result = await history({ limit: 20_000 });

    expect(sentLimits()).toEqual(['10001']);
    const out = historyOf(result);
    expect(out.snapshots).toHaveLength(42);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('notice');
    expect(out).not.toHaveProperty('resume_key');
  });

  it('names resume_key when the default limit of 100 is reached', async () => {
    routeCdx(cdxHistory(250));

    const result = await history({});

    expect(sentLimits()).toEqual(['101']);
    const out = historyOf(result);
    expect(out).toMatchObject({
      truncated: true,
      shown: 100,
      cap: 100,
      resume_key: expect.stringMatching(/^ia-history-v1\//),
    });
    expect(out.notice).toContain('resume_key');
    expect(contentText(result)).toContain('resume_key');
  });

  it.each([
    ['above the 150,000 ceiling', 150_001, 'limit: Too big: expected number to be <=150000'],
    ['zero', 0, 'limit: Too small: expected number to be >=1'],
    ['a non-integer', 2.5, 'limit: Invalid input: expected int'],
  ])('rejects limit %s at the schema, with no request', async (_label, limit, named) => {
    routeCdx(cdxHistory(25_000));

    const result = await history({ limit });

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(contentText(result)).toContain(named);
    expect(http.calls).toHaveLength(0);
  });

  it('closest mode ignores an over-cap limit and answers as it does without one', async () => {
    routeAvailability(() =>
      Response.json({
        archived_snapshots: {
          closest: {
            url: 'http://web.archive.org/web/20200104000551/https://example.com/',
            timestamp: '20200104000551',
            status: '200',
            available: true,
          },
        },
      }),
    );
    const closest = { url: 'example.com', mode: 'closest', timestamp: '20200101' } as const;

    const withLimit = await runToolContract(iaFindSnapshots, { ...closest, limit: 20_000 });
    const without = await runToolContract(iaFindSnapshots, closest);

    expect(withLimit.isError).toBeFalsy();
    expect(withLimit.structuredContent).toEqual(without.structuredContent);
    expect(calls(isCdx)).toHaveLength(0);
  });
});

describe('ia_find_snapshots collapsed cursor contract', () => {
  const header = ['timestamp', 'statuscode', 'mimetype', 'original', 'digest', 'length'];
  const rows = [
    '19991231000000',
    '20000101000000',
    '20000201000000',
    '20000301000000',
    '20010101000000',
  ].map((timestamp, i) => [
    timestamp,
    '200',
    'text/html',
    'http://example.com/',
    `D${i}`,
    String(i),
  ]);
  type History = {
    snapshots: { timestamp: string; digest: string }[];
    resume_key?: string;
    notice?: string;
  };
  const out = (result: ToolResult) => result.structuredContent as History;

  it('does not claim truncation when lookahead proves a final page exactly fills the limit', async () => {
    routeCdx(() => Response.json([header, rows[0]]));
    const result = await runToolContract(iaFindSnapshots, {
      url: 'example.com',
      mode: 'history',
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(out(result).snapshots).toHaveLength(1);
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('captures past it');
  });

  it('answers a previously valid cursor that reaches an empty index range with an empty list', async () => {
    const shared = createMockContext();
    const definition = {
      ...iaFindSnapshots,
      handler: (
        input: Parameters<typeof iaFindSnapshots.handler>[0],
        ctx: Parameters<typeof iaFindSnapshots.handler>[1],
      ) => iaFindSnapshots.handler(input, { ...ctx, state: shared.state }),
    };
    let empty = false;
    routeCdx(() => Response.json(empty ? [header] : [header, ...rows.slice(0, 2)]));
    const first = await runToolContract(definition, {
      url: 'example.com',
      mode: 'history',
      limit: 1,
    });
    empty = true;
    const result = await runToolContract(definition, {
      url: 'example.com',
      mode: 'history',
      resume_key: out(first).resume_key,
    });
    const notice = 'No captures remain past this resume_key.';
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ snapshots: [], notice });
    expect(result.content).toEqual([
      { type: 'text', text: '**0 snapshots**\n' },
      { type: 'text', text: `\n\n> ${notice}` },
    ]);
    expect(calls(isCdx)).toHaveLength(2);
  });

  it('walks three pages without loss, inherits filters and allows a different page size on both surfaces', async () => {
    const shared = createMockContext();
    const definition = {
      ...iaFindSnapshots,
      handler: (
        input: Parameters<typeof iaFindSnapshots.handler>[0],
        ctx: Parameters<typeof iaFindSnapshots.handler>[1],
      ) => iaFindSnapshots.handler(input, { ...ctx, state: shared.state }),
    };
    routeCdx((request) => {
      const qp = new URL(request.url).searchParams;
      const from = qp.get('from') ?? '';
      const selected = rows.filter((row) => row[0]! >= from);
      const limit = Number(qp.get('limit'));
      return Response.json([
        header,
        ...selected.slice(0, limit),
        ...(selected.length > limit ? [[], ['RAW_SKIPS_BOUNDARY']] : []),
      ]);
    });
    const base = { url: 'example.com', mode: 'history' };
    const first = await runToolContract(definition, {
      ...base,
      collapse: 'timestamp:6',
      from: '1999',
      to: '2002',
      status_filter: '200',
      limit: 2,
    });
    const second = await runToolContract(definition, {
      ...base,
      resume_key: out(first).resume_key,
      limit: 1,
    });
    const third = await runToolContract(definition, {
      ...base,
      resume_key: out(second).resume_key,
      limit: 10,
    });
    expect([first, second, third].every((r) => !r.isError)).toBe(true);
    expect(
      [...out(first).snapshots, ...out(second).snapshots, ...out(third).snapshots].map((r) => [
        r.timestamp,
        r.digest,
      ]),
    ).toEqual(rows.map((r) => [r[0], r[4]]));
    expect(out(third).resume_key).toBeUndefined();
    for (const result of [first, second, third])
      for (const row of out(result).snapshots) {
        expect(contentText(result)).toContain(row.timestamp);
        expect(contentText(result)).toContain(row.digest);
      }
    expect(contentText(first)).toContain(out(first).resume_key);
    const paging = calls(isCdx).map((c) => Object.fromEntries(new URL(c.request.url).searchParams));
    expect(paging[1]).toMatchObject({
      from: '20000201000000',
      to: '2002',
      filter: 'statuscode:200',
      collapse: 'timestamp:6',
      limit: '2',
    });
    expect(paging[2]).toMatchObject({
      from: '20000301000000',
      collapse: 'timestamp:6',
      limit: '11',
    });
    expect(paging.every((p) => !Object.hasOwn(p, 'resumeKey'))).toBe(true);
    const conflict = await runToolContract(definition, {
      ...base,
      resume_key: out(first).resume_key,
      collapse: 'timestamp:8',
    });
    expect(conflict.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'resume_key_conflict' } },
    });
    expect(contentText(conflict)).toContain('Recovery:');
    expect(contentText(conflict)).toContain('omit collapse');
    expect(calls(isCdx)).toHaveLength(3);
  });

  it.each(['ia-history-v1/not-a-uuid', 'ia-history-v1/00000000-0000-4000-8000-000000000000'])(
    'rejects invalid server cursor %s without HTTP',
    async (resume_key) => {
      http.route({ match: () => true, respond: () => Response.json([header, rows[0]]) });
      const result = await runToolContract(iaFindSnapshots, {
        url: 'example.com',
        mode: 'history',
        resume_key,
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_resume_key' } },
      });
      expect(contentText(result)).toContain('one hour');
      expect(contentText(result)).toContain('Restart history mode');
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each([{ page: [] }, { page: [rows[0]] }])(
    'keeps omission notice on a final or empty raw continuation',
    async ({ page }) => {
      routeCdx(() => Response.json([header, ...page]));
      const result = await runToolContract(iaFindSnapshots, {
        url: 'example.com/*',
        mode: 'history',
        resume_key: 'RAW',
        limit: 10,
      });
      expect(result.isError).toBeFalsy();
      expect(contentText(result)).toContain('can omit the row at each page boundary');
      expect(JSON.stringify(result.structuredContent)).toContain(
        'can omit the row at each page boundary',
      );
      expect(new URL(calls(isCdx)[0]!.request.url).searchParams.get('resumeKey')).toBe('RAW');
    },
  );

  it('answers a CDX key whose next page is empty with the continuation notice, then the omission notice', async () => {
    let empty = false;
    routeCdx(() => Response.json(empty ? [] : [header, rows[0]]));
    const continuation = { url: 'example.com/*', mode: 'history', resume_key: 'RAW', limit: 10 };
    // The final non-empty page carries the omission notice alone.
    const omission = out(await runToolContract(iaFindSnapshots, continuation)).notice;
    expect(omission).toContain('can omit the row at each page boundary');
    empty = true;

    const result = await runToolContract(iaFindSnapshots, continuation);

    const notice = `No captures remain past this resume_key. ${omission}`;
    expect(result.structuredContent).toEqual({ snapshots: [], notice });
    expect(result.content).toEqual([
      { type: 'text', text: '**0 snapshots**\n' },
      { type: 'text', text: `\n\n> ${notice}` },
    ]);
    expect(calls(isCdx)).toHaveLength(2);
  });
});

describe('ia_find_snapshots history-mode collapse', () => {
  const sentCollapse = () =>
    calls(isCdx).map((c) => new URL(c.request.url).searchParams.get('collapse'));

  beforeEach(() => {
    routeCdx(() =>
      Response.json([
        ['timestamp', 'statuscode', 'mimetype', 'original', 'digest', 'length'],
        ['20150101000000', '200', 'text/html', 'http://example.com/', 'D', '1'],
      ]),
    );
  });

  it.each([
    ['omitted', {}],
    ['blank', { collapse: '' }],
  ])('sends the timestamp:8 default when collapse is %s', async (_label, collapse) => {
    await runToolContract(iaFindSnapshots, { url: 'example.com', mode: 'history', ...collapse });

    expect(sentCollapse()).toEqual(['timestamp:8']);
  });

  it('sends timestamp:14 as given', async () => {
    await runToolContract(iaFindSnapshots, {
      url: 'example.com',
      mode: 'history',
      collapse: 'timestamp:14',
    });

    expect(sentCollapse()).toEqual(['timestamp:14']);
  });

  it('describes blank and omitted as the default and names timestamp:14', () => {
    const described = iaFindSnapshots.input.shape.collapse.description ?? '';

    expect(described).not.toMatch(/uncollapsed/i);
    expect(described).toContain('timestamp:14');
    expect(iaFindSnapshots.description).toContain('timestamp:14');
  });
});

describe('ia_find_snapshots history mode under digest, urlkey, and every timestamp:N (#69)', () => {
  const HEADER = ['timestamp', 'statuscode', 'mimetype', 'original', 'digest', 'length'];
  const IANA_URL = 'iana.org/domains/reserved';
  const PLAIN = 'http://www.iana.org/domains/reserved';
  const PORT = 'http://www.iana.org:80/domains/reserved';
  const HTTPS = 'https://www.iana.org/domains/reserved';
  const PLAIN_SLASH = `${PLAIN}/`;
  const PORT_SLASH = `${PORT}/`;
  const D_ONNC = 'ONNCCJLMUVS2PL2CNK4CKUILPASQDCEA';
  const D_35IR = '35IR2OY2P6ZGGKZP6CQ5OUXPWOFOYA3E';
  const D_3I42 = '3I42H3S6NNFQ2MSVX7XZKYAYSCX5QBYJ';
  const D_7K6Z = '7K6ZBEISILYB5HWZTYHAAVMAMK2R7W4C';
  const D_5VTQ = '5VTQRB2ABYNIPDTWK5CADHWBVIQEUAI3';

  /**
   * The uncollapsed 2015 index of iana.org/domains/reserved as CDX served it on 2026-11-22
   * (timestamp, status, original, digest, length): 73 captures, two in the second
   * 20150716092504 — a 200 repeating the digest before it, then a 302.
   */
  const IANA_2015 = (
    [
      ['20150103131822', '200', PLAIN, D_ONNC, '3765'],
      ['20150110014937', '200', PORT, D_35IR, '3411'],
      ['20150112061215', '200', PORT, D_35IR, '3413'],
      ['20150206004741', '200', PORT, D_35IR, '3406'],
      ['20150207071712', '200', PORT, D_35IR, '3412'],
      ['20150208110504', '200', PORT, D_35IR, '3412'],
      ['20150211192805', '200', PORT, D_35IR, '3409'],
      ['20150216062601', '200', PORT, D_35IR, '3413'],
      ['20150219030410', '200', HTTPS, D_35IR, '3562'],
      ['20150219124803', '200', PORT, D_35IR, '3411'],
      ['20150222115936', '200', PORT, D_35IR, '3411'],
      ['20150222143730', '200', PORT, D_35IR, '3404'],
      ['20150226191831', '200', PORT, D_35IR, '3411'],
      ['20150302054208', '200', PORT, D_35IR, '3413'],
      ['20150305133051', '200', PORT, D_35IR, '3413'],
      ['20150309025406', '200', PORT, D_35IR, '3413'],
      ['20150311033649', '200', PORT, D_35IR, '3414'],
      ['20150315164644', '-', PLAIN, D_35IR, '490'],
      ['20150317080243', '200', PORT, D_35IR, '3412'],
      ['20150329213709', '200', HTTPS, D_35IR, '3559'],
      ['20150402094419', '302', PLAIN_SLASH, D_3I42, '424'],
      ['20150402094422', '-', PLAIN, D_35IR, '492'],
      ['20150415001619', '200', PORT, D_35IR, '3413'],
      ['20150416013817', '200', PORT, D_35IR, '3413'],
      ['20150419042212', '200', PORT, D_35IR, '3412'],
      ['20150511122649', '-', PLAIN, D_35IR, '540'],
      ['20150523125833', '200', PLAIN, D_ONNC, '3748'],
      ['20150530075231', '200', PLAIN, D_ONNC, '3753'],
      ['20150606053528', '200', PLAIN, D_ONNC, '3761'],
      ['20150606053545', '200', PLAIN, D_ONNC, '3768'],
      ['20150618172525', '200', HTTPS, D_ONNC, '3762'],
      ['20150619101923', '-', PLAIN, D_35IR, '539'],
      ['20150625172949', '-', PLAIN, D_35IR, '538'],
      ['20150629002329', '200', PORT, D_35IR, '3414'],
      ['20150630075815', '-', PLAIN, D_35IR, '520'],
      ['20150630145444', '200', PORT, D_35IR, '3414'],
      ['20150630173807', '-', PLAIN, D_35IR, '495'],
      ['20150701020807', '-', PLAIN, D_35IR, '492'],
      ['20150702233256', '-', PLAIN, D_35IR, '487'],
      ['20150704115145', '-', PLAIN, D_35IR, '487'],
      ['20150704213630', '-', PLAIN, D_35IR, '486'],
      ['20150705034018', '-', PLAIN, D_35IR, '487'],
      ['20150705221116', '-', PLAIN, D_35IR, '485'],
      ['20150707032545', '-', PLAIN, D_35IR, '511'],
      ['20150708174621', '-', PLAIN, D_35IR, '516'],
      ['20150708193843', '-', PLAIN, D_35IR, '514'],
      ['20150708194649', '-', PLAIN, D_35IR, '516'],
      ['20150714230802', '-', HTTPS, D_35IR, '521'],
      ['20150716092504', '200', PORT, D_35IR, '3437'],
      ['20150716092504', '302', PORT_SLASH, D_3I42, '288'],
      ['20150816075616', '200', PLAIN, D_7K6Z, '3588'],
      ['20150906130640', '200', PLAIN, D_5VTQ, '3588'],
      ['20150907025837', '200', PORT, D_5VTQ, '3438'],
      ['20150910223047', '200', HTTPS, D_5VTQ, '3576'],
      ['20150923163429', '200', PLAIN, D_5VTQ, '3792'],
      ['20150924041913', '200', PLAIN, D_5VTQ, '3587'],
      ['20150924154636', '200', PLAIN, D_5VTQ, '3588'],
      ['20151004164058', '-', PLAIN, D_5VTQ, '551'],
      ['20151006031756', '200', PORT, D_5VTQ, '3435'],
      ['20151009122707', '200', PORT, D_5VTQ, '3439'],
      ['20151014153638', '200', PLAIN, D_5VTQ, '3591'],
      ['20151026064135', '200', PORT, D_5VTQ, '3434'],
      ['20151031171701', '200', PORT, D_5VTQ, '3437'],
      ['20151104143046', '200', PORT, D_5VTQ, '3437'],
      ['20151106054313', '200', PLAIN, D_5VTQ, '3586'],
      ['20151108134616', '200', PORT, D_5VTQ, '3437'],
      ['20151109161653', '200', PORT, D_5VTQ, '3437'],
      ['20151113110920', '200', PORT, D_5VTQ, '3420'],
      ['20151117054113', '200', PORT, D_5VTQ, '3416'],
      ['20151121085556', '200', PORT, D_5VTQ, '3433'],
      ['20151127172023', '200', PORT, D_5VTQ, '3437'],
      ['20151129035359', '200', PLAIN, D_5VTQ, '3585'],
      ['20151212201327', '200', PORT, D_5VTQ, '3435'],
    ] satisfies [string, string, string, string, string][]
  ).map(([timestamp, status, original, digest, length]) => [
    timestamp,
    status,
    status === '-' ? 'warc/revisit' : 'text/html',
    original,
    digest,
    length,
  ]);

  /** CDX's own `collapse=digest` listing of `IANA_2015`, as captured (timestamp, status, digest). */
  const CHANGES_2015 = [
    ['20150103131822', '200', D_ONNC],
    ['20150110014937', '200', D_35IR],
    ['20150402094419', '302', D_3I42],
    ['20150402094422', '-', D_35IR],
    ['20150523125833', '200', D_ONNC],
    ['20150619101923', '-', D_35IR],
    ['20150716092504', '302', D_3I42],
    ['20150816075616', '200', D_7K6Z],
    ['20150906130640', '200', D_5VTQ],
  ];

  /** The same with `filter=statuscode:200`, which CDX applies before the collapse. */
  const CHANGES_2015_200 = [
    ['20150103131822', '200', D_ONNC],
    ['20150110014937', '200', D_35IR],
    ['20150523125833', '200', D_ONNC],
    ['20150629002329', '200', D_35IR],
    ['20150816075616', '200', D_7K6Z],
    ['20150906130640', '200', D_5VTQ],
  ];

  /**
   * A CDX server over `index`, one URL's uncollapsed rows in index order, answering as CDX
   * answered every captured query of `IANA_2015`: it keeps the rows within from and to that pass
   * the status filter, starting just past the row a resumeKey names, lists the first of each run
   * sharing the collapse key, and closes a page that reached limit with a key naming the last row
   * it read — the next group's first row, which a resumed query then skips.
   */
  const cdxOver =
    (index: string[][]): FetchMockResponder =>
    (request) => {
      const qp = new URL(request.url).searchParams;
      const from = (qp.get('from') ?? '').padEnd(14, '0');
      const to = (qp.get('to') ?? '').padEnd(14, '9');
      const status = qp.get('filter')?.replace(/^statuscode:/, '');
      const collapse = qp.get('collapse') ?? '';
      const keyOf = (row: string[]) =>
        collapse === 'digest'
          ? row[4]
          : collapse === 'urlkey'
            ? ''
            : row[0]!.slice(0, Number(collapse.slice('timestamp:'.length)));
      const limit = Number(qp.get('limit'));
      const start = qp.has('resumeKey') ? Number(qp.get('resumeKey')) + 1 : 0;
      const listed: string[][] = [];
      let lastKey: string | undefined;
      let lastRead = -1;
      for (const [i, row] of index.entries()) {
        if (i < start || row[0]! < from || row[0]! > to || (status && row[1] !== status)) continue;
        const key = keyOf(row);
        if (listed.length === limit) {
          lastRead = i;
          if (key === lastKey) continue;
          break;
        }
        if (key !== lastKey) listed.push(row);
        lastKey = key;
        lastRead = i;
      }
      if (listed.length === 0) return Response.json([]);
      const full = listed.length === limit;
      return Response.json([HEADER, ...listed, ...(full ? [[], [String(lastRead)]] : [])]);
    };

  type Page = {
    snapshots: { timestamp: string; statuscode?: string; digest?: string }[];
    resume_key?: string;
    notice?: string;
  };
  const out = (result: ToolResult) => result.structuredContent as Page;

  /** The rows of `pages`, joined, as [timestamp, statuscode, digest]. */
  const joined = (pages: ToolResult[]) =>
    pages.flatMap((page) => out(page).snapshots.map((s) => [s.timestamp, s.statuscode, s.digest]));

  /**
   * Every page of `query` at `limit`, following each resume_key with limit alone, through one
   * state store as a session's cursors persist between its calls.
   */
  const walk = async (query: Record<string, unknown>, limit: number): Promise<ToolResult[]> => {
    const shared = createMockContext();
    const definition = {
      ...iaFindSnapshots,
      handler: (
        input: Parameters<typeof iaFindSnapshots.handler>[0],
        ctx: Parameters<typeof iaFindSnapshots.handler>[1],
      ) => iaFindSnapshots.handler(input, { ...ctx, state: shared.state }),
    };
    const pages: ToolResult[] = [];
    let resume_key: string | undefined;
    do {
      const page = await runToolContract(
        definition,
        resume_key ? { url: query.url, mode: 'history', limit, resume_key } : { ...query, limit },
      );
      expect(page.isError, contentText(page)).toBeFalsy();
      pages.push(page);
      resume_key = out(page).resume_key;
      if (pages.length > 100) throw new Error(`the walk at limit ${limit} did not end`);
    } while (resume_key);
    return pages;
  };

  /** Each page's content[] carries every row's timestamp and digest, and its resume_key. */
  const expectBothSurfaces = (pages: ToolResult[]) => {
    for (const page of pages) {
      const text = contentText(page);
      for (const row of out(page).snapshots) {
        expect(text).toContain(`## ${row.timestamp}`);
        expect(text).toContain(`**Digest:** ${row.digest}`);
      }
      if (out(page).resume_key) expect(text).toContain(`**Resume Key:** ${out(page).resume_key}`);
    }
  };

  const sentParams = () =>
    calls(isCdx).map((c) => Object.fromEntries(new URL(c.request.url).searchParams));

  it('walks the captured digest listing at every limit, with and without status_filter "200", joining to the unpaged listing row for row', async () => {
    routeCdx(cdxOver(IANA_2015));

    for (const [filter, listing] of [
      [{}, CHANGES_2015],
      [{ status_filter: '200' }, CHANGES_2015_200],
    ] as const) {
      const query = {
        url: IANA_URL,
        mode: 'history',
        from: '2015',
        to: '2015',
        collapse: 'digest',
      };
      const unpaged = await runToolContract(iaFindSnapshots, { ...query, ...filter });
      expect(joined([unpaged])).toEqual(listing);
      for (let limit = 1; limit <= listing.length; limit++) {
        const pages = await walk({ ...query, ...filter }, limit);
        expect(joined(pages), `limit ${limit}`).toEqual(listing);
        expect(pages, `limit ${limit}`).toHaveLength(Math.ceil(listing.length / limit));
        expectBothSurfaces(pages);
      }
    }
    expect(sentParams().every((p) => !Object.hasOwn(p, 'resumeKey'))).toBe(true);
  });

  it('walks a second whose digests alternate at every limit without re-listing or skipping a capture', async () => {
    const version = (timestamp: string, digest: string) => [
      timestamp,
      '200',
      'text/html',
      'http://example.com/',
      digest,
      '1',
    ];
    routeCdx(
      cdxOver([
        version('20200101000000', 'A'),
        version('20200102000000', 'A'),
        version('20200102000000', 'B'),
        version('20200102000000', 'A'),
        version('20200102000000', 'B'),
        version('20200103000000', 'B'),
        version('20200104000000', 'C'),
        version('20200105000000', 'A'),
        version('20200105000000', 'B'),
        version('20200105000000', 'A'),
        version('20200106000000', 'D'),
      ]),
    );
    const listing = [
      ['20200101000000', '200', 'A'],
      ['20200102000000', '200', 'B'],
      ['20200102000000', '200', 'A'],
      ['20200102000000', '200', 'B'],
      ['20200104000000', '200', 'C'],
      ['20200105000000', '200', 'A'],
      ['20200105000000', '200', 'B'],
      ['20200105000000', '200', 'A'],
      ['20200106000000', '200', 'D'],
    ];

    for (let limit = 1; limit <= listing.length; limit++) {
      const pages = await walk({ url: 'example.com', mode: 'history', collapse: 'digest' }, limit);
      expect(joined(pages), `limit ${limit}`).toEqual(listing);
    }
  });

  it('lists one row for an exact url under urlkey, with no resume_key and no notice, on both surfaces', async () => {
    routeCdx(cdxOver(IANA_2015));

    const result = await runToolContract(iaFindSnapshots, {
      url: IANA_URL,
      mode: 'history',
      collapse: 'urlkey',
      limit: 1,
    });

    const replay = `https://web.archive.org/web/20150103131822/${PLAIN}`;
    expect(result.structuredContent).toEqual({
      snapshots: [
        {
          timestamp: '20150103131822',
          replay_url: replay,
          statuscode: '200',
          mimetype: 'text/html',
          original_url: PLAIN,
          digest: D_ONNC,
          length: '3765',
        },
      ],
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: [
          '## 20150103131822',
          `**Replay URL:** [${replay}](<${replay}>)`,
          '**Status:** 200',
          '**MIME:** text/html',
          `**Original URL:** [${PLAIN}](<${PLAIN}>)`,
          `**Digest:** ${D_ONNC}`,
          '**Length:** 3765',
          '',
        ].join('\n'),
      },
    ]);
    expect(sentParams()).toEqual([expect.objectContaining({ collapse: 'urlkey', limit: '2' })]);
  });

  it('pages a url ending in * under urlkey by CDX’s own key, with its notice on both surfaces', async () => {
    // CDX's two pages of info.cern.ch/hypertext/WWW/Summary* at limit 4, captured on 2026-11-22:
    // its timestamps, statuses, and originals, with digests cut short and one length throughout.
    const keyOne =
      'eJxLztBJTi3K08nMS8vX1M-oLEgtKkmtKNEvLy_XLy7NzU0sqtTLKMnNMcrLTM0pTs1TMDIwMjIwNDI0MDc0MzICAOm2FW0';
    const summary = 'http://info.cern.ch/hypertext/WWW/Summary.html';
    const pulua = `${summary}http://pulua.hcc.hawaii.edu`;
    const row = (timestamp: string, status: string, original: string, digest: string) => [
      timestamp,
      status,
      'text/html',
      original,
      digest,
      '338',
    ];
    const pageOne = [
      HEADER,
      row('19981207062434', '200', 'http://info.cern.ch:80/hypertext/WWW/Summary.html', 'YE4R'),
      row('20240526183313', '404', `${summary}%C2%AF`, 'FHEO'),
      row('20230108151537', '404', `${summary})`, 'WCB6'),
      row('20240616132359', '404', `${summary}2`, 'ZEBG'),
      [],
      [keyOne],
    ];
    const pageTwo = [
      HEADER,
      row('20220401071825', '404', `${summary}2Nielsen`, 'L4UL'),
      row('20240724193400', '404', pulua, '2ZF2'),
      row('20240724195024', '404', `${pulua}/guide/www.guide.html`, '2ZF2'),
      row('20240724193422', '404', `${pulua}/guide/www.guide.htmlhttp://info.cern.ch`, '2ZF2'),
      [],
      ['eJxNjEEKhDAMAL_iVZCkFsVlf1Ni1hSslm5C9ffSPe1tDjNDMhCXY4jH5'],
    ];
    routeCdx((request) =>
      Response.json(new URL(request.url).searchParams.has('resumeKey') ? pageTwo : pageOne),
    );
    const query = {
      url: 'info.cern.ch/hypertext/WWW/Summary*',
      mode: 'history',
      collapse: 'urlkey',
      limit: 4,
    };

    const first = await runToolContract(iaFindSnapshots, query);
    const second = await runToolContract(iaFindSnapshots, {
      ...query,
      resume_key: out(first).resume_key,
    });

    const notice =
      "This page holds 4 captures, the limit. Pass this response's resume_key as resume_key for the next page. CDX raw continuation pages a wildcard url and can omit the row at each page boundary or return it as a later capture of the same URL; a limit that holds the whole listing (up to 10,000 rows) avoids both.";
    for (const page of [first, second]) {
      expect(out(page).snapshots).toHaveLength(4);
      expect(out(page).notice).toBe(notice);
      expect(contentText(page)).toContain(`> ${notice}`);
    }
    expect(out(first).resume_key).toBe(keyOne);
    expect(sentParams()[1]).toMatchObject({ collapse: 'urlkey', limit: '4', resumeKey: keyOne });
  });

  it('pages timestamp:20, which CDX reads as timestamp:14, through server cursors without losing a capture', async () => {
    routeCdx(cdxOver(IANA_2015));
    // CDX lists one row per capture second: 72 of the 73 captures, as captured.
    const perSecond = IANA_2015.filter((row, i) => row[0] !== IANA_2015[i - 1]?.[0]);
    expect(perSecond).toHaveLength(72);

    const pages = await walk(
      { url: IANA_URL, mode: 'history', from: '2015', to: '2015', collapse: 'timestamp:20' },
      10,
    );

    expect(joined(pages)).toEqual(perSecond.map((row) => [row[0], row[1], row[4]]));
    expect(pages).toHaveLength(8);
    const sent = sentParams();
    for (const params of sent) {
      expect(params).toMatchObject({ collapse: 'timestamp:20', limit: '11' });
      expect(params).not.toHaveProperty('resumeKey');
    }
    expect(sent.slice(1).map((p) => p.from)).toEqual(
      pages.slice(1).map((page) => out(page).snapshots[0]?.timestamp),
    );
  });

  it('answers timestamp:0 with the first capture in range and nothing to resume, even at limit 1', async () => {
    routeCdx(cdxOver(IANA_2015));

    const result = await runToolContract(iaFindSnapshots, {
      url: IANA_URL,
      mode: 'history',
      from: '2015',
      to: '2015',
      collapse: 'timestamp:0',
      limit: 1,
    });

    expect(joined([result])).toEqual([['20150103131822', '200', D_ONNC]]);
    for (const absent of ['resume_key', 'truncated', 'notice'])
      expect(result.structuredContent).not.toHaveProperty(absent);
    expect(contentText(result)).not.toContain('Resume Key');
    expect(sentParams()).toEqual([
      expect.objectContaining({ collapse: 'timestamp:0', limit: '2' }),
    ]);
  });

  it('sends a timestamp:N page and its resumed page as it always has', async () => {
    routeCdx(cdxOver(IANA_2015));

    const pages = await walk(
      { url: IANA_URL, mode: 'history', from: '2015', to: '2015', collapse: 'timestamp:8' },
      3,
    );

    expect(pages.length).toBeGreaterThan(1);
    const [first, second] = calls(isCdx).map((c) => new URL(c.request.url).search);
    expect(first).toBe(
      '?url=iana.org%2Fdomains%2Freserved&output=json&fl=timestamp%2Cstatuscode%2Cmimetype%2Coriginal%2Cdigest%2Clength&collapse=timestamp%3A8&limit=4&showResumeKey=true&from=2015&to=2015',
    );
    expect(second).toBe(
      '?url=iana.org%2Fdomains%2Freserved&output=json&fl=timestamp%2Cstatuscode%2Cmimetype%2Coriginal%2Cdigest%2Clength&collapse=timestamp%3A8&limit=4&showResumeKey=true&from=20150206004741&to=2015',
    );
  });
});

describe('ia_find_snapshots history mode: an empty list means CDX listed no rows (#72)', () => {
  const history = (input: Record<string, unknown> = {}, signal?: AbortSignal) =>
    runToolContract(
      iaFindSnapshots,
      { url: 'example.com', mode: 'history', ...input },
      signal && { context: { signal } },
    );

  /** A failed call: its code and reason, no `snapshots` on either surface. */
  const expectFailed = (result: ToolResult, code: number, reason: string | undefined) => {
    expect(result.isError).toBe(true);
    expect(result.structuredContent).not.toHaveProperty('snapshots');
    const { error } = result.structuredContent as {
      error: { code: number; data?: Record<string, unknown> };
    };
    expect(error.code).toBe(code);
    expect(error.data?.reason).toBe(reason);
    expect(contentText(result)).not.toContain('0 snapshots');
  };

  /** CDX's answer for a site excluded from the archive: a 403 with an empty body. */
  const BLOCKED_SITE = () =>
    new Response('', {
      status: 403,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-archive-wayback-runtime-error':
          'AdministrativeAccessControlException: Blocked Site Error',
      },
    });

  describe('every other way a history call can end with no rows stays a failure', () => {
    const UNAVAILABLE_AS = [JsonRpcErrorCode.ServiceUnavailable, 'cdx_unavailable'] as const;

    it.each([
      ['an HTTP 503 after its retries', UNAVAILABLE, ...UNAVAILABLE_AS],
      [
        'an excluded site’s HTTP 403',
        BLOCKED_SITE,
        JsonRpcErrorCode.NotFound,
        'no_snapshot_available',
      ],
      [
        'an HTML page',
        () =>
          new Response('<html><body>Temporarily Offline</body></html>', {
            headers: { 'content-type': 'text/html' },
          }),
        ...UNAVAILABLE_AS,
      ],
      [
        'text that is not JSON',
        () =>
          new Response('[["timestamp","statuscode"', {
            headers: { 'content-type': 'application/json' },
          }),
        ...UNAVAILABLE_AS,
      ],
      ['headers that never arrive', hang, ...UNAVAILABLE_AS],
      ['a body that never completes', stall('[["timestamp"'), ...UNAVAILABLE_AS],
    ] as const)('%s', async (_label, respond, code, reason) => {
      routeCdx(respond);
      const url = reason === 'no_snapshot_available' ? 'excluded.example.com' : 'example.com';

      const result = await runWithRetries(() => history({ url }));

      expectFailed(result, code, reason);
    });

    it('the call deadline running out mid-retry', async () => {
      routeCdx(answerAfter(29_900, UNAVAILABLE));

      const result = await runWithRetries(() => history());

      expectFailed(result, ...UNAVAILABLE_AS);
      expect(contentText(result)).toContain(
        'CDX API did not finish within the 55 s call deadline.',
      );
    });

    it('the caller cancelling mid-request', async () => {
      vi.useFakeTimers();
      routeCdx(hang);
      const controller = new AbortController();

      const pending = history({}, controller.signal);
      await vi.advanceTimersByTimeAsync(5_000);
      controller.abort();
      const result = await pending;

      expectFailed(result, JsonRpcErrorCode.RequestCancelled, undefined);
    });
  });

  describe('CDX answering with no rows is an empty list and a notice, after one request', () => {
    /** CDX's answer for a query that matches nothing, as it sends it. */
    const NO_ROWS = () => new Response('[]\n', { headers: { 'content-type': 'application/json' } });

    it('the filters sent, quoted as CDX received them, on both surfaces', async () => {
      routeCdx(NO_ROWS);

      const result = await history({
        url: 'iana.org/domains/reserved',
        from: '2015',
        to: '2015',
        status_filter: '301',
      });

      const notice =
        'No captures of this URL match from "2015", to "2015", status_filter "301"; widen from and to, or remove status_filter.';
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ snapshots: [], notice });
      expect(result.content).toEqual([
        { type: 'text', text: '**0 snapshots**\n' },
        { type: 'text', text: `\n\n> ${notice}` },
      ]);
      expect(calls(isCdx)).toHaveLength(1);
      expect(Object.fromEntries(new URL(calls(isCdx)[0]!.request.url).searchParams)).toMatchObject({
        from: '2015',
        to: '2015',
        filter: 'statuscode:301',
      });
    });

    const NONE_OF_URL = 'The Wayback Machine lists no captures of this URL.';
    const HEADER_ONLY = () =>
      Response.json([['timestamp', 'statuscode', 'mimetype', 'original', 'digest', 'length']]);

    it.each([
      ['a URL never captured', 'example.com/never-captured', NO_ROWS, NONE_OF_URL],
      ['a header row alone', 'example.com', HEADER_ONLY, NONE_OF_URL],
      [
        'a prefix nothing is under',
        'example.com/no-such-dir/*',
        NO_ROWS,
        'No URL under this prefix has captures.',
      ],
    ])('%s', async (_label, url, respond, notice) => {
      routeCdx(respond);

      const result = await history({ url });

      expect(result.structuredContent).toEqual({ snapshots: [], notice });
      expect(contentText(result)).toBe(`**0 snapshots**\n\n\n\n> ${notice}`);
      expect(calls(isCdx)).toHaveLength(1);
    });
  });

  describe('a 200 whose JSON is not a list of rows fails as the asking call’s unavailable reason', () => {
    const NOT_ROWS = () => Response.json({});

    it('history mode: cdx_unavailable, retried like an unparseable body', async () => {
      routeCdx(NOT_ROWS);

      const result = await runWithRetries(() => history());

      expectFailed(result, JsonRpcErrorCode.ServiceUnavailable, 'cdx_unavailable');
      expect(contentText(result)).toContain('CDX API returned JSON that is not a list of rows.');
      expect(contentText(result)).toContain(
        `Recovery: ${hint(iaFindSnapshots.errors, 'cdx_unavailable')}`,
      );
      expect(calls(isCdx)).toHaveLength(4);
    });

    it('ia_find_snapshots closest, after an empty Availability answer: cdx_unavailable, never a miss', async () => {
      routeAvailability(EMPTY_AVAILABILITY);
      routeCdx(NOT_ROWS);

      const result = await runToolContract(iaFindSnapshots, {
        url: 'example.com',
        mode: 'closest',
        timestamp: '20200101',
      });

      expectFailed(result, JsonRpcErrorCode.ServiceUnavailable, 'cdx_unavailable');
      expect(contentText(result)).toMatch(FALLBACK_MESSAGE);
      expect(calls(isCdx)).toHaveLength(1);
    });

    it('ia_find_snapshots closest, after Availability 503s: availability_unavailable, never a miss', async () => {
      routeAvailability(UNAVAILABLE);
      routeCdx(NOT_ROWS);

      const result = await runWithRetries(() =>
        runToolContract(iaFindSnapshots, {
          url: 'example.com',
          mode: 'closest',
          timestamp: '20200101',
        }),
      );

      expectFailed(result, JsonRpcErrorCode.ServiceUnavailable, 'availability_unavailable');
      expect(contentText(result)).toMatch(
        /closest-capture lookup for example\.com near 20200101 did not complete/,
      );
      expect(calls(isCdx)).toHaveLength(1);
    });

    it('ia_get_snapshot, after an empty Availability answer: content_fetch_failed, with no replay', async () => {
      routeAvailability(EMPTY_AVAILABILITY);
      routeCdx(NOT_ROWS);

      const result = await runToolContract(iaGetSnapshot, {
        url: 'example.com',
        timestamp: '2020',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'content_fetch_failed' },
        },
      });
      expect(contentText(result)).toContain('CDX API returned JSON that is not a list of rows.');
      expect(calls(isCdx)).toHaveLength(1);
      expect(calls(isReplay)).toHaveLength(0);
    });
  });
});

describe('ia_get_snapshot', () => {
  const PAGE = '<html><body><p>Hello&nbsp;world &rsaquo; more</p></body></html>';

  it('resolves an 8-digit timestamp through the CDX fallback and fetches that capture', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(cdxRows(['20200101231916', 'https://www.nasa.gov/', '200']));
    routeReplay(replay(PAGE));

    const result = await runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' });

    const replayUrl = 'https://web.archive.org/web/20200101231916/https://www.nasa.gov/';
    expect(result.structuredContent).toMatchObject({
      text: 'Hello world › more',
      replay_url: replayUrl,
      resolved_timestamp: '20200101231916',
      resolved_status: '200',
    });
    expect(calls(isReplay)[0]?.request.url).toBe(replayUrl);
    const text = contentText(result);
    expect(text).toContain(`**Replay URL:** [${replayUrl}](<${replayUrl}>)`);
    expect(text).toContain('**Resolved Timestamp:** 20200101231916');
    expect(text).toContain('Hello world › more');
  });

  it('fetches the https form of an Availability capture without querying CDX', async () => {
    routeAvailability(() =>
      Response.json({
        archived_snapshots: {
          closest: {
            url: 'http://web.archive.org/web/20200101004937/https://www.nasa.gov/',
            timestamp: '20200101004937',
            status: '200',
          },
        },
      }),
    );
    routeReplay(replay(PAGE));

    const result = await runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' });

    expect(calls(isReplay)[0]?.request.url).toBe(
      'https://web.archive.org/web/20200101004937/https://www.nasa.gov/',
    );
    expect(result.structuredContent).toMatchObject({
      replay_url: 'https://web.archive.org/web/20200101004937/https://www.nasa.gov/',
      resolved_timestamp: '20200101004937',
    });
    expect(calls(isCdx)).toHaveLength(0);
  });

  it('reports no_snapshot_available with its own hint when both sources are empty', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(cdxRows());

    const result = await runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' });

    const recovery = hint(iaGetSnapshot.errors, 'no_snapshot_available');
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'no_snapshot_available', recovery: { hint: recovery } } },
    });
    expect(contentText(result)).toContain(`Recovery: ${recovery}`);
    expect(calls(isReplay)).toHaveLength(0);
  });

  it('fetches the CDX capture after retrying an Availability 503', async () => {
    routeAvailability(UNAVAILABLE);
    routeCdx(cdxRows(['20200101231916', 'https://www.nasa.gov/', '200']));
    routeReplay(replay(PAGE));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' }),
    );

    expect(result.structuredContent).toMatchObject({
      text: 'Hello world › more',
      resolved_timestamp: '20200101231916',
    });
    expect(contentText(result)).toContain('**Resolved Timestamp:** 20200101231916');
    expect(calls(isAvailability)).toHaveLength(4);
    expect(calls(isCdx)).toHaveLength(1);
    expect(calls(isReplay)[0]?.request.url).toBe(
      'https://web.archive.org/web/20200101231916/https://www.nasa.gov/',
    );
  });

  it('surfaces content_fetch_failed naming the lookup, never the Availability API alone, when the fallback after four 503s fails too', async () => {
    routeAvailability(UNAVAILABLE);
    routeCdx(() => new Response('Temporarily Offline', { status: 503 }));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' }),
    );

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(LOOKUP_FAILED_MESSAGE),
        data: {
          reason: 'content_fetch_failed',
          recovery: { hint: expect.stringMatching(NO_LOOKUP_ROUTE) },
        },
      },
    });
    const text = contentText(result);
    expect(text).toMatch(
      /^Error: The closest-capture lookup for nasa\.gov near 20200101 did not complete/m,
    );
    expect(text).not.toContain(hint(iaGetSnapshot.errors, 'content_fetch_failed'));
    expect(calls(isAvailability)).toHaveLength(4);
    expect(calls(isCdx)).toHaveLength(1);
    expect(calls(isReplay)).toHaveLength(0);
  });

  it('ends a lookup whose Availability attempts each answer 503 just inside the request timeout at 55 s', async () => {
    routeAvailability(answerAfter(29_900, UNAVAILABLE));
    routeCdx(hang);
    vi.useFakeTimers();
    const start = Date.now();

    const pending = runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(Date.now() - start).toBe(55_000);
    expect(result.structuredContent).toMatchObject({
      error: {
        message: expect.stringMatching(
          /^The closest-capture lookup for nasa\.gov .*55 s call deadline/,
        ),
        data: {
          reason: 'content_fetch_failed',
          recovery: { hint: expect.stringMatching(NO_LOOKUP_ROUTE) },
        },
      },
    });
    expect(calls(isCdx)).toHaveLength(0);
    expect(calls(isReplay)).toHaveLength(0);
  });

  it('surfaces content_fetch_failed with the fallback message when the CDX fallback times out', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(hang);
    vi.useFakeTimers();

    const pending = runToolContract(iaGetSnapshot, { url: 'github.com', timestamp: '20180101' });
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await pending;

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(FALLBACK_MESSAGE),
        data: {
          reason: 'content_fetch_failed',
          recovery: { hint: expect.stringContaining(FALLBACK_HINT) },
        },
      },
    });
    expect(calls(isCdx)).toHaveLength(1);
    expect(calls(isReplay)).toHaveLength(0);
  });

  it('fetches the CDX capture after one Availability 429', async () => {
    routeAvailability(RATE_LIMITED);
    routeCdx(cdxRows(['20200101231916', 'https://www.nasa.gov/', '200']));
    routeReplay(replay(PAGE));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' }),
    );

    expect(result.structuredContent).toMatchObject({ resolved_timestamp: '20200101231916' });
    expect(calls(isAvailability)).toHaveLength(1);
    expect(calls(isCdx)).toHaveLength(1);
  });

  it('answers an Availability 429 whose fallback fails with content_fetch_failed carrying the wait hint', async () => {
    routeAvailability(
      () => new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } }),
    );
    routeCdx(() => new Response('Temporarily Offline', { status: 503 }));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' }),
    );

    expect(result.structuredContent).toMatchObject({
      error: {
        message: expect.stringMatching(LOOKUP_FAILED_MESSAGE),
        data: {
          reason: 'content_fetch_failed',
          retryAfter: '120',
          recovery: { hint: expect.stringMatching(/wait 120 seconds, then list nearby captures/) },
        },
      },
    });
    expect(contentText(result)).not.toContain('not retryable');
    expect(calls(isAvailability)).toHaveLength(1);
    expect(calls(isCdx)).toHaveLength(1);
  });

  it('maps an Availability page of unparseable JSON to content_fetch_failed, never ValidationError', async () => {
    routeAvailability(() => new Response('{"url": "nasa.gov", "archived_snap'));
    routeCdx(() => new Response('Temporarily Offline', { status: 503 }));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' }),
    );

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'content_fetch_failed' },
      },
    });
  });

  it('reports the served capture’s own status when Wayback followed a redirect capture', async () => {
    routeAvailability(() =>
      Response.json({
        archived_snapshots: {
          closest: {
            url: 'http://web.archive.org/web/20200101230622/http://nasa.gov/',
            timestamp: '20200101230622',
            status: '301',
          },
        },
      }),
    );
    const asked = 'https://web.archive.org/web/20200101230622/http://nasa.gov/';
    const target = 'https://web.archive.org/web/20200101230622/https://www.nasa.gov/';
    const served = 'https://web.archive.org/web/20200101230626/https://www.nasa.gov/';
    http.route({
      match: asked,
      respond: archivedRedirect(301, 'Wed, 01 Jan 2020 23:06:22 GMT', target),
    });
    http.route({ match: target, respond: nearestCapture(served) });
    http.route({ match: served, respond: replay(PAGE) });

    const result = await runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' });

    const notice =
      'The capture at 20200101230622 is an archived HTTP 301 redirect to `https://www.nasa.gov/`, and the text comes from the capture Wayback served for that URL (replay_url).';
    expect(result.structuredContent).toMatchObject({
      replay_url: served,
      resolved_timestamp: '20200101230626',
      resolved_status: '200',
      notice,
    });
    const text = contentText(result);
    expect(text).toContain('**Resolved Timestamp:** 20200101230626 | **Status:** 200');
    expect(text).toContain(`> ${notice}`);
    expect(replayUrls()).toEqual([asked, target, served]);
  });

  it('discloses a body cut at the byte ceiling on both surfaces', async () => {
    const chunk = new TextEncoder().encode('<p>news</p>'.repeat(6_000));
    let pulled = 0;
    let cancelled = false;
    routeReplay(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled === 200) return controller.close();
              pulled++;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/html' } },
        ),
    );

    const result = await runToolContract(iaGetSnapshot, {
      url: 'https://edition.cnn.com/',
      timestamp: '20240601000205',
    });

    const sc = result.structuredContent as { text: string; notice?: string };
    expect(sc.text.startsWith('news\nnews')).toBe(true);
    expect(sc.notice).toContain('first 4,194,304 bytes');
    expect(contentText(result)).toContain('first 4,194,304 bytes');
    expect(cancelled).toBe(true);
    expect(pulled * chunk.length).toBeLessThan(4_194_304 + 3 * chunk.length);
  });

  it('decodes an undeclared Latin-1 page with the replay’s guessed charset, on both surfaces', async () => {
    const html = '<html><body>The Rest \xa9 1997-99 Rob Malda</body></html>';
    routeReplay(
      replay(
        Uint8Array.from(html, (c) => c.charCodeAt(0)),
        {
          'x-archive-guessed-charset': 'iso-8859-1',
        },
      ),
    );

    const result = await runToolContract(iaGetSnapshot, {
      url: 'http://slashdot.org/',
      timestamp: '19991007185528',
    });

    expect((result.structuredContent as { text: string }).text).toBe(
      'The Rest © 1997-99 Rob Malda',
    );
    expect(contentText(result)).toContain('The Rest © 1997-99 Rob Malda');
  });

  it('answers a replay 429 after one request with content_fetch_failed and a wait hint', async () => {
    routeReplay(RATE_LIMITED);

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '20200104000551' }),
    );

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'content_fetch_failed',
          recovery: { hint: expect.stringMatching(/rate-limiting.*wait several minutes/) },
        },
      },
    });
    expect(contentText(result)).not.toContain('not retryable');
    expect(calls(isReplay)).toHaveLength(1);
  });

  it('still retries a replay 503 and surfaces content_fetch_failed with its declared hint', async () => {
    routeReplay(() => new Response('Service Unavailable', { status: 503 }));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '20200104000551' }),
    );

    const recovery = hint(iaGetSnapshot.errors, 'content_fetch_failed');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'content_fetch_failed', recovery: { hint: recovery } },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${recovery}`);
    expect(calls(isReplay)).toHaveLength(4);
  });

  it('reports the capture Wayback redirected an exact timestamp to', async () => {
    const asked = 'https://web.archive.org/web/20200104000000/example.com';
    const served = 'https://web.archive.org/web/20200104000551/https://example.com/';
    http.route({ match: asked, respond: nearestCapture(served) });
    http.route({ match: served, respond: replay(PAGE) });

    const result = await runToolContract(iaGetSnapshot, {
      url: 'example.com',
      timestamp: '20200104000000',
    });

    expect(replayUrls()).toEqual([asked, served]);
    expect(result.structuredContent).toMatchObject({
      replay_url: served,
      resolved_timestamp: '20200104000551',
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    const text = contentText(result);
    expect(text).toContain(`**Replay URL:** [${served}](<${served}>)`);
    expect(text).toContain('**Resolved Timestamp:** 20200104000551');
    expect(text).not.toContain('archived HTTP');
  });

  it('keeps the requested URL and timestamp for a capture served without a redirect', async () => {
    const requested = 'https://web.archive.org/web/20200104000551/https://example.com/';
    routeReplay(replay(PAGE));

    const result = await runToolContract(iaGetSnapshot, {
      url: 'https://example.com/',
      timestamp: '20200104000551',
    });

    expect(result.structuredContent).toMatchObject({
      replay_url: requested,
      resolved_timestamp: '20200104000551',
    });
  });

  it('decodes a Latin-1 page declared in its meta tag, on both surfaces', async () => {
    const html =
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">' +
      '</head><body>Actualit\xe9s &middot; Multim\xe9dia</body></html>';
    routeReplay(replay(Uint8Array.from(html, (c) => c.charCodeAt(0))));

    const result = await runToolContract(iaGetSnapshot, {
      url: 'http://www.lemonde.fr/',
      timestamp: '20040609213303',
    });

    const sc = result.structuredContent as { text: string };
    expect(sc.text).toBe('Actualités · Multimédia');
    expect(contentText(result)).toContain('Actualités · Multimédia');
    expect(contentText(result)).not.toContain('�');
  });
});

describe('ia_get_snapshot following a replay’s redirects (#63)', () => {
  const recovery = () => hint(iaGetSnapshot.errors, 'no_snapshot_available');

  const errorOf = (result: ToolResult) =>
    (result.structuredContent as { error: { code: number; message: string } }).error;

  /** `no_snapshot_available` with `message` and the declared hint, on both surfaces. */
  const expectDeadEnd = (result: ToolResult, message: string) => {
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message,
        data: { reason: 'no_snapshot_available', recovery: { hint: recovery() } },
      },
    });
    const text = contentText(result);
    expect(text).toContain(`Error: ${message}`);
    expect(text).toContain(`Recovery: ${recovery()}`);
  };

  it('follows an archived redirect with a root-relative Location to the served capture, and its next page is one request to that capture', async () => {
    const asked =
      'https://web.archive.org/web/20250805171636/http://www.example.org/documents/report.pdf';
    const target = 'https://web.archive.org/web/20250805171636/http://redirected.example.org/';
    const served = 'https://web.archive.org/web/20250828072413/http://redirected.example.org/';
    http.route({
      match: asked,
      respond: archivedRedirect(
        301,
        'Tue, 05 Aug 2025 17:16:36 GMT',
        '/web/20250805171636/http://redirected.example.org/',
      ),
    });
    http.route({ match: target, respond: nearestCapture(served) });
    http.route({
      match: served,
      respond: replay(
        `<html><body><p>${'a'.repeat(50_000)}${'b'.repeat(10_000)}</p></body></html>`,
      ),
    });
    routeUnrouted();

    const first = await runToolContract(iaGetSnapshot, {
      url: 'http://www.example.org/documents/report.pdf',
      timestamp: '20250805171636',
    });

    const notice =
      'The capture at 20250805171636 is an archived HTTP 301 redirect to `http://redirected.example.org/`, and the text comes from the capture Wayback served for that URL (replay_url). More text follows: call ia_get_snapshot again with url `http://redirected.example.org/`, timestamp 20250828072413 (resolved_timestamp), and char_offset 50000 for the next page.';
    expect(first.structuredContent).toMatchObject({
      text: 'a'.repeat(50_000),
      replay_url: served,
      resolved_timestamp: '20250828072413',
      resolved_status: '200',
      has_more: true,
      notice,
    });
    const text = contentText(first);
    expect(text).toContain(`**Replay URL:** [${served}](<${served}>)`);
    expect(text).toContain('**Resolved Timestamp:** 20250828072413 | **Status:** 200');
    expect(text).toContain(`> ${notice}`);
    expect(replayUrls()).toEqual([asked, target, served]);

    const next = await runToolContract(iaGetSnapshot, {
      url: 'http://redirected.example.org/',
      timestamp: '20250828072413',
      char_offset: 50_000,
    });

    expect(next.structuredContent).toMatchObject({
      text: 'b'.repeat(10_000),
      replay_url: served,
      char_offset: 50_000,
      has_more: false,
      total_chars: 60_000,
    });
    expect(next.structuredContent).not.toHaveProperty('notice');
    expect(contentText(next)).toContain('b'.repeat(10_000));
    expect(replayUrls()).toEqual([asked, target, served, served]);
  });

  it('names the served capture without the fragment an archived redirect’s Location carried, in replay_url and both notices', async () => {
    const asked = 'https://web.archive.org/web/20250805171636/http://www.example.org/';
    const served = 'https://web.archive.org/web/20250805171636/http://redirected.example.org/';
    http.route({
      match: asked,
      respond: archivedRedirect(301, 'Tue, 05 Aug 2025 17:16:36 GMT', `${served}#main`),
    });
    // Matched without its fragment, so a request that carries one still reaches the capture.
    http.route({
      match: (request) => request.url.replace(/#.*$/s, '') === served,
      respond: replay(`<html><body><p>${'a'.repeat(60_000)}</p></body></html>`),
    });
    routeUnrouted();

    const result = await runToolContract(iaGetSnapshot, {
      url: 'http://www.example.org/',
      timestamp: '20250805171636',
    });

    const notice =
      'The capture at 20250805171636 is an archived HTTP 301 redirect to `http://redirected.example.org/`, and the text comes from the capture Wayback served for that URL (replay_url). More text follows: call ia_get_snapshot again with url `http://redirected.example.org/`, timestamp 20250805171636 (resolved_timestamp), and char_offset 50000 for the next page.';
    expect(result.structuredContent).toMatchObject({ replay_url: served, notice });
    expect(contentText(result)).toContain(`> ${notice}`);
    expect(replayUrls()).toEqual([asked, served]);
  });

  it('fails an archived redirect whose target Wayback never archived as no_snapshot_available, after one attempt', async () => {
    const asked = 'https://web.archive.org/web/20240515003448/https://example.com/';
    const target =
      'https://web.archive.org/web/20240515003448/http://parked.example.org/?subid1=abc';
    http.route({
      match: asked,
      respond: archivedRedirect(302, 'Wed, 15 May 2024 00:34:48 GMT', target),
    });
    http.route({
      match: target,
      respond: () =>
        new Response('Wayback Machine has not archived that URL.', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
    });
    routeUnrouted();

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'https://example.com/', timestamp: '20240515003448' }),
    );

    expectDeadEnd(
      result,
      'The capture of https://example.com/ at 20240515003448 is an archived HTTP 302 redirect to http://parked.example.org/?subid1=abc; the Wayback Machine has not archived that URL.',
    );
    expect(replayUrls()).toEqual([asked, target]);
  });

  it('names the target’s capture and status when an archived redirect ends on an archived error page, after one attempt', async () => {
    const asked = 'https://web.archive.org/web/20190419141850/http://www.example.org/';
    const target =
      'https://web.archive.org/web/20190419141850/https://redirected.example.org/status';
    http.route({
      match: asked,
      respond: archivedRedirect(
        301,
        'Fri, 19 Apr 2019 14:18:50 GMT',
        '/web/20190419141850/https://redirected.example.org/status',
      ),
    });
    http.route({ match: target, respond: archivedError(503, 'Fri, 19 Apr 2019 14:18:56 GMT') });
    routeUnrouted();

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, {
        url: 'http://www.example.org/',
        timestamp: '20190419141850',
      }),
    );

    expectDeadEnd(
      result,
      'The capture of http://www.example.org/ at 20190419141850 is an archived HTTP 301 redirect to https://redirected.example.org/status; its capture at 20190419141856 is an archived HTTP 503 error page.',
    );
    expect(errorOf(result).message).not.toContain(
      'capture at 20190419141850 is an archived HTTP 503',
    );
    expect(replayUrls()).toEqual([asked, target]);
  });

  it('fails redirects that loop as no_snapshot_available without a retry', async () => {
    const asked = 'https://web.archive.org/web/20200104000000/example.com';
    const nearest = 'https://web.archive.org/web/20200104000551/https://example.com/';
    http.route({ match: asked, respond: nearestCapture(nearest) });
    http.route({ match: nearest, respond: nearestCapture(asked) });
    routeUnrouted();

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '20200104000000' }),
    );

    expectDeadEnd(
      result,
      `No readable capture of example.com at 20200104000000: the next redirect returns to ${asked}, which was already requested.`,
    );
    expect(replayUrls()).toEqual([asked, nearest]);
  });

  it('names an eleventh redirect that is itself an archived redirect, after one attempt', async () => {
    const hop = (i: number) =>
      `https://web.archive.org/web/202001010000${String(i).padStart(2, '0')}/https://example.com/`;
    for (let i = 0; i < 10; i++) http.route({ match: hop(i), respond: nearestCapture(hop(i + 1)) });
    http.route({
      match: hop(10),
      respond: archivedRedirect(
        301,
        'Wed, 01 Jan 2020 00:00:10 GMT',
        'https://web.archive.org/web/20200101000010/http://redirected.example.org/',
      ),
    });
    routeUnrouted();

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'https://example.com/', timestamp: '20200101000000' }),
    );

    expectDeadEnd(
      result,
      'The capture of https://example.com/ at 20200101000010 is an archived HTTP 301 redirect to http://redirected.example.org/; the redirects continue past 10, the most this server follows.',
    );
    expect(replayUrls()).toHaveLength(11);
  });

  it.each([403, 410, 451])(
    'fails a %i for an archived redirect’s target as a refusal with the declared hint, never as a URL not served',
    async (status) => {
      const asked = 'https://web.archive.org/web/20250805171636/http://www.example.org/';
      const target = 'https://web.archive.org/web/20250805171636/http://redirected.example.org/';
      http.route({
        match: asked,
        respond: archivedRedirect(301, 'Tue, 05 Aug 2025 17:16:36 GMT', target),
      });
      http.route({
        match: target,
        respond: () =>
          new Response('<p>playback</p>', { status, headers: { 'content-type': 'text/html' } }),
      });
      routeUnrouted();

      const result = await runWithRetries(() =>
        runToolContract(iaGetSnapshot, {
          url: 'http://www.example.org/',
          timestamp: '20250805171636',
        }),
      );

      expectDeadEnd(
        result,
        `The capture of http://www.example.org/ at 20250805171636 is an archived HTTP 301 redirect to http://redirected.example.org/; the Wayback Machine refused to replay it with HTTP ${status}.`,
      );
      expect(contentText(result)).not.toMatch(/does not serve captures|at any timestamp/);
      expect(replayUrls()).toEqual([asked, target]);
    },
  );

  describe('after only a nearest-capture redirect, the answer keeps its own message', () => {
    const asked = 'https://web.archive.org/web/20200104000000/example.com';
    const nearest = 'https://web.archive.org/web/20200104000551/https://example.com/';
    const read = () =>
      runWithRetries(() =>
        runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '20200104000000' }),
      );

    it('a not-served status: a URL the Wayback Machine does not serve, with its own hint', async () => {
      http.route({ match: asked, respond: nearestCapture(nearest) });
      http.route({
        match: nearest,
        respond: () =>
          new Response('<p>playback</p>', {
            status: 410,
            headers: { 'content-type': 'text/html' },
          }),
      });
      routeUnrouted();

      const result = await read();

      const message = 'The Wayback Machine does not serve captures of example.com (HTTP 410).';
      const notServed =
        'No capture of this URL can be read from the Wayback Machine at any timestamp, so another timestamp or a retry will not help; look for the content under a different URL.';
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message,
          data: { reason: 'no_snapshot_available', recovery: { hint: notServed } },
        },
      });
      const text = contentText(result);
      expect(text).toContain(`Error: ${message}`);
      expect(text).toContain(`Recovery: ${notServed}`);
      expect(replayUrls()).toEqual([asked, nearest]);
    });

    it('an archived error page: the capture and its archived status', async () => {
      http.route({ match: asked, respond: nearestCapture(nearest) });
      http.route({ match: nearest, respond: archivedError(503, 'Sat, 04 Jan 2020 00:05:51 GMT') });
      routeUnrouted();

      const result = await read();

      expectDeadEnd(
        result,
        'The capture of example.com at 20200104000551 is an archived HTTP 503 error page — the site returned that error when it was captured, so the capture holds no copy of the page itself.',
      );
      expect(replayUrls()).toEqual([asked, nearest]);
    });
  });
});

describe('ia_get_snapshot by the replay’s media type (#49)', () => {
  /** A replay of a capture's original bytes: the `id_` form. */
  const isRaw = (r: Request) => /^https:\/\/web\.archive\.org\/web\/\d{14}id_\//.test(r.url);
  const routeRaw = (respond: FetchMockResponder) => http.route({ match: isRaw, respond });
  const routePlain = (respond: FetchMockResponder) =>
    http.route({ match: (r) => isReplay(r) && !isRaw(r), respond });

  const GITHUB = { url: 'https://api.github.com/', timestamp: '20200116122222' } as const;
  const GITHUB_PLAIN = 'https://web.archive.org/web/20200116122222/https://api.github.com/';
  const GITHUB_RAW = 'https://web.archive.org/web/20200116122222id_/https://api.github.com/';
  /** The first two keys of the 2020-01-16 api.github.com capture, as its id_ form serves them. */
  const GITHUB_JSON =
    '{"current_user_url":"https://api.github.com/user","current_user_authorizations_html_url":"https://github.com/settings/connections/applications{/client_id}"}';
  /** RFC 2616 §2.1, as its text/plain capture holds it: line breaks and ABNF angle brackets. */
  const RFC_2616_RULE =
    '   *rule\n      The character "*" preceding an element indicates repetition. The\n      full form is "<n>*<m>element" indicating at least <n> and at most\n      <m> occurrences of element.\n';

  /**
   * A plain-form replay body of 20 `chunk`s that records each one pulled and whether the
   * rest was cancelled. Nothing is pulled until a read asks, so the one chunk the request
   * deadline's passthrough prefetches is the most an unread body loses.
   */
  const tracked = (contentType: string, chunk = 'x'.repeat(65_536)) => {
    const stats = { pulled: 0, cancelled: false };
    const bytes = new TextEncoder().encode(chunk);
    const respond: FetchMockResponder = () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (stats.pulled === 20) return controller.close();
              stats.pulled++;
              controller.enqueue(bytes);
            },
            cancel() {
              stats.cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': contentType, 'x-archive-guessed-charset': 'utf-8' } },
      );
    return { stats, respond };
  };
  const original = (body: string, contentType: string) => () =>
    new Response(new TextEncoder().encode(body), { headers: { 'content-type': contentType } });

  it('reads a JSON capture from its id_ form with its own URLs, on both surfaces', async () => {
    const plain = tracked('application/json; charset=utf-8');
    routeRaw(original(GITHUB_JSON, 'application/json; charset=utf-8'));
    routePlain(plain.respond);

    const result = await runToolContract(iaGetSnapshot, GITHUB);

    expect(result.structuredContent).toMatchObject({
      text: GITHUB_JSON,
      replay_url: GITHUB_PLAIN,
      resolved_timestamp: '20200116122222',
      resolved_status: '200',
    });
    expect(contentText(result)).toContain('"current_user_url":"https://api.github.com/user"');
    expect(JSON.stringify(result)).not.toContain('20200116122222/https://api.github.com/user');
    expect(calls(isReplay).map((c) => c.request.url)).toEqual([GITHUB_PLAIN, GITHUB_RAW]);
    expect(plain.stats.cancelled).toBe(true);
    expect(plain.stats.pulled).toBeLessThanOrEqual(1);
  });

  it('keeps a text/plain capture’s line breaks and angle brackets, on both surfaces', async () => {
    routeRaw(original(RFC_2616_RULE, 'text/plain'));
    routePlain(tracked('text/plain').respond);

    const result = await runToolContract(iaGetSnapshot, {
      url: 'https://www.rfc-editor.org/rfc/rfc2616.txt',
      timestamp: '20201230144805',
    });

    expect((result.structuredContent as { text: string }).text).toBe(RFC_2616_RULE);
    expect(contentText(result)).toContain(
      'full form is "\\<n>\\*\\<m>element" indicating at least \\<n> and at most\\\n',
    );
  });

  it('fails a PDF capture as non_text_capture on both surfaces without reading its body', async () => {
    const replayUrl =
      'https://web.archive.org/web/20200101164020/https://www.irs.gov/pub/irs-pdf/f1040.pdf';
    const pdf = tracked('application/pdf', '%PDF-1.7 922 0 obj <</Linearized 1/L 146326>>');
    routePlain(pdf.respond);

    const result = await runToolContract(iaGetSnapshot, {
      url: 'https://www.irs.gov/pub/irs-pdf/f1040.pdf',
      timestamp: '20200101164020',
    });

    const recovery = hint(iaGetSnapshot.errors, 'non_text_capture');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringContaining('application/pdf'),
        data: {
          reason: 'non_text_capture',
          mediaType: 'application/pdf',
          replayUrl,
          recovery: { hint: recovery },
        },
      },
    });
    expect((result.structuredContent as { error: { message: string } }).error.message).toContain(
      replayUrl,
    );
    const text = contentText(result);
    expect(text).toContain('application/pdf');
    expect(text).toContain(`Recovery: ${recovery}`);
    expect(`${JSON.stringify(result.structuredContent)}${text}`).not.toContain('%PDF');
    expect(calls(isReplay)).toHaveLength(1);
    expect(pdf.stats.cancelled).toBe(true);
    expect(pdf.stats.pulled).toBeLessThanOrEqual(1);
  });

  it('extracts a text/html capture declaring no charset from the plain form alone, as before', async () => {
    const html = '<html><body>The Rest \xa9 1997-99 Rob Malda</body></html>';
    routeReplay(
      replay(
        Uint8Array.from(html, (c) => c.charCodeAt(0)),
        {
          'x-archive-guessed-charset': 'latin1',
        },
      ),
    );

    const result = await runToolContract(iaGetSnapshot, {
      url: 'http://www.slashdot.org/',
      timestamp: '19990125103314',
    });

    expect((result.structuredContent as { text: string }).text).toBe(
      'The Rest © 1997-99 Rob Malda',
    );
    expect(calls(isReplay)).toHaveLength(1);
  });

  it('retries an id_ 503 as it does a plain one, without requesting the plain form again', async () => {
    routeRaw(() => new Response('Service Unavailable', { status: 503 }));
    routePlain(tracked('application/json').respond);

    const result = await runWithRetries(() => runToolContract(iaGetSnapshot, GITHUB));

    const recovery = hint(iaGetSnapshot.errors, 'content_fetch_failed');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'content_fetch_failed', recovery: { hint: recovery } },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${recovery}`);
    expect(calls(isRaw)).toHaveLength(4);
    expect(calls(isReplay)).toHaveLength(5);
  });

  it.each([
    ['a 404', () => new Response('Not Found', { status: 404 })],
    ['a 403', () => new Response('Forbidden', { status: 403 })],
    ['a 451', () => new Response('Unavailable', { status: 451 })],
    ['a 400', () => new Response('Bad Request', { status: 400 })],
    ['an archived 404', archivedError(404, 'Thu, 16 Jan 2020 12:22:22 GMT')],
  ])(
    'answers %s on the id_ form of a capture the plain replay served as content_fetch_failed, after one id_ request',
    async (_label, respond) => {
      routeRaw(respond);
      routePlain(tracked('application/json').respond);

      const result = await runToolContract(iaGetSnapshot, GITHUB);

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringContaining(GITHUB_RAW),
          data: {
            reason: 'content_fetch_failed',
            retryable: false,
            recovery: { hint: expect.stringContaining(GITHUB_PLAIN) },
          },
        },
      });
      const text = contentText(result);
      expect(text).toContain('Recovery: Wayback replayed this capture');
      expect(text).not.toMatch(/does not serve captures|No capture found|error page/);
      expect(calls(isRaw)).toHaveLength(1);
    },
  );

  it('answers an id_ body that stalls with content_fetch_failed after one id_ request, within one request timeout', async () => {
    routeRaw(stall('{"current_user_url"'));
    routePlain(tracked('application/json').respond);
    vi.useFakeTimers();
    const start = Date.now();

    const pending = runToolContract(iaGetSnapshot, GITHUB);
    await vi.runAllTimersAsync();
    const result = await pending;

    const recovery = hint(iaGetSnapshot.errors, 'content_fetch_failed');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'content_fetch_failed', recovery: { hint: recovery } },
      },
    });
    expect(calls(isRaw)).toHaveLength(1);
    expect(Date.now() - start).toBeLessThanOrEqual(30_000);
  });

  it('keeps a caller cancellation during the id_ fetch a cancellation', async () => {
    routeRaw(hang);
    routePlain(tracked('application/json').respond);
    const controller = new AbortController();

    const pending = runToolContract(iaGetSnapshot, GITHUB, {
      context: { signal: controller.signal },
    });
    await vi.waitFor(() => expect(calls(isRaw)).toHaveLength(1));
    controller.abort();
    const result = await pending;

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(
      (result.structuredContent as { error: { data?: { reason?: string } } }).error.data?.reason,
    ).toBeUndefined();
    expect(calls(isReplay)).toHaveLength(2);
  });
});

describe('ia_get_snapshot paging (#44)', () => {
  const PAGE = getServerConfig().maxSnapshotChars;
  const WW2 = { url: 'https://en.wikipedia.org/wiki/World_War_II', timestamp: '20200101030920' };
  /** The length of the World War II capture's text; each position's letter follows from its index. */
  const TEXT = Array.from({ length: 177_671 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(
    '',
  );
  type Page = {
    text: string;
    char_offset: number;
    max_chars: number;
    has_more: boolean;
    total_chars: number;
    notice?: string;
  };

  it('walks a capture’s text in pages that join with no gap or overlap, one replay request each, on both surfaces', async () => {
    routeReplay(replay(`<html><body><p>${TEXT}</p></body></html>`));

    const pages: { page: Page; content: string }[] = [];
    for (let char_offset = 0; char_offset < TEXT.length; char_offset += PAGE) {
      const result = await runToolContract(iaGetSnapshot, {
        ...WW2,
        ...(char_offset > 0 && { char_offset }),
      });
      pages.push({ page: result.structuredContent as Page, content: contentText(result) });
    }

    expect(pages.map(({ page }) => page.text).join('')).toBe(TEXT);
    expect(calls(isReplay)).toHaveLength(pages.length);
    pages.forEach(({ page, content }, i) => {
      const last = i === pages.length - 1;
      expect(page).toMatchObject({
        char_offset: i * PAGE,
        max_chars: PAGE,
        has_more: !last,
        total_chars: 177_671,
      });
      expect(content).toContain('**Total Chars:** 177,671');
      if (last) {
        expect(page.notice).toBeUndefined();
        expect(content).toContain('end of text');
      } else {
        expect(page.notice).toContain(`char_offset ${(i + 1) * PAGE}`);
        expect(page.notice).toContain('timestamp 20200101030920');
        expect(content).toContain(page.notice);
      }
    });
  });

  it('serves empty text with has_more false past the end', async () => {
    routeReplay(replay(`<p>${TEXT}</p>`));

    const result = await runToolContract(iaGetSnapshot, { ...WW2, char_offset: 177_671 });

    expect(result.structuredContent).toMatchObject({
      text: '',
      char_offset: 177_671,
      has_more: false,
      total_chars: 177_671,
    });
  });

  it('counts only the text of the first 4 MiB of a longer page, keeping its notice beside the next page’s', async () => {
    const CHUNK = 65_536;
    const unit = new TextEncoder().encode('<p>word</p>');
    const chunk = new Uint8Array(CHUNK).fill(0x20);
    for (let at = 0; at + unit.length <= CHUNK; at += unit.length) chunk.set(unit, at);
    let pulled = 0;
    routeReplay(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled++ === 200) return controller.close();
              controller.enqueue(chunk);
            },
          }),
          { headers: { 'content-type': 'text/html' } },
        ),
    );

    const result = await runToolContract(iaGetSnapshot, {
      url: 'https://edition.cnn.com/',
      timestamp: '20240601000205',
    });

    // 4 MiB is 64 whole chunks of 5,957 paragraphs each: that many words, one space apart.
    const words = Math.floor(CHUNK / unit.length) * 64;
    const sc = result.structuredContent as Page;
    expect(sc.total_chars).toBe(words * 4 + (words - 1));
    expect(sc.text).toHaveLength(PAGE);
    expect(sc.has_more).toBe(true);
    expect(sc.notice).toContain('first 4,194,304 bytes');
    expect(sc.notice).toContain(`char_offset ${PAGE}`);
    expect(contentText(result)).toContain(sc.notice);
  });

  it('pages the text of a capture read from its id_ form too', async () => {
    const json = JSON.stringify({ items: TEXT });
    routeReplay((request) =>
      request.url.includes('20200116122222id_/')
        ? new Response(new TextEncoder().encode(json), {
            headers: { 'content-type': 'application/json' },
          })
        : new Response(new TextEncoder().encode('rewritten'), {
            headers: { 'content-type': 'application/json' },
          }),
    );

    const result = await runToolContract(iaGetSnapshot, {
      url: 'https://api.github.com/',
      timestamp: '20200116122222',
      char_offset: 3,
      max_chars: 20,
    });

    expect(result.structuredContent).toMatchObject({
      text: json.slice(3, 23),
      char_offset: 3,
      max_chars: 20,
      has_more: true,
      total_chars: json.length,
    });
  });

  it('fails a non-text capture as non_text_capture whatever page it asks for', async () => {
    routeReplay(
      () =>
        new Response(new TextEncoder().encode('%PDF-1.7'), {
          headers: { 'content-type': 'application/pdf' },
        }),
    );

    const result = await runToolContract(iaGetSnapshot, {
      url: 'https://www.irs.gov/pub/irs-pdf/f1040.pdf',
      timestamp: '20200101164020',
      char_offset: 999_999_999,
      max_chars: 1,
    });

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'non_text_capture' } },
    });
  });
});

describe('ia_get_snapshot links (#67)', () => {
  const CERN = {
    url: 'http://info.cern.ch/hypertext/WWW/TheProject.html',
    timestamp: '20151231164925',
  };
  /** The page markup of the CERN capture at 20151231164925 as Wayback replays it, its hrefs as rewritten. */
  const CERN_PAGE = `<header>
<title>The World Wide Web project</title>
<nextid n="55">
</header>
<body>
<h1>World Wide Web</h1>The WorldWideWeb (W3) is a wide-area<a name="0" href="WhatIs.html">
hypermedia</a> information retrieval
initiative aiming to give universal
access to a large universe of documents.<p>
Everything there is online about
W3 is linked directly or indirectly
to this document, including an <a name="24" href="Summary.html">executive
summary</a> of the project, <a name="29" href="Administration/Mailing/Overview.html">Mailing lists</a>
, <a name="30" href="Policy.html">Policy</a> , November's  <a name="34" href="News/9211.html">W3  news</a> ,
<a name="41" href="FAQ/List.html">Frequently Asked Questions</a> .
<dl>
<dt><a name="44" href="/web/20151231164925/http://info.cern.ch/hypertext/DataSources/Top.html">What's out there?</a>
<dd> Pointers to the
world's online information,<a name="45" href="/web/20151231164925/http://info.cern.ch/hypertext/DataSources/bySubject/Overview.html"> subjects</a>
, <a name="z54" href="/web/20151231164925/http://info.cern.ch/hypertext/DataSources/WWW/Servers.html">W3 servers</a>, etc.
<dt><a name="46" href="Help.html">Help</a>
<dd> on the browser you are using
<dt><a name="13" href="Status.html">Software Products</a>
<dd> A list of W3 project
components and their current state.
(e.g. <a name="27" href="LineMode/Browser.html">Line Mode</a> ,X11 <a name="35" href="Status.html#35">Viola</a> ,  <a name="26" href="NeXT/WorldWideWeb.html">NeXTStep</a>
, <a name="25" href="Daemon/Overview.html">Servers</a> , <a name="51" href="Tools/Overview.html">Tools</a> ,<a name="53" href="MailRobot/Overview.html"> Mail robot</a> ,<a name="52" href="Status.html#57">
Library</a> )
<dt><a name="47" href="Technical.html">Technical</a>
<dd> Details of protocols, formats,
program internals etc
<dt><a name="40" href="Bibliography.html">Bibliography</a>
<dd> Paper documentation
on  W3 and references.
<dt><a name="14" href="People.html">People</a>
<dd> A list of some people involved
in the project.
<dt><a name="15" href="History.html">History</a>
<dd> A summary of the history
of the project.
<dt><a name="37" href="Helping.html">How can I help</a> ?
<dd> If you would like
to support the web..
<dt><a name="48" href="/web/20151231164925/http://info.cern.ch/hypertext/README.html">Getting code</a>
<dd> Getting the code by<a name="49" href="LineMode/Defaults/Distribution.html">
anonymous FTP</a> , etc.</a>
</dl>
</body>`;
  const WWW = 'http://info.cern.ch/hypertext/WWW/';
  const DATA = 'http://info.cern.ch/hypertext/DataSources/';
  /** The page's 23 targets in document order: Status.html#35 and #57 fold into Status.html. */
  const CERN_URLS = [
    `${WWW}WhatIs.html`,
    `${WWW}Summary.html`,
    `${WWW}Administration/Mailing/Overview.html`,
    `${WWW}Policy.html`,
    `${WWW}News/9211.html`,
    `${WWW}FAQ/List.html`,
    `${DATA}Top.html`,
    `${DATA}bySubject/Overview.html`,
    `${DATA}WWW/Servers.html`,
    `${WWW}Help.html`,
    `${WWW}Status.html`,
    `${WWW}LineMode/Browser.html`,
    `${WWW}NeXT/WorldWideWeb.html`,
    `${WWW}Daemon/Overview.html`,
    `${WWW}Tools/Overview.html`,
    `${WWW}MailRobot/Overview.html`,
    `${WWW}Technical.html`,
    `${WWW}Bibliography.html`,
    `${WWW}People.html`,
    `${WWW}History.html`,
    `${WWW}Helping.html`,
    'http://info.cern.ch/hypertext/README.html',
    `${WWW}LineMode/Defaults/Distribution.html`,
  ];
  type Link = { text: string; url: string };
  type Page = {
    text: string;
    char_offset: number;
    has_more: boolean;
    total_chars: number;
    links?: Link[];
    total_links?: number;
    notice?: string;
  };
  const read = async (input: Record<string, unknown> = {}) => {
    const result = await runToolContract(iaGetSnapshot, { ...CERN, ...input });
    expect(result.isError).toBeFalsy();
    return { page: result.structuredContent as Page, content: contentText(result) };
  };

  it('lists the CERN capture’s 23 link targets, resolved and folded, from its one replay request, on both surfaces', async () => {
    routeReplay(replay(CERN_PAGE));

    const { page, content } = await read({ include_links: true });

    expect(calls(isReplay)).toHaveLength(1);
    expect(page.links?.map((l) => l.url)).toEqual(CERN_URLS);
    expect(page.total_links).toBe(23);
    expect(page.links?.[0]).toStrictEqual({ text: 'hypermedia', url: `${WWW}WhatIs.html` });
    expect(page.links).toContainEqual({ text: "What's out there?", url: `${DATA}Top.html` });
    expect(page.links?.filter((l) => l.url.startsWith(`${WWW}Status.html`))).toStrictEqual([
      { text: 'Software Products', url: `${WWW}Status.html` },
    ]);
    // Each label reads in the page text as it does in the list.
    for (const l of page.links ?? []) expect(page.text).toContain(l.text);
    expect(content).toContain(
      `**Links on this page:** 23 of 23\n\n- [hypermedia](<${WWW}WhatIs.html>)\n- [executive summary](<${WWW}Summary.html>)`,
    );
    expect(content).toContain(`- [What's out there?](<${DATA}Top.html>)`);
  });

  it('without include_links, sends the same one request and answers the same but for links and total_links', async () => {
    routeReplay(replay(CERN_PAGE));

    const without = await read();
    const withLinks = await read({ include_links: true });

    expect(calls(isReplay)).toHaveLength(2);
    expect(Object.keys(without.page)).not.toContain('links');
    expect(Object.keys(without.page)).not.toContain('total_links');
    const { links: _links, total_links: _total, ...rest } = withLinks.page;
    expect(rest).toStrictEqual(without.page);
    expect(
      withLinks.content.slice(0, withLinks.content.indexOf('\n\n**Links on this page:**')),
    ).toBe(without.content);
  });

  it('gives each link to one page of a read that follows has_more, every next-page notice naming include_links', async () => {
    routeReplay(replay(CERN_PAGE));

    const seen: Link[] = [];
    let pages = 0;
    for (let char_offset = 0; ; char_offset += 300) {
      const { page, content } = await read({ include_links: true, char_offset, max_chars: 300 });
      pages++;
      expect(page.total_links).toBe(23);
      seen.push(...(page.links ?? []));
      if (!page.has_more) break;
      expect(page.notice).toContain(`char_offset ${char_offset + 300}, and include_links true`);
      expect(content).toContain(page.notice);
    }

    expect(pages).toBeGreaterThan(3);
    expect(calls(isReplay)).toHaveLength(pages);
    expect(seen.map((l) => l.url)).toEqual(CERN_URLS);
  });

  it('lists no links for a capture that is not HTML, sending the same requests as without', async () => {
    const json = JSON.stringify({
      see: 'https://example.com/',
      a: '<a href="https://example.com/">x</a>',
    });
    routeReplay((request) =>
      request.url.includes('20200116122222id_/')
        ? new Response(new TextEncoder().encode(json), {
            headers: { 'content-type': 'application/json' },
          })
        : new Response(new TextEncoder().encode('rewritten'), {
            headers: { 'content-type': 'application/json' },
          }),
    );
    const github = { url: 'https://api.github.com/', timestamp: '20200116122222' };

    const without = await runToolContract(iaGetSnapshot, github);
    const sentWithout = calls(isReplay).length;
    const withLinks = await runToolContract(iaGetSnapshot, { ...github, include_links: true });

    expect(sentWithout).toBe(2);
    expect(calls(isReplay)).toHaveLength(4);
    expect(withLinks.structuredContent).toMatchObject({ text: json, links: [], total_links: 0 });
    expect(contentText(withLinks)).toContain('**Links on this page:** 0 of 0');
    expect(without.structuredContent).not.toHaveProperty('links');
  });

  it('resolves relative hrefs against the capture an archived redirect led to, leaving that page out, on both surfaces', async () => {
    const asked = 'https://web.archive.org/web/20240515003448/http://example.com/';
    const target = 'https://web.archive.org/web/20240515003448/http://example.com/home/index.html';
    http.route({
      match: asked,
      respond: archivedRedirect(
        302,
        'Wed, 15 May 2024 00:34:48 GMT',
        '/web/20240515003448/http://example.com/home/index.html',
      ),
    });
    http.route({
      match: target,
      respond: replay('<a href="about.html">About</a> <a href="index.html">Home</a>'),
    });
    routeUnrouted();

    const result = await runToolContract(iaGetSnapshot, {
      url: 'http://example.com/',
      timestamp: '20240515003448',
      include_links: true,
    });

    expect(result.isError).toBeFalsy();
    const page = result.structuredContent as Page & { replay_url: string };
    expect(page.replay_url).toBe(target);
    expect(page.links).toStrictEqual([
      { text: 'About', url: 'http://example.com/home/about.html' },
    ]);
    expect(page.total_links).toBe(1);
    expect(contentText(result)).toContain(
      '**Links on this page:** 1 of 1\n\n- [About](<http://example.com/home/about.html>)',
    );
    expect(replayUrls()).toEqual([asked, target]);
  });
});

describe('Wayback failures that keep their current handling', () => {
  it('ia_find_snapshots closest mode returns a non-200 fallback capture with its statuscode', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(cdxRows(['20190102065701', 'http://www.google.com:80/foo', '404']));

    const result = await runToolContract(iaFindSnapshots, {
      url: 'www.google.com/foo',
      mode: 'closest',
      timestamp: '20190102',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      snapshots: [{ timestamp: '20190102065701', statuscode: '404' }],
    });
    expect(contentText(result)).toContain('**Status:** 404');
    expect(calls(isReplay)).toHaveLength(0);
  });

  it('ia_get_snapshot reports a replay 404 without Memento-Datetime as no_snapshot_available after one request', async () => {
    routeReplay(
      () =>
        new Response('<html><body>Wayback Machine has not archived that URL.</body></html>', {
          status: 404,
        }),
    );

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, {
        url: 'thisurldoesnotexistinwaybackmachine99999.com',
        timestamp: '20200601000000',
      }),
    );

    const recovery = hint(iaGetSnapshot.errors, 'no_snapshot_available');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringContaining('20200601000000'),
        data: { reason: 'no_snapshot_available', recovery: { hint: recovery } },
      },
    });
    const data = (result.structuredContent as { error: { data: object } }).error.data;
    expect(data).not.toHaveProperty('body');
    expect(data).not.toHaveProperty('responseBody');
    expect(calls(isReplay)).toHaveLength(1);
  });

  it.each([
    [
      'CDX history',
      isCdx,
      (signal: AbortSignal) =>
        runToolContract(
          iaFindSnapshots,
          { url: 'example.com', mode: 'history' },
          { context: { signal } },
        ),
    ],
    [
      'the replay fetch',
      isReplay,
      (signal: AbortSignal) =>
        runToolContract(
          iaGetSnapshot,
          { url: 'example.com', timestamp: '20200104000551' },
          { context: { signal } },
        ),
    ],
  ] as const)(
    'keeps a caller cancellation during %s a cancellation after one request',
    async (_label, match, run) => {
      http.route({ match, respond: hang });
      const controller = new AbortController();
      const pending = run(controller.signal);

      await vi.waitFor(() => expect(calls(match)).toHaveLength(1));
      controller.abort();
      const result = await pending;

      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      expect(
        (result.structuredContent as { error: { data?: { reason?: string } } }).error.data?.reason,
      ).toBeUndefined();
      expect(calls(match)).toHaveLength(1);
    },
  );
});

describe('Wayback timeouts and network errors surface under the declared reason', () => {
  /** IA_REQUEST_TIMEOUT_MS at its default. */
  const REQUEST_TIMEOUT_MS = 30_000;

  /** Runs a tool under fake timers to completion, reporting the fake time it took. */
  const runTimed = async (run: () => Promise<ToolResult>) => {
    vi.useFakeTimers();
    const start = Date.now();
    const pending = run();
    await vi.runAllTimersAsync();
    const result = await pending;
    return { result, elapsedMs: Date.now() - start };
  };

  const history = () => runToolContract(iaFindSnapshots, { url: 'example.com', mode: 'history' });
  const findClosest = () =>
    runToolContract(iaFindSnapshots, {
      url: 'example.com',
      mode: 'closest',
      timestamp: '20200101',
    });
  const getClosest = () =>
    runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '20200101' });
  const getExact = () =>
    runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '20200104000551' });

  const expectDeclared = (result: ToolResult, reason: string, recovery: string) => {
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason, recovery: { hint: recovery } },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${recovery}`);
    expect(contentText(result)).not.toContain('not retryable');
  };

  describe.each([
    ['headers never arrive', hang],
    ['the body stalls', stall('[["timestamp"')],
  ])('when %s', (_label, respond) => {
    it('CDX history answers cdx_unavailable after one request, within one request timeout', async () => {
      routeCdx(respond);

      const { result, elapsedMs } = await runTimed(history);

      expectDeclared(result, 'cdx_unavailable', hint(iaFindSnapshots.errors, 'cdx_unavailable'));
      expect(calls(isCdx)).toHaveLength(1);
      expect(elapsedMs).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
    });

    it('the Availability API answers availability_unavailable after one request, with no fallback', async () => {
      routeAvailability(respond);

      const { result, elapsedMs } = await runTimed(findClosest);

      expectDeclared(
        result,
        'availability_unavailable',
        hint(iaFindSnapshots.errors, 'availability_unavailable'),
      );
      expect(calls(isAvailability)).toHaveLength(1);
      expect(calls(isCdx)).toHaveLength(0);
      expect(elapsedMs).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
    });

    it('ia_get_snapshot answers an Availability timeout as content_fetch_failed after one request', async () => {
      routeAvailability(respond);

      const { result } = await runTimed(getClosest);

      expectDeclared(
        result,
        'content_fetch_failed',
        hint(iaGetSnapshot.errors, 'content_fetch_failed'),
      );
      expect(calls(isAvailability)).toHaveLength(1);
      expect(calls(isCdx)).toHaveLength(0);
      expect(calls(isReplay)).toHaveLength(0);
    });

    it('the replay fetch answers content_fetch_failed after one request', async () => {
      routeReplay(respond);

      const { result, elapsedMs } = await runTimed(getExact);

      expectDeclared(
        result,
        'content_fetch_failed',
        hint(iaGetSnapshot.errors, 'content_fetch_failed'),
      );
      expect(calls(isReplay)).toHaveLength(1);
      expect(elapsedMs).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
    });
  });

  it('the replay fetch answers on the lookup path too, after one replay request', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(cdxRows(['20200101231916', 'https://example.com/', '200']));
    routeReplay(hang);

    const { result } = await runTimed(getClosest);

    expectDeclared(
      result,
      'content_fetch_failed',
      hint(iaGetSnapshot.errors, 'content_fetch_failed'),
    );
    expect(calls(isReplay)).toHaveLength(1);
  });

  it.each([
    ['CDX history', 'cdx_unavailable', isCdx, history, iaFindSnapshots],
    [
      'the Availability API',
      'availability_unavailable',
      isAvailability,
      findClosest,
      iaFindSnapshots,
    ],
    ['ia_get_snapshot’s lookup', 'content_fetch_failed', isAvailability, getClosest, iaGetSnapshot],
    ['the replay fetch', 'content_fetch_failed', isReplay, getExact, iaGetSnapshot],
  ] as const)(
    'a refused connection to %s surfaces as %s after four attempts',
    async (_label, reason, match, run, def) => {
      http.route({ match, respond: refused });

      const { result } = await runTimed(run);

      expectDeclared(result, reason, hint(def.errors, reason));
      expect(calls(match)).toHaveLength(4);
      expect(http.calls).toHaveLength(4);
    },
  );

  it.each([
    ['CDX history', 'cdx_unavailable', isCdx, history, iaFindSnapshots],
    [
      'the Availability API',
      'availability_unavailable',
      isAvailability,
      findClosest,
      iaFindSnapshots,
    ],
    ['ia_get_snapshot’s lookup', 'content_fetch_failed', isAvailability, getClosest, iaGetSnapshot],
    ['the replay fetch', 'content_fetch_failed', isReplay, getExact, iaGetSnapshot],
  ] as const)(
    'a connection dropped mid-body by %s surfaces as %s after four attempts',
    async (_label, reason, match, run, def) => {
      http.route({ match, respond: dropped('[["timestamp"') });

      const { result } = await runTimed(run);

      expectDeclared(result, reason, hint(def.errors, reason));
      expect(calls(match)).toHaveLength(4);
      expect(http.calls).toHaveLength(4);
    },
  );

  it('a CDX fallback dropped mid-body surfaces as cdx_unavailable after one request', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(dropped('[["timestamp"'));

    const { result } = await runTimed(findClosest);

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(FALLBACK_MESSAGE),
        data: { reason: 'cdx_unavailable' },
      },
    });
    expect(calls(isCdx)).toHaveLength(1);
  });

  it('a CDX history redirect loop surfaces as cdx_unavailable naming it, after one ladder attempt', async () => {
    routeCdx((request) => new Response(null, { status: 302, headers: { location: request.url } }));

    const { result } = await runTimed(history);

    expectDeclared(result, 'cdx_unavailable', hint(iaFindSnapshots.errors, 'cdx_unavailable'));
    expect((result.structuredContent as { error: { message: string } }).error.message).toBe(
      'CDX API redirected more than 127 times.',
    );
    expect(contentText(result)).not.toContain('Request the final URL directly');
    // The request and the 127 redirects followed before fetchWithTimeout refused the chain.
    expect(calls(isCdx)).toHaveLength(128);
  });

  const toItself: FetchMockResponder = (request) =>
    new Response(null, { status: 302, headers: { location: request.url } });
  const toFtp: FetchMockResponder = () =>
    new Response(null, { status: 302, headers: { location: 'ftp://archive.org/cdx' } });

  it.each([
    ['ia_find_snapshots closest mode', 'availability_unavailable', findClosest, iaFindSnapshots],
    ['ia_get_snapshot', 'content_fetch_failed', getClosest, iaGetSnapshot],
  ] as const)(
    'an Availability API redirect loop under %s surfaces as %s naming it, with no CDX fallback',
    async (_label, reason, run, def) => {
      routeAvailability(toItself);

      const { result } = await runTimed(run);

      expectDeclared(result, reason, hint(def.errors, reason));
      expect((result.structuredContent as { error: { message: string } }).error.message).toBe(
        'Availability API redirected more than 127 times.',
      );
      expect(JSON.stringify(result)).not.toContain('final URL directly');
      // The request and the 127 redirects followed before fetchWithTimeout refused the chain.
      expect(calls(isAvailability)).toHaveLength(128);
      expect(calls(isCdx)).toHaveLength(0);
    },
  );

  it('a CDX history redirect to an ftp: URL surfaces as cdx_unavailable naming it, after one request', async () => {
    routeCdx(toFtp);

    const { result } = await runTimed(history);

    expectDeclared(result, 'cdx_unavailable', hint(iaFindSnapshots.errors, 'cdx_unavailable'));
    expect((result.structuredContent as { error: { message: string } }).error.message).toBe(
      'CDX API redirected to a URL that is not HTTP or HTTPS.',
    );
    expect(JSON.stringify(result)).not.toContain('Pass an absolute http:// or https:// URL');
    expect(http.calls).toHaveLength(1);
  });

  describe('a closest-mode CDX check that gets no answer names what CDX did', () => {
    const EMPTY_THEN =
      'The Availability API found no capture of example.com near 20200101, and the CDX closest-capture check did not complete: ';
    const FAILED_THEN =
      'The closest-capture lookup for example.com near 20200101 did not complete: Availability API returned HTTP 503. (failed after 4 attempts) The CDX closest-capture check it fell back to did not complete either: ';
    /** The hint a lookup that could not answer carries: no answer was a refusal or a 429. */
    const RETRY_LATER =
      'Retry later, or list nearby captures with ia_find_snapshots in history mode, passing from and to around the timestamp, then read one with ia_get_snapshot and its exact 14-digit timestamp, which needs no lookup.';

    const expectLookupFailure = (result: ToolResult, reason: string, message: string) => {
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message,
          data: { reason, recovery: { hint: RETRY_LATER } },
        },
      });
      const text = contentText(result);
      expect(text).toContain(`Error: ${message}`);
      expect(text).toContain(`Recovery: ${RETRY_LATER}`);
      expect(text).toContain(`(reason ${reason})`);
      expect(text).not.toContain('not retryable');
    };

    it.each([
      ['a redirect loop', toItself, 'CDX API redirected more than 127 times.', 128],
      [
        'a redirect to an ftp: URL',
        toFtp,
        'CDX API redirected to a URL that is not HTTP or HTTPS.',
        1,
      ],
      ['a refused connection', refused, 'CDX API could not be reached (network error).', 1],
      [
        'a connection dropped mid-body',
        dropped('[["timestamp"'),
        'CDX API could not be reached (network error).',
        1,
      ],
    ] as const)(
      'after an empty Availability answer, %s is cdx_unavailable naming it',
      async (_label, respond, what, cdxRequests) => {
        routeAvailability(EMPTY_AVAILABILITY);
        routeCdx(respond);

        const { result } = await runTimed(findClosest);

        expectLookupFailure(result, 'cdx_unavailable', `${EMPTY_THEN}${what}`);
        expect(JSON.stringify(result)).not.toMatch(
          /final URL directly|Pass an absolute|possible redirect loop|Only HTTP|Network error during/,
        );
        expect(calls(isAvailability)).toHaveLength(1);
        expect(calls(isCdx)).toHaveLength(cdxRequests);
      },
    );

    it.each([
      ['the 25 s ceiling', REQUEST_TIMEOUT_MS, 25_000],
      ['a 10 s request timeout', 10_000, 10_000],
    ])(
      'after an empty Availability answer, a timeout under %s is cdx_unavailable naming the limit the check was sent under',
      async (_label, requestTimeoutMs, limitMs) => {
        const config = getServerConfig();
        const configured = config.requestTimeoutMs;
        config.requestTimeoutMs = requestTimeoutMs;
        try {
          routeAvailability(EMPTY_AVAILABILITY);
          routeCdx(hang);

          const { result, elapsedMs } = await runTimed(findClosest);

          // The one CDX request ran exactly its limit, and the message states that figure.
          expect(elapsedMs).toBe(limitMs);
          expectLookupFailure(
            result,
            'cdx_unavailable',
            `${EMPTY_THEN}CDX API timed out after ${elapsedMs / 1000} s.`,
          );
          expect(JSON.stringify(result)).not.toContain('fetch GET');
          expect(calls(isCdx)).toHaveLength(1);
        } finally {
          config.requestTimeoutMs = configured;
        }
      },
    );

    it('after four Availability 503s, a CDX redirect loop keeps availability_unavailable and names the loop', async () => {
      routeAvailability(UNAVAILABLE);
      routeCdx(toItself);

      const { result } = await runTimed(findClosest);

      expectLookupFailure(
        result,
        'availability_unavailable',
        `${FAILED_THEN}CDX API redirected more than 127 times.`,
      );
      expect(result.structuredContent).toMatchObject({
        error: { data: { status: 503, retryAttempts: 4 } },
      });
      expect(JSON.stringify(result)).not.toMatch(/final URL directly|possible redirect loop/);
      expect(calls(isAvailability)).toHaveLength(4);
      expect(calls(isCdx)).toHaveLength(128);
    });
  });

  it('a replay 504 is retried as before and surfaces as content_fetch_failed', async () => {
    routeReplay(() => new Response('Gateway Timeout', { status: 504 }));

    const result = await runWithRetries(getExact);

    expectDeclared(
      result,
      'content_fetch_failed',
      hint(iaGetSnapshot.errors, 'content_fetch_failed'),
    );
    expect(calls(isReplay)).toHaveLength(4);
    const data = (result.structuredContent as { error: { data: object } }).error.data;
    expect(data).not.toHaveProperty('body');
    expect(data).not.toHaveProperty('responseBody');
  });
});

describe('one call deadline spans every request a Wayback call chains (#55)', () => {
  /** 100 ms inside the default 30 s request timeout. */
  const JUST_INSIDE = 29_900;

  /** The `id_` form of a capture, read after the plain replay of a non-HTML text capture. */
  const isRaw = (r: Request) => /^https:\/\/web\.archive\.org\/web\/\d{14}id_\//.test(r.url);
  const isPlainReplay = (r: Request) => isReplay(r) && !isRaw(r);

  const CDX_CAPTURE = cdxRows(['20200101000000', 'https://example.com/', '200']);

  /** Answers each request with the next responder, repeating the last. */
  const inSequence = (...sequence: FetchMockResponder[]): FetchMockResponder => {
    let n = 0;
    return (request, ...rest) =>
      (sequence[Math.min(n++, sequence.length - 1)] as FetchMockResponder)(request, ...rest);
  };

  const getLookup = (signal?: AbortSignal) =>
    runToolContract(
      iaGetSnapshot,
      { url: 'example.com', timestamp: '2020' },
      signal && { context: { signal } },
    );
  const getExact = (signal?: AbortSignal) =>
    runToolContract(
      iaGetSnapshot,
      { url: 'example.com', timestamp: '20200101000000' },
      signal && { context: { signal } },
    );
  const history = (url = 'example.com', signal?: AbortSignal) =>
    runToolContract(iaFindSnapshots, { url, mode: 'history' }, signal && { context: { signal } });

  const errorOf = (result: ToolResult) =>
    (
      result.structuredContent as {
        error: { code: number; message: string; data?: Record<string, unknown> };
      }
    ).error;

  /** Runs a call to completion on the fake clock, reporting the fake time it took. */
  const runTimed = async (run: () => Promise<ToolResult>) => {
    const start = Date.now();
    const pending = run();
    await vi.runAllTimersAsync();
    const result = await pending;
    return { result, elapsedMs: Date.now() - start };
  };

  /** The declared `reason`, its message naming the deadline, on both surfaces and still retryable. */
  const expectDeadline = (
    result: ToolResult,
    errors: readonly { reason: string; recovery: string }[] | undefined,
    reason: string,
    message: string,
  ) => {
    const recovery = hint(errors, reason);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message,
      data: { reason, recovery: { hint: recovery } },
    });
    expect(errorOf(result).data).not.toHaveProperty('retryable');
    const text = contentText(result);
    expect(text).toContain(`Error: ${message}`);
    expect(text).toContain(`Recovery: ${recovery}`);
    expect(text).not.toMatch(/timed out after|not retryable/);
  };

  const REPLAY_EXPIRED = (near: string, budgetSeconds = 55) =>
    `Could not fetch the archived page for example.com near ${near}: Wayback Machine did not finish within the ${budgetSeconds} s call deadline.`;
  const CDX_EXPIRED = 'CDX API did not finish within the 55 s call deadline.';

  let random: ReturnType<typeof vi.spyOn>;
  let abortTimeout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Backoff without jitter: exactly 1 s, 2 s, then 4 s.
    random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // AbortSignal.timeout on the fake clock too, so a deadline of a path's own can't hide in real time.
    abortTimeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
        ms,
      );
      return controller.signal;
    });
  });

  afterEach(() => {
    random.mockRestore();
    abortTimeout.mockRestore();
  });

  it('fails a slow lookup and the replay after it as content_fetch_failed at 55 s', async () => {
    routeAvailability(answerAfter(JUST_INSIDE, EMPTY_AVAILABILITY));
    routeCdx(answerAfter(24_900, CDX_CAPTURE));
    routeReplay(answerAfter(JUST_INSIDE, UNAVAILABLE));

    const { result, elapsedMs } = await runTimed(() => getLookup());

    // The lookup answers at 54.8 s, leaving the replay 0.2 s.
    expect(elapsedMs).toBe(55_000);
    expectDeadline(result, iaGetSnapshot.errors, 'content_fetch_failed', REPLAY_EXPIRED('2020'));
    expect(calls(isAvailability)).toHaveLength(1);
    expect(calls(isCdx)).toHaveLength(1);
    expect(calls(isReplay)).toHaveLength(1);
  });

  it('fails the id_ read of a text capture after a slow lookup as content_fetch_failed at 55 s', async () => {
    routeAvailability(answerAfter(JUST_INSIDE, EMPTY_AVAILABILITY));
    routeCdx(answerAfter(24_900, CDX_CAPTURE));
    http.route({
      match: isPlainReplay,
      respond: () => new Response('plain text body', { headers: { 'content-type': 'text/plain' } }),
    });
    http.route({ match: isRaw, respond: answerAfter(JUST_INSIDE, UNAVAILABLE) });

    const { result, elapsedMs } = await runTimed(() => getLookup());

    expect(elapsedMs).toBe(55_000);
    expectDeadline(result, iaGetSnapshot.errors, 'content_fetch_failed', REPLAY_EXPIRED('2020'));
    expect(calls(isPlainReplay)).toHaveLength(1);
    expect(calls(isRaw)).toHaveLength(1);
  });

  it('fails an exact timestamp whose replay answers 503 just inside the request timeout at 55 s, after two requests', async () => {
    routeReplay(answerAfter(JUST_INSIDE, UNAVAILABLE));

    const { result, elapsedMs } = await runTimed(() => getExact());

    // The second attempt, sent at 30.9 s, gets the 24.1 s that remain.
    expect(elapsedMs).toBe(55_000);
    expectDeadline(
      result,
      iaGetSnapshot.errors,
      'content_fetch_failed',
      REPLAY_EXPIRED('20200101000000'),
    );
    expect(calls(isReplay)).toHaveLength(2);
  });

  it('fails history mode cut mid-request as cdx_unavailable at 55 s, never a bare Timeout', async () => {
    routeCdx(inSequence(answerAfter(JUST_INSIDE, UNAVAILABLE), hang));

    const { result, elapsedMs } = await runTimed(() => history());

    expect(elapsedMs).toBe(55_000);
    expectDeadline(result, iaFindSnapshots.errors, 'cdx_unavailable', CDX_EXPIRED);
    expect(calls(isCdx)).toHaveLength(2);
  });

  it('fails history mode cut mid-backoff as cdx_unavailable at 55 s, never a bare Timeout', async () => {
    // Attempts end at 26 s and 53 s; the 2 s backoff after the second lands on the deadline.
    routeCdx(answerAfter(26_000, UNAVAILABLE));

    const { result, elapsedMs } = await runTimed(() => history());

    expect(elapsedMs).toBe(55_000);
    expectDeadline(result, iaFindSnapshots.errors, 'cdx_unavailable', CDX_EXPIRED);
    expect(calls(isCdx)).toHaveLength(2);
  });

  it('bounds history mode on its legacy path, a wildcard URL, by the same deadline', async () => {
    routeCdx(answerAfter(JUST_INSIDE, UNAVAILABLE));

    const { result, elapsedMs } = await runTimed(() => history('example.com/*'));

    expect(elapsedMs).toBe(55_000);
    expectDeadline(result, iaFindSnapshots.errors, 'cdx_unavailable', CDX_EXPIRED);
    expect(calls(isCdx)).toHaveLength(2);
  });

  it('lets one request run its whole IA_REQUEST_TIMEOUT_MS of 90 s and still ends the call by 90 s', async () => {
    const config = getServerConfig();
    const configured = config.requestTimeoutMs;
    config.requestTimeoutMs = 90_000;
    try {
      routeReplay(answerAfter(89_900, UNAVAILABLE));

      const { result, elapsedMs } = await runTimed(() => getExact());

      // The one request answers at 89.9 s; the 1 s backoff after it would pass the deadline.
      expect(elapsedMs).toBe(89_900);
      expectDeadline(
        result,
        iaGetSnapshot.errors,
        'content_fetch_failed',
        REPLAY_EXPIRED('20200101000000', 90),
      );
      expect(calls(isReplay)).toHaveLength(1);
    } finally {
      config.requestTimeoutMs = configured;
    }
  });

  /** `getExact`'s replay, which Wayback redirects to the nearest capture, and that capture's replay URL. */
  const EXACT_CHAIN = [
    'https://web.archive.org/web/20200101000000/example.com',
    'https://web.archive.org/web/20200101000551/https://example.com/',
  ] as const;

  /** Routes `getExact`'s redirect, answered by `first`, then its target, answered by `second`; any other replay URL draws a 400. */
  const routeRedirectedExact = (first: FetchMockResponder, second: FetchMockResponder) => {
    http.route({ match: EXACT_CHAIN[0], respond: first });
    http.route({ match: EXACT_CHAIN[1], respond: second });
    routeUnrouted();
  };

  it('ends a replay whose redirect target stalls on the call deadline, sending no further hop', async () => {
    routeRedirectedExact(answerAfter(JUST_INSIDE, nearestCapture(EXACT_CHAIN[1])), hang);

    const { result, elapsedMs } = await runTimed(() => getExact());

    expect(elapsedMs).toBe(55_000);
    expectDeadline(
      result,
      iaGetSnapshot.errors,
      'content_fetch_failed',
      REPLAY_EXPIRED('20200101000000'),
    );
    expect(replayUrls()).toEqual(EXACT_CHAIN);
  });

  describe('a caller cancellation stays RequestCancelled, never the deadline', () => {
    /** Aborts the caller's signal at `atMs` of fake time, reporting when the call settled. */
    const cancelAt = async (atMs: number, run: (signal: AbortSignal) => Promise<ToolResult>) => {
      const controller = new AbortController();
      const start = Date.now();
      const pending = run(controller.signal);
      await vi.advanceTimersByTimeAsync(atMs);
      controller.abort();
      const result = await pending;
      return { result, elapsedMs: Date.now() - start };
    };

    const expectCancelled = (result: ToolResult) => {
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(error.data?.reason).toBeUndefined();
      expect(error.message).not.toMatch(/deadline|timed out|did not (finish|complete)/);
      expect(contentText(result)).not.toMatch(/deadline|timed out/);
    };

    it('mid-request, on an attempt the deadline had cut short', async () => {
      routeReplay(inSequence(answerAfter(JUST_INSIDE, UNAVAILABLE), hang));

      const { result, elapsedMs } = await cancelAt(40_000, getExact);

      expectCancelled(result);
      expect(elapsedMs).toBe(40_000);
      expect(calls(isReplay)).toHaveLength(2);
    });

    it('mid-backoff', async () => {
      routeCdx(answerAfter(JUST_INSIDE, UNAVAILABLE));

      const { result, elapsedMs } = await cancelAt(30_400, (signal) =>
        history('example.com', signal),
      );

      expectCancelled(result);
      expect(elapsedMs).toBe(30_400);
      expect(calls(isCdx)).toHaveLength(1);
    });

    it('mid-lookup, during the CDX fallback', async () => {
      routeAvailability(answerAfter(JUST_INSIDE, EMPTY_AVAILABILITY));
      routeCdx(hang);

      const { result, elapsedMs } = await cancelAt(40_000, getLookup);

      expectCancelled(result);
      expect(elapsedMs).toBe(40_000);
      expect(calls(isCdx)).toHaveLength(1);
      expect(calls(isReplay)).toHaveLength(0);
    });

    it('mid-chain, on the request a followed redirect sent, sending no further hop', async () => {
      routeRedirectedExact(nearestCapture(EXACT_CHAIN[1]), hang);

      const { result, elapsedMs } = await cancelAt(10_000, getExact);

      expectCancelled(result);
      expect(elapsedMs).toBe(10_000);
      expect(replayUrls()).toEqual(EXACT_CHAIN);
    });
  });
});

describe('ia_get_snapshot on an archived error capture', () => {
  const recovery = () => hint(iaGetSnapshot.errors, 'no_snapshot_available');

  it.each([
    [503, 'https://httpstat.us/503', '20190419141856', 'Fri, 19 Apr 2019 14:18:56 GMT'],
    [
      429,
      'http://ipv4.google.com:80/sorry/index',
      '20190511051439',
      'Sat, 11 May 2019 05:14:39 GMT',
    ],
    [500, 'https://httpstat.us/500', '20190419141857', 'Fri, 19 Apr 2019 14:18:57 GMT'],
    [404, 'http://google.com:80/foo', '20190102065701', 'Wed, 02 Jan 2019 06:57:01 GMT'],
  ])(
    'answers an archived %i on the exact path as no_snapshot_available after one request',
    async (status, url, timestamp, mementoDatetime) => {
      routeReplay(archivedError(status, mementoDatetime));

      const result = await runWithRetries(() => runToolContract(iaGetSnapshot, { url, timestamp }));

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: expect.stringMatching(new RegExp(`${timestamp}.*HTTP ${status}`)),
          data: { reason: 'no_snapshot_available', recovery: { hint: recovery() } },
        },
      });
      const text = contentText(result);
      expect(text).toContain(timestamp);
      expect(text).toContain(`Recovery: ${recovery()}`);
      const data = (result.structuredContent as { error: { data: object } }).error.data;
      expect(data).not.toHaveProperty('body');
      expect(data).not.toHaveProperty('responseBody');
      expect(calls(isReplay)).toHaveLength(1);
    },
  );

  it('names the capture from Memento-Datetime, not the requested timestamp', async () => {
    routeReplay(archivedError(404, 'Wed, 02 Jan 2019 06:57:01 GMT'));

    const result = await runToolContract(iaGetSnapshot, {
      url: 'http://google.com:80/foo',
      timestamp: '20190102000000',
    });

    expect((result.structuredContent as { error: { message: string } }).error.message).toMatch(
      /20190102065701.*HTTP 404/,
    );
  });

  it('names the raw Memento-Datetime when it is not an HTTP date', async () => {
    routeReplay(archivedError(503, 'not-a-date'));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, {
        url: 'https://httpstat.us/503',
        timestamp: '20190419141856',
      }),
    );

    expect(result.structuredContent).toMatchObject({
      error: {
        message: expect.stringContaining('at not-a-date is an archived HTTP 503'),
        data: { reason: 'no_snapshot_available' },
      },
    });
    expect(calls(isReplay)).toHaveLength(1);
  });

  it('answers an archived 404 reached through the closest lookup as no_snapshot_available', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(cdxRows(['20190102065701', 'http://www.google.com:80/foo', '404']));
    routeReplay(archivedError(404, 'Wed, 02 Jan 2019 06:57:01 GMT'));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'www.google.com/foo', timestamp: '20190102' }),
    );

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringMatching(/20190102065701.*HTTP 404/),
        data: { reason: 'no_snapshot_available', recovery: { hint: recovery() } },
      },
    });
    const data = (result.structuredContent as { error: { data: object } }).error.data;
    expect(data).not.toHaveProperty('body');
    expect(data).not.toHaveProperty('responseBody');
    expect(calls(isReplay)).toHaveLength(1);
  });

  it('answers an archived 503 reached through the closest lookup after one replay request', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(cdxRows(['20190419141856', 'https://httpstat.us/503', '503']));
    routeReplay(archivedError(503, 'Fri, 19 Apr 2019 14:18:56 GMT'));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'httpstat.us/503', timestamp: '2019' }),
    );

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'no_snapshot_available' } },
    });
    expect(calls(isReplay)).toHaveLength(1);
  });
});

describe('ia_get_snapshot on a replay 4xx without Memento-Datetime', () => {
  /** About 500 bytes of Wayback playback HTML, as the error body of a refused replay. */
  const PLAYBACK = `<!DOCTYPE html><html lang="en"><head><title>Wayback Machine</title></head><body>${'<div class="playback">'.repeat(20)}</body></html>`;
  /** Wayback's own answer: the status, its playback page, and no Memento-Datetime. */
  const refused = (status: number) => () =>
    new Response(PLAYBACK, { status, headers: { 'content-type': 'text/html' } });

  const errorOf = (result: ToolResult) =>
    (result.structuredContent as { error: { code: number; message: string; data: object } }).error;

  const expectNoBody = (result: ToolResult) => {
    expect(errorOf(result).data).not.toHaveProperty('body');
    expect(errorOf(result).data).not.toHaveProperty('responseBody');
    expect(JSON.stringify(result.structuredContent)).not.toContain('playback');
    expect(contentText(result)).not.toContain('playback');
  };

  const EXCLUDED_HINT = /no capture of (it|this URL) can be read/i;

  it('answers an excluded site (403) on the exact path as no_snapshot_available with its own hint', async () => {
    routeReplay(refused(403));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, {
        url: 'https://excluded.example.com/',
        timestamp: '20230101000000',
      }),
    );

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringContaining(
          'The Wayback Machine does not serve captures of https://excluded.example.com/',
        ),
        data: {
          reason: 'no_snapshot_available',
          recovery: { hint: expect.stringMatching(EXCLUDED_HINT) },
        },
      },
    });
    const declared = hint(iaGetSnapshot.errors, 'no_snapshot_available');
    expect(contentText(result)).toMatch(EXCLUDED_HINT);
    expect(contentText(result)).not.toContain(declared);
    expectNoBody(result);
    expect(calls(isReplay)).toHaveLength(1);
  });

  it('answers an excluded site reached through the closest lookup the same way', async () => {
    routeAvailability(() =>
      Response.json({
        archived_snapshots: {
          closest: {
            url: 'http://web.archive.org/web/20230101000000/https://excluded.example.com/',
            timestamp: '20230101000000',
            status: '200',
            available: true,
          },
        },
      }),
    );
    routeReplay(refused(403));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'excluded.example.com', timestamp: '2023' }),
    );

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringContaining('does not serve captures of excluded.example.com'),
        data: {
          reason: 'no_snapshot_available',
          recovery: { hint: expect.stringMatching(EXCLUDED_HINT) },
        },
      },
    });
    expectNoBody(result);
    expect(calls(isReplay)).toHaveLength(1);
  });

  it.each([410, 451])(
    'answers a replay %i as a URL the Wayback Machine does not serve',
    async (status) => {
      routeReplay(refused(status));

      const result = await runWithRetries(() =>
        runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '20200104000551' }),
      );

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: expect.stringContaining(
            `does not serve captures of example.com (HTTP ${status})`,
          ),
          data: {
            reason: 'no_snapshot_available',
            recovery: { hint: expect.stringMatching(EXCLUDED_HINT) },
          },
        },
      });
      expectNoBody(result);
      expect(calls(isReplay)).toHaveLength(1);
    },
  );

  it.each([400, 401, 402, 405, 409, 415, 418, 422])(
    'answers a replay %i as no_snapshot_available naming the status, after one request',
    async (status) => {
      routeReplay(refused(status));

      const result = await runWithRetries(() =>
        runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '20200104000551' }),
      );

      const recovery = hint(iaGetSnapshot.errors, 'no_snapshot_available');
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: expect.stringContaining(`HTTP ${status}`),
          data: { reason: 'no_snapshot_available', recovery: { hint: recovery } },
        },
      });
      expect(contentText(result)).toContain(`Recovery: ${recovery}`);
      expectNoBody(result);
      expect(calls(isReplay)).toHaveLength(1);
    },
  );

  it.each([408, 425])(
    'retries a replay %i like a 5xx and surfaces content_fetch_failed',
    async (status) => {
      routeReplay(refused(status));

      const result = await runWithRetries(() =>
        runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '20200104000551' }),
      );

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: {
            reason: 'content_fetch_failed',
            recovery: { hint: hint(iaGetSnapshot.errors, 'content_fetch_failed') },
          },
        },
      });
      expectNoBody(result);
      expect(calls(isReplay)).toHaveLength(4);
    },
  );
});

describe('CDX and Availability API 4xx answers', () => {
  /** What a lookup API sends with a refusal: an archive.org error page, which must stay off the wire. */
  const PAGE = '<!DOCTYPE html><html><body>lookup-error-page-marker</body></html>';
  const refusedWith = (status: number) => () =>
    new Response(PAGE, { status, headers: { 'content-type': 'text/html' } });

  const errorOf = (result: ToolResult) =>
    (result.structuredContent as { error: { code: number; message: string; data: object } }).error;

  const expectNoBody = (result: ToolResult) => {
    expect(errorOf(result).data).not.toHaveProperty('body');
    expect(errorOf(result).data).not.toHaveProperty('responseBody');
    expect(JSON.stringify(result.structuredContent)).not.toContain('lookup-error-page-marker');
    expect(contentText(result)).not.toContain('lookup-error-page-marker');
  };

  const EXCLUDED_HINT = /no capture of (it|this URL) can be read/i;

  /** The excluded-site answer: no_snapshot_available, naming the URL, with the cannot-be-read hint. */
  const expectNotServed = (result: ToolResult, url: string, status: number) => {
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringContaining(
          `The Wayback Machine does not serve captures of ${url} (HTTP ${status}`,
        ),
        data: {
          reason: 'no_snapshot_available',
          recovery: { hint: expect.stringMatching(EXCLUDED_HINT) },
        },
      },
    });
    expect(contentText(result)).toMatch(EXCLUDED_HINT);
    expect(contentText(result)).not.toMatch(/did not complete|retry later/i);
    expectNoBody(result);
  };

  it.each([403, 410, 451])(
    'ia_find_snapshots history answers a CDX %i as a URL the Wayback Machine does not serve, after one request',
    async (status) => {
      routeCdx(refusedWith(status));

      const result = await runWithRetries(() =>
        runToolContract(iaFindSnapshots, { url: 'excluded.example.com', mode: 'history' }),
      );

      expect(calls(isCdx)).toHaveLength(1);
      expectNotServed(result, 'excluded.example.com', status);
    },
  );

  it('ia_find_snapshots closest answers a CDX fallback 403 the same way, not as cdx_unavailable', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(refusedWith(403));

    const result = await runWithRetries(() =>
      runToolContract(iaFindSnapshots, {
        url: 'excluded.example.com',
        mode: 'closest',
        timestamp: '2023',
      }),
    );

    expect(calls(isCdx)).toHaveLength(1);
    expectNotServed(result, 'excluded.example.com', 403);
  });

  it('ia_get_snapshot with a short timestamp answers a CDX fallback 403 the same way, with no replay', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(refusedWith(403));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'excluded.example.com', timestamp: '2023' }),
    );

    expect(calls(isCdx)).toHaveLength(1);
    expect(calls(isReplay)).toHaveLength(0);
    expectNotServed(result, 'excluded.example.com', 403);
  });

  it('ia_find_snapshots closest answers an Availability 403 the same way, with no fallback', async () => {
    routeAvailability(refusedWith(403));

    const result = await runWithRetries(() =>
      runToolContract(iaFindSnapshots, {
        url: 'excluded.example.com',
        mode: 'closest',
        timestamp: '2023',
      }),
    );

    expect(calls(isAvailability)).toHaveLength(1);
    expect(calls(isCdx)).toHaveLength(0);
    expectNotServed(result, 'excluded.example.com', 403);
  });

  it.each([400, 404])(
    'ia_find_snapshots history answers a CDX %i as cdx_unavailable that a retry cannot fix, after one request',
    async (status) => {
      routeCdx(refusedWith(status));

      // The stub refuses any query; a from the handler accepts lets this one reach CDX.
      const result = await runWithRetries(() =>
        runToolContract(iaFindSnapshots, { url: 'example.com', mode: 'history', from: '2015' }),
      );

      expect(calls(isCdx)).toHaveLength(1);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringContaining(`HTTP ${status}`),
          data: {
            reason: 'cdx_unavailable',
            status,
            retryable: false,
            recovery: { hint: expect.stringMatching(/will not help.*from, to, and resume_key/) },
          },
        },
      });
      expect(contentText(result)).not.toContain(hint(iaFindSnapshots.errors, 'cdx_unavailable'));
      expectNoBody(result);
    },
  );

  it('ia_find_snapshots closest answers a CDX fallback 400 without promising a retry', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(refusedWith(400));

    const result = await runWithRetries(() =>
      runToolContract(iaFindSnapshots, {
        url: 'example.com',
        mode: 'closest',
        timestamp: '2023',
      }),
    );

    expect(calls(isCdx)).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(FALLBACK_MESSAGE),
        data: {
          reason: 'cdx_unavailable',
          retryable: false,
          recovery: { hint: expect.stringContaining('history mode') },
        },
      },
    });
    expect(contentText(result)).not.toMatch(/retry later/i);
    expectNoBody(result);
  });

  it.each([
    ['ia_find_snapshots', 'availability_unavailable', iaFindSnapshots],
    ['ia_get_snapshot', 'content_fetch_failed', iaGetSnapshot],
  ] as const)(
    '%s answers an Availability 400 as %s that a retry cannot fix, after one request',
    async (_name, reason, def) => {
      routeAvailability(refusedWith(400));

      const result = await runWithRetries(() =>
        def === iaFindSnapshots
          ? runToolContract(iaFindSnapshots, {
              url: 'example.com',
              mode: 'closest',
              timestamp: '2023',
            })
          : runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '2023' }),
      );

      expect(calls(isAvailability)).toHaveLength(1);
      expect(calls(isCdx)).toHaveLength(0);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: {
            reason,
            retryable: false,
            recovery: { hint: expect.stringMatching(/will not help.*url and timestamp/) },
          },
        },
      });
      expect(contentText(result)).not.toContain(hint(def.errors, reason));
      expectNoBody(result);
    },
  );
});

describe('Wayback 5xx and 429 HTML pages stay off both surfaces', () => {
  /** A proxy's 502 page or archive.org's rate-limit page, as the error body of the answer. */
  const htmlPage = (status: number) => () =>
    new Response('<!DOCTYPE html><html><body><h1>html-error-page-marker</h1></body></html>', {
      status,
      headers: { 'content-type': 'text/html' },
    });

  const closest = () =>
    runToolContract(iaFindSnapshots, { url: 'example.com', mode: 'closest', timestamp: '2023' });
  const history = () => runToolContract(iaFindSnapshots, { url: 'example.com', mode: 'history' });
  const exactSnapshot = () =>
    runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '20230101000000' });

  describe.each([502, 429])('HTTP %i', (status) => {
    it.each([
      [
        'an Availability lookup and its CDX fallback',
        'availability_unavailable',
        closest,
        () => {
          routeAvailability(htmlPage(status));
          routeCdx(htmlPage(status));
        },
      ],
      [
        'a CDX closest fallback',
        'cdx_unavailable',
        closest,
        () => {
          routeAvailability(EMPTY_AVAILABILITY);
          routeCdx(htmlPage(status));
        },
      ],
      [
        'a CDX history page',
        'cdx_unavailable',
        history,
        () => {
          routeCdx(htmlPage(status));
        },
      ],
      [
        'a replay',
        'content_fetch_failed',
        exactSnapshot,
        () => {
          routeReplay(htmlPage(status));
        },
      ],
    ] as const)('from %s surfaces %s without the page', async (_label, reason, run, route) => {
      route();

      const result = await runWithRetries(run);

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringContaining(`HTTP ${status}`),
          data: { reason },
        },
      });
      const { data } = (result.structuredContent as { error: { data: object } }).error;
      expect(data).not.toHaveProperty('body');
      expect(data).not.toHaveProperty('responseBody');
      expect(JSON.stringify(result.structuredContent)).not.toMatch(/html-error-page-marker|<html/);
      expect(contentText(result)).not.toMatch(/html-error-page-marker|<html/);
    });
  });
});

describe('Wayback log level for an upstream non-2xx', () => {
  const page = (status: number) => () =>
    new Response('<!DOCTYPE html><html><body>refusal page</body></html>', {
      status,
      headers: { 'content-type': 'text/html' },
    });

  let error: ReturnType<typeof vi.spyOn>;
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    error = vi.spyOn(logger, 'error');
    debug = vi.spyOn(logger, 'debug');
  });

  afterEach(() => {
    error.mockRestore();
    debug.mockRestore();
  });

  /** The fetch's own records of an HTTP `status` answer, by level. */
  const statusRecords = (status: number) => {
    const pattern = new RegExp(`^Fetch failed for .* with status ${status}\\.$`);
    const matching = (spy: typeof error) =>
      spy.mock.calls.filter(([message]) => typeof message === 'string' && pattern.test(message));
    return { error: matching(error).length, debug: matching(debug).length };
  };

  const getExact = () =>
    runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '20200104000551' }),
    );
  const history = () =>
    runWithRetries(() => runToolContract(iaFindSnapshots, { url: 'example.com', mode: 'history' }));

  it.each([403, 410, 451, 404])(
    'logs a replay %i, an expected refusal, at debug and never at error',
    async (status) => {
      routeReplay(page(status));

      const result = await getExact();

      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_snapshot_available' } },
      });
      expect(statusRecords(status)).toEqual({ error: 0, debug: 1 });
    },
  );

  it.each([403, 410, 451])(
    'logs a CDX %i, the URL not being served, at debug and never at error',
    async (status) => {
      routeCdx(page(status));

      const result = await history();

      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_snapshot_available' } },
      });
      expect(statusRecords(status)).toEqual({ error: 0, debug: 1 });
    },
  );

  it('logs an Availability 403 at debug and never at error', async () => {
    routeAvailability(page(403));

    await runWithRetries(() =>
      runToolContract(iaFindSnapshots, {
        url: 'excluded.example.com',
        mode: 'closest',
        timestamp: '2023',
      }),
    );

    expect(statusRecords(403)).toEqual({ error: 0, debug: 1 });
  });

  it('keeps a CDX 404, a refusal of the query rather than the URL, at error', async () => {
    routeCdx(page(404));

    await history();

    expect(statusRecords(404)).toEqual({ error: 1, debug: 0 });
  });

  it.each([
    [
      'an archived redirect',
      301,
      archivedRedirect(
        301,
        'Sat, 04 Jan 2020 00:05:51 GMT',
        'https://web.archive.org/web/20200104000551/https://example.com/',
      ),
    ],
    [
      'a redirect to the nearest capture',
      302,
      nearestCapture('https://web.archive.org/web/20200104000551/https://example.com/'),
    ],
  ])(
    'logs a followed replay redirect, %s, at debug and never at error',
    async (_kind, status, respond) => {
      http.route({ match: 'https://web.archive.org/web/20200104000551/example.com', respond });
      http.route({
        match: 'https://web.archive.org/web/20200104000551/https://example.com/',
        respond: replay('<html><body>page</body></html>'),
      });

      const result = await getExact();

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ text: 'page', resolved_status: '200' });
      expect(statusRecords(status)).toEqual({ error: 0, debug: 1 });
    },
  );

  it.each([400, 503])('keeps a replay %i at error', async (status) => {
    routeReplay(page(status));

    await getExact();

    expect(statusRecords(status).debug).toBe(0);
    expect(statusRecords(status).error).toBe(calls(isReplay).length);
  });
});

describe('input rejected before any Wayback request', () => {
  /** Every upstream answers as if the lookup would succeed, so only validation can stop it. */
  beforeEach(() => {
    routeAvailability(() =>
      Response.json({
        archived_snapshots: {
          closest: {
            url: 'http://web.archive.org/web/20200104000551/https://example.com/',
            timestamp: '20200104000551',
            status: '200',
            available: true,
          },
        },
      }),
    );
    routeCdx(cdxRows(['20200104000551', 'https://example.com/', '200']));
    routeReplay(replay('<html><body>page</body></html>'));
  });

  const CAPTURE = 'https://web.archive.org/web/20200104000551/https://example.com/';

  it.each([
    [
      'ia_find_snapshots closest mode',
      () => runToolContract(iaFindSnapshots, { url: CAPTURE, mode: 'closest', timestamp: '2020' }),
      iaFindSnapshots.errors,
    ],
    [
      'ia_get_snapshot',
      () => runToolContract(iaGetSnapshot, { url: CAPTURE, timestamp: '2020-01-04' }),
      iaGetSnapshot.errors,
    ],
  ])(
    '%s fails a timestamp naming another than its capture URL’s as ambiguous_timestamp',
    async (_label, run, errors) => {
      const result = await run();

      const recovery = hint(errors, 'ambiguous_timestamp');
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('https://example.com/ at 20200104000551'),
          data: { reason: 'ambiguous_timestamp', recovery: { hint: recovery } },
        },
      });
      expect(contentText(result)).toContain(`Recovery: ${recovery}`);
      expect(http.calls).toHaveLength(0);
    },
  );

  const IMPOSSIBLE = 'https://web.archive.org/web/20241399/https://example.com/';

  it.each([
    [
      'ia_find_snapshots closest mode',
      () => runToolContract(iaFindSnapshots, { url: IMPOSSIBLE, mode: 'closest' }),
    ],
    [
      'ia_find_snapshots history mode',
      () => runToolContract(iaFindSnapshots, { url: IMPOSSIBLE, mode: 'history' }),
    ],
    ['ia_get_snapshot', () => runToolContract(iaGetSnapshot, { url: IMPOSSIBLE, timestamp: '' })],
  ])(
    '%s fails a capture URL’s impossible timestamp as invalid_timestamp naming url',
    async (_label, run) => {
      const result = await run();

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('20241399'),
          data: { reason: 'invalid_timestamp', field: 'url' },
        },
      });
      expect(contentText(result)).toMatch(/^Recovery: .*digits after \/web\//m);
      expect(http.calls).toHaveLength(0);
    },
  );

  /** A malformed timestamp field's envelope, on both surfaces, with no request sent. */
  const expectInvalidTimestamp = (
    result: ToolResult,
    field: string,
    errors: readonly { reason: string; recovery: string }[] | undefined,
  ) => {
    const recovery = hint(errors, 'invalid_timestamp');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining(`${field} must be`),
        data: { reason: 'invalid_timestamp', field, recovery: { hint: recovery } },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${recovery}`);
    expect(http.calls).toHaveLength(0);
  };

  it.each([
    ['timestamp', { mode: 'closest', timestamp: '20151345' }],
    ['timestamp', { mode: 'closest', timestamp: '201506150527291' }],
    ['from', { mode: 'history', from: 'January 2015' }],
    ['from', { mode: 'history', from: '2015/01/01' }],
    ['to', { mode: 'history', to: '2015-02-01T00:00+01:00' }],
  ] as const)(
    'ia_find_snapshots fails a malformed %s as invalid_timestamp',
    async (field, rest) => {
      const result = await runToolContract(iaFindSnapshots, { url: 'example.com', ...rest });

      expectInvalidTimestamp(result, field, iaFindSnapshots.errors);
    },
  );

  it.each(['20151345', '201506150527291', 'January 2015'])(
    'ia_get_snapshot fails the timestamp %s as invalid_timestamp',
    async (timestamp) => {
      const result = await runToolContract(iaGetSnapshot, { url: 'example.com', timestamp });

      expectInvalidTimestamp(result, 'timestamp', iaGetSnapshot.errors);
    },
  );

  it.each([
    ['ia_find_snapshots closest', { mode: 'closest', timestamp: '20200101' }],
    ['ia_find_snapshots history', { mode: 'history' }],
  ] as const)('%s rejects a blank url as invalid_arguments', async (_label, rest) => {
    const result = await runToolContract(iaFindSnapshots, { url: '  ', ...rest });

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '  '],
  ])('ia_get_snapshot rejects the %s url as invalid_arguments', async (_label, url) => {
    const result = await runToolContract(iaGetSnapshot, { url, timestamp: '20200104000551' });

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(http.calls).toHaveLength(0);
  });
});

describe('timestamp forms reach every Wayback endpoint as digits (#48)', () => {
  const HISTORY_ROWS = [
    ['timestamp', 'statuscode', 'mimetype', 'original', 'digest', 'length'],
    ['20150105000000', '200', 'text/html', 'http://example.com/', 'DIGEST1', '1256'],
  ];
  const NASA_CAPTURE = {
    archived_snapshots: {
      closest: {
        url: 'http://web.archive.org/web/20200616000524/https://www.nasa.gov/',
        timestamp: '20200616000524',
        status: '200',
      },
    },
  };
  const searchOf = (request: Request | undefined) => new URL(request?.url ?? '').searchParams;

  it('lists the same captures for ISO from and to as for their digits, on both surfaces', async () => {
    routeCdx(() => Response.json(HISTORY_ROWS));

    const iso = await runToolContract(iaFindSnapshots, {
      url: 'example.com',
      mode: 'history',
      from: '2015-01-01',
      to: '2015-02-01',
    });
    const digits = await runToolContract(iaFindSnapshots, {
      url: 'example.com',
      mode: 'history',
      from: '20150101',
      to: '20150201',
    });

    expect(iso.structuredContent).toEqual(digits.structuredContent);
    expect(contentText(iso)).toBe(contentText(digits));
    const [isoQuery, digitQuery] = calls(isCdx).map((c) => searchOf(c.request));
    expect(isoQuery?.get('from')).toBe('20150101');
    expect(isoQuery?.get('to')).toBe('20150201');
    expect(isoQuery?.toString()).toBe(digitQuery?.toString());
  });

  it.each([
    ['3-digit prefixes', '201', '201'],
    ['an 8-digit from and a year to', '20150615', '2015'],
  ])('sends %s to CDX unchanged', async (_label, from, to) => {
    routeCdx(() => Response.json(HISTORY_ROWS));

    await runToolContract(iaFindSnapshots, { url: 'example.com', mode: 'history', from, to });

    const query = searchOf(calls(isCdx)[0]?.request);
    expect(query.get('from')).toBe(from);
    expect(query.get('to')).toBe(to);
  });

  it('answers a reversed range as an empty list, as CDX does, after one request', async () => {
    routeCdx(() => Response.json([]));

    const result = await runToolContract(iaFindSnapshots, {
      url: 'example.com',
      mode: 'history',
      from: '2016-01-01',
      to: '20150101',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      snapshots: [],
      notice: 'No captures of this URL match from "20160101", to "20150101"; widen from and to.',
    });
    expect(calls(isCdx)).toHaveLength(1);
    expect(searchOf(calls(isCdx)[0]?.request).get('from')).toBe('20160101');
  });

  it.each([
    [
      'ia_find_snapshots closest',
      () =>
        runToolContract(iaFindSnapshots, {
          url: 'https://www.nasa.gov/',
          mode: 'closest',
          timestamp: '2020-06-15',
        }),
    ],
    [
      'ia_get_snapshot',
      () =>
        runToolContract(iaGetSnapshot, { url: 'https://www.nasa.gov/', timestamp: '2020-06-15' }),
    ],
  ])('%s resolves an ISO date the way it resolves its digits', async (_label, run) => {
    routeAvailability(() => Response.json(NASA_CAPTURE));
    routeReplay(replay('<html><body>page</body></html>'));

    const result = await run();

    expect(result.isError).toBeFalsy();
    expect(searchOf(calls(isAvailability)[0]?.request).get('timestamp')).toBe('20200615');
    expect(calls(isCdx)).toHaveLength(0);
  });

  it('ia_get_snapshot reads an ISO date-time naming a second from that capture, with no lookup', async () => {
    routeReplay(replay('<html><body>page</body></html>'));

    const result = await runToolContract(iaGetSnapshot, {
      url: 'https://www.nasa.gov/',
      timestamp: '2020-06-15T12:34:56Z',
    });

    expect(result.structuredContent).toMatchObject({ resolved_timestamp: '20200615123456' });
    expect(calls(isReplay)[0]?.request.url).toBe(
      'https://web.archive.org/web/20200615123456/https://www.nasa.gov/',
    );
    expect(calls(isAvailability)).toHaveLength(0);
  });

  it('ia_get_snapshot reads the latest capture for a blank timestamp, asking for it with none', async () => {
    routeAvailability((request) =>
      new URL(request.url).searchParams.has('timestamp')
        ? new Response('<html><body>Internal Server Error</body></html>', { status: 500 })
        : Response.json(NASA_CAPTURE),
    );
    routeReplay(replay('<html><body>latest</body></html>'));

    const result = await runToolContract(iaGetSnapshot, {
      url: 'https://www.nasa.gov/',
      timestamp: '',
    });

    expect(result.structuredContent).toMatchObject({
      text: 'latest',
      resolved_timestamp: '20200616000524',
    });
    expect(calls(isAvailability)).toHaveLength(1);
    expect(searchOf(calls(isAvailability)[0]?.request).has('timestamp')).toBe(false);
    expect(calls(isCdx)).toHaveLength(0);
  });
});

/** The search parameters a recorded request carried. */
const searchOf = (request: Request | undefined) => new URL(request?.url ?? '').searchParams;

describe('ia_find_snapshots closest mode with no timestamp reads the latest capture (#60)', () => {
  const ROBOTS = 'https://www.parliament.uk/robots.txt';
  const LATEST = `https://web.archive.org/web/20260515165835/${ROBOTS}`;
  /** Answers only a lookup sent with no timestamp; one carrying a timestamp draws a 500. */
  const latestOnly = (request: Request) =>
    searchOf(request).has('timestamp')
      ? new Response('<html><body>Internal Server Error</body></html>', { status: 500 })
      : Response.json({
          archived_snapshots: {
            closest: {
              url: `http://web.archive.org/web/20260515165835/${ROBOTS}`,
              timestamp: '20260515165835',
              status: '200',
              available: true,
            },
          },
        });

  it.each([
    ['omitted', {}],
    ['empty', { timestamp: '' }],
    ['whitespace-only', { timestamp: '   ' }],
  ])(
    'returns the latest capture for a timestamp %s, asking for it with none, on both surfaces',
    async (_label, ts) => {
      routeAvailability(latestOnly);

      const result = await runToolContract(iaFindSnapshots, {
        url: ROBOTS,
        mode: 'closest',
        ...ts,
      });

      expect(result.structuredContent).toEqual({
        snapshots: [{ timestamp: '20260515165835', replay_url: LATEST, statuscode: '200' }],
      });
      const text = contentText(result);
      expect(text).toContain('## 20260515165835');
      expect(text).toContain(`**Replay URL:** [${LATEST}](<${LATEST}>)`);
      expect(calls(isAvailability)).toHaveLength(1);
      expect(searchOf(calls(isAvailability)[0]?.request).get('url')).toBe(ROBOTS);
      expect(calls(isCdx)).toHaveLength(0);
    },
  );

  it('sends the same lookup ia_get_snapshot sends for a blank timestamp, and finds the capture it reads', async () => {
    routeAvailability(latestOnly);
    routeReplay(replay('User-agent: *'));

    const found = await runToolContract(iaFindSnapshots, { url: ROBOTS, mode: 'closest' });
    const read = await runToolContract(iaGetSnapshot, { url: ROBOTS, timestamp: '' });

    expect(found.structuredContent).toMatchObject({ snapshots: [{ timestamp: '20260515165835' }] });
    expect(read.structuredContent).toMatchObject({ resolved_timestamp: '20260515165835' });
    const [findQuery, getQuery] = calls(isAvailability).map((c) => searchOf(c.request).toString());
    expect(findQuery).toBe(getQuery);
  });

  it('fails a URL with no captures at all as no_snapshot_available on both surfaces', async () => {
    routeAvailability(EMPTY_AVAILABILITY);
    routeCdx(cdxRows());

    const result = await runToolContract(iaFindSnapshots, { url: 'example.com', mode: 'closest' });

    const recovery = hint(iaFindSnapshots.errors, 'no_snapshot_available');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: 'No snapshot available for example.com.',
        data: { reason: 'no_snapshot_available', recovery: { hint: recovery } },
      },
    });
    const text = contentText(result);
    expect(text).toContain('No snapshot available for example.com.');
    expect(text).toContain(`Recovery: ${recovery}`);
    expect(searchOf(calls(isCdx)[0]?.request).get('closest')).toBe('');
  });
});

describe('a Wayback capture URL as url (#59)', () => {
  const UCD = 'https://digital.ucd.ie/';
  const CAPTURE = `https://web.archive.org/web/20241231012939/${UCD}`;
  const HEADER = ['timestamp', 'statuscode', 'mimetype', 'original', 'digest', 'length'];
  const CALENDAR =
    'https://web.archive.org/web/2*/http://abcnews.go.com/Technology/wireStory/plastic-surgery-clinics-hacked-25000-photos-data-online-47728631';

  it.each([
    ['blank', ''],
    ['its own digits', '20241231012939'],
    ['its own digits as an ISO date-time', '2024-12-31T01:29:39Z'],
  ])(
    'ia_get_snapshot reads the capture a capture URL names for a timestamp %s, keyed on its original',
    async (_label, timestamp) => {
      routeReplay(replay('<html><body>UCD Digital Library</body></html>'));

      const result = await runToolContract(iaGetSnapshot, { url: CAPTURE, timestamp });

      expect(result.structuredContent).toMatchObject({
        text: 'UCD Digital Library',
        replay_url: CAPTURE,
        resolved_timestamp: '20241231012939',
        resolved_status: '200',
      });
      expect(contentText(result)).toContain('**Resolved Timestamp:** 20241231012939');
      expect(calls(isReplay).map((c) => c.request.url)).toEqual([CAPTURE]);
      expect(calls(isAvailability)).toHaveLength(0);
      expect(calls(isCdx)).toHaveLength(0);
    },
  );

  it('ia_find_snapshots closest mode looks up the original at its capture URL’s timestamp', async () => {
    routeAvailability(() =>
      Response.json({
        archived_snapshots: {
          closest: {
            url: `http://web.archive.org/web/20241231012939/${UCD}`,
            timestamp: '20241231012939',
            status: '200',
            available: true,
          },
        },
      }),
    );

    const result = await runToolContract(iaFindSnapshots, { url: CAPTURE, mode: 'closest' });

    expect(result.structuredContent).toEqual({
      snapshots: [{ timestamp: '20241231012939', replay_url: CAPTURE, statuscode: '200' }],
    });
    const query = searchOf(calls(isAvailability)[0]?.request);
    expect(query.get('url')).toBe(UCD);
    expect(query.get('timestamp')).toBe('20241231012939');
  });

  it.each([
    ['a capture URL', CAPTURE, UCD],
    [
      'a capture URL with a percent-encoded original',
      'https://web.archive.org/web/20241231012939/https%3A%2F%2Fdigital.ucd.ie%2F',
      UCD,
    ],
    ['an alias-host capture URL with a modifier', `wayback.archive.org/web/2024id_/${UCD}`, UCD],
    ['a calendar URL, as given', CALENDAR, CALENDAR],
  ])('ia_find_snapshots history mode sends CDX the URL %s names', async (_label, url, key) => {
    routeCdx(() =>
      Response.json([HEADER, ['20190831230825', '200', 'text/html', key, 'D1', '1000']]),
    );

    const result = await runToolContract(iaFindSnapshots, { url, mode: 'history' });

    expect(result.isError).toBeFalsy();
    expect(contentText(result)).toContain('## 20190831230825');
    expect(calls(isCdx)).toHaveLength(1);
    expect(searchOf(calls(isCdx)[0]?.request).get('url')).toBe(key);
  });

  it('continues a capture URL’s history resume_key with either spelling of url', async () => {
    const shared = createMockContext();
    const definition = {
      ...iaFindSnapshots,
      handler: (
        input: Parameters<typeof iaFindSnapshots.handler>[0],
        ctx: Parameters<typeof iaFindSnapshots.handler>[1],
      ) => iaFindSnapshots.handler(input, { ...ctx, state: shared.state }),
    };
    const rows = ['20200101000000', '20210101000000', '20220101000000'].map((timestamp, i) => [
      timestamp,
      '200',
      'text/html',
      UCD,
      `D${i}`,
      String(i),
    ]);
    routeCdx((request) => {
      const qp = searchOf(request);
      const selected = rows.filter((row) => row[0]! >= (qp.get('from') ?? ''));
      return Response.json([HEADER, ...selected.slice(0, Number(qp.get('limit')))]);
    });
    type History = { snapshots: { timestamp: string }[]; resume_key?: string };

    const first = await runToolContract(definition, { url: CAPTURE, mode: 'history', limit: 1 });
    const resume_key = (first.structuredContent as History).resume_key;
    expect(resume_key).toBeDefined();

    for (const url of [CAPTURE, UCD]) {
      const next = await runToolContract(definition, {
        url,
        mode: 'history',
        resume_key,
        limit: 1,
      });
      expect(next.isError, contentText(next)).toBeFalsy();
      expect((next.structuredContent as History).snapshots.map((s) => s.timestamp)).toEqual([
        '20210101000000',
      ]);
    }
    expect(calls(isCdx).map((c) => searchOf(c.request).get('url'))).toEqual([UCD, UCD, UCD]);
  });

  it('ia_get_snapshot names the original URL in its next-page notice, and following it reads the next page', async () => {
    const PAGE_URL = 'https://en.wikipedia.org/wiki/World_War_II';
    const asked = `https://web.archive.org/web/20200101030000/${PAGE_URL}`;
    const served = `https://web.archive.org/web/20200101030925/${PAGE_URL}`;
    http.route({ match: asked, respond: nearestCapture(served) });
    http.route({
      match: served,
      respond: replay(`<html><body><p>${'a'.repeat(60_000)}</p></body></html>`),
    });

    const first = await runToolContract(iaGetSnapshot, { url: asked, timestamp: '' });
    const notice = `More text follows: call ia_get_snapshot again with url \`${PAGE_URL}\`, timestamp 20200101030925 (resolved_timestamp), and char_offset 50000 for the next page.`;
    expect(first.structuredContent).toMatchObject({
      resolved_timestamp: '20200101030925',
      has_more: true,
      notice,
    });
    expect(contentText(first)).toContain(`> ${notice}`);

    const next = await runToolContract(iaGetSnapshot, {
      url: PAGE_URL,
      timestamp: '20200101030925',
      char_offset: 50_000,
    });
    expect(next.structuredContent).toMatchObject({
      char_offset: 50_000,
      has_more: false,
      total_chars: 60_000,
    });
    expect(replayUrls()).toEqual([asked, served, served]);
  });
});
