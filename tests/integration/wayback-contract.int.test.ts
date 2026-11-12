/**
 * @fileoverview Tool-contract integration coverage for ia_find_snapshots and
 * ia_get_snapshot — both tools run against the real WaybackService, the real
 * fetchWithTimeout, and the real retry loop, with only the upstream HTTP boundary
 * stubbed. Covers closest resolution (Availability, then CDX), the capture Wayback
 * actually served, charset and text extraction, routing by the replay's media type,
 * snapshot paging, upstream 5xx, timeout, and network-error reasons, archived error
 * captures, and caller cancellation, on both the structuredContent and content[] surfaces.
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

/** A replay response that reports `url` as the URL the fetch ended on. */
const replay =
  (body: BodyInit, url?: string, headers: Record<string, string> = {}) =>
  () => {
    const response = new Response(body, { headers: { 'content-type': 'text/html', ...headers } });
    if (url) Object.defineProperty(response, 'url', { value: url });
    return response;
  };

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

  it('surfaces cdx_unavailable when the CDX fallback outlasts its deadline', async () => {
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

  describe('under one deadline: the request timeout plus 25 s (#53)', () => {
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
            'The closest-capture lookup for nasa.gov near 20200101 did not finish within its 55 s deadline: the Availability API did not answer in time.',
          data: {
            reason: 'availability_unavailable',
            retryAttempts: 2,
            recovery: { hint: expect.stringMatching(NO_LOOKUP_ROUTE) },
          },
        },
      });
      expect(contentText(result)).toMatch(/did not finish within its 55 s deadline/);
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
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ServiceUnavailable,
            message: expect.stringMatching(LOOKUP_FAILED_MESSAGE),
            data: { reason: 'availability_unavailable', status: 503, retryAttempts: 4 },
          },
        });
        expect(calls(isAvailability)).toHaveLength(4);
        expect(calls(isCdx)).toHaveLength(1);
      } finally {
        random.mockRestore();
      }
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

  it('preserves no_snapshots when a previously valid cursor reaches an empty index range', async () => {
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
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_snapshots' } },
    });
    expect(contentText(result)).toContain('No snapshots found');
    expect(contentText(result)).toContain('Recovery:');
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
      expect(contentText(result)).toContain('can omit captures');
      expect(JSON.stringify(result.structuredContent)).toContain('can omit captures');
      expect(new URL(calls(isCdx)[0]!.request.url).searchParams.get('resumeKey')).toBe('RAW');
    },
  );
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
        message: expect.stringMatching(/^The closest-capture lookup for nasa\.gov .*55 s deadline/),
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
    routeReplay(replay(PAGE, 'https://web.archive.org/web/20200101230626/https://www.nasa.gov/'));

    const result = await runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' });

    expect(result.structuredContent).toMatchObject({
      resolved_timestamp: '20200101230626',
      resolved_status: '200',
    });
    expect(contentText(result)).toContain(
      '**Resolved Timestamp:** 20200101230626 | **Status:** 200',
    );
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
    expect(sc.text.startsWith('news news')).toBe(true);
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
        undefined,
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
    const served = 'https://web.archive.org/web/20200104000551/https://example.com/';
    routeReplay(replay(PAGE, served));

    const result = await runToolContract(iaGetSnapshot, {
      url: 'example.com',
      timestamp: '20200104000000',
    });

    expect(calls(isReplay)[0]?.request.url).toBe(
      'https://web.archive.org/web/20200104000000/example.com',
    );
    expect(result.structuredContent).toMatchObject({
      replay_url: served,
      resolved_timestamp: '20200104000551',
    });
    const text = contentText(result);
    expect(text).toContain(`**Replay URL:** [${served}](<${served}>)`);
    expect(text).toContain('**Resolved Timestamp:** 20200104000551');
  });

  it('keeps the requested URL and timestamp for a capture served without a redirect', async () => {
    const requested = 'https://web.archive.org/web/20200104000551/https://example.com/';
    routeReplay(replay(PAGE, requested));

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
        undefined,
        { 'x-archive-guessed-charset': 'latin1' },
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

  it.each([
    ['omitted', {}],
    ['empty', { timestamp: '' }],
    ['whitespace-only', { timestamp: '   ' }],
  ])(
    'ia_find_snapshots closest mode with the timestamp %s fails as missing_timestamp',
    async (_label, ts) => {
      const result = await runToolContract(iaFindSnapshots, {
        url: 'example.com',
        mode: 'closest',
        ...ts,
      });

      const recovery = hint(iaFindSnapshots.errors, 'missing_timestamp');
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'missing_timestamp', recovery: { hint: recovery } },
        },
      });
      expect(contentText(result)).toContain(`Recovery: ${recovery}`);
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

  it('still answers a reversed range with no_snapshots, as CDX does', async () => {
    routeCdx(() => Response.json([]));

    const result = await runToolContract(iaFindSnapshots, {
      url: 'example.com',
      mode: 'history',
      from: '20160101',
      to: '20150101',
    });

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_snapshots' } },
    });
    expect(calls(isCdx)).toHaveLength(1);
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
