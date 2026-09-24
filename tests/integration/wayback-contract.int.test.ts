/**
 * @fileoverview Tool-contract integration coverage for ia_find_snapshots and
 * ia_get_snapshot — both tools run against the real WaybackService, the real
 * fetchWithTimeout, and the real retry loop, with only the upstream HTTP boundary
 * stubbed. Covers closest resolution (Availability, then CDX), the capture Wayback
 * actually served, charset and text extraction, upstream 5xx reasons, and caller
 * cancellation, on both the structuredContent and content[] surfaces.
 * @module tests/integration/wayback-contract.int.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  type FetchMockResponder,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** A 429 exactly as archive.org sent it (no Retry-After). */
const RATE_LIMITED = () =>
  new Response('<html><body><h1>429 Too Many Requests</h1></body></html>', { status: 429 });

/** A responder that never answers until the request's signal aborts. */
const hang: FetchMockResponder = (request) =>
  new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason));
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
    expect(contentText(result)).toContain(`**Replay URL:** ${replayUrl}`);
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
    expect(text).toContain(`**Replay URL:** ${replayUrl}`);
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

  it('surfaces availability_unavailable after retrying an Availability 503', async () => {
    routeAvailability(() => new Response('Service Unavailable', { status: 503 }));

    const result = await runWithRetries(() => runToolContract(iaFindSnapshots, closest));

    const recovery = hint(iaFindSnapshots.errors, 'availability_unavailable');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'availability_unavailable',
          retryAttempts: 4,
          recovery: { hint: recovery },
        },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${recovery}`);
    expect(calls(isAvailability)).toHaveLength(4);
    expect(calls(isCdx)).toHaveLength(0);
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

  it('answers an Availability 429 after one request with a wait hint', async () => {
    routeAvailability(RATE_LIMITED);

    const result = await runWithRetries(() => runToolContract(iaFindSnapshots, closest));

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'availability_unavailable',
          retryable: false,
          recovery: { hint: expect.stringContaining('wait') },
        },
      },
    });
    expect(contentText(result)).toContain('not retryable');
    expect(calls(isAvailability)).toHaveLength(1);
    expect(calls(isCdx)).toHaveLength(0);
  });

  it('never reports an Availability HTML page as a ValidationError', async () => {
    routeAvailability(() => new Response('<html><body>Temporarily Offline</body></html>'));

    const result = await runWithRetries(() => runToolContract(iaFindSnapshots, closest));

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'availability_unavailable' },
      },
    });
    expect(calls(isCdx)).toHaveLength(0);
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
    expect(text).toContain(`**Replay URL:** ${replayUrl}`);
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

  it('surfaces content_fetch_failed after retrying an Availability 503', async () => {
    routeAvailability(() => new Response('Service Unavailable', { status: 503 }));

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' }),
    );

    const recovery = hint(iaGetSnapshot.errors, 'content_fetch_failed');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'content_fetch_failed', recovery: { hint: recovery } },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${recovery}`);
    expect(calls(isAvailability)).toHaveLength(4);
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

  it('answers an Availability 429 with one request and content_fetch_failed carrying the wait hint', async () => {
    routeAvailability(RATE_LIMITED);

    const result = await runWithRetries(() =>
      runToolContract(iaGetSnapshot, { url: 'nasa.gov', timestamp: '20200101' }),
    );

    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'content_fetch_failed',
          retryable: false,
          recovery: { hint: expect.stringContaining('wait') },
        },
      },
    });
    expect(calls(isAvailability)).toHaveLength(1);
  });

  it('maps an Availability page of unparseable JSON to content_fetch_failed, never ValidationError', async () => {
    routeAvailability(() => new Response('{"url": "nasa.gov", "archived_snap'));

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
          retryable: false,
          recovery: { hint: expect.stringMatching(/rate-limiting.*wait several minutes/) },
        },
      },
    });
    expect(contentText(result)).toContain('not retryable');
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
    expect(text).toContain(`**Replay URL:** ${served}`);
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
