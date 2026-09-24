/**
 * @fileoverview Tests for WaybackService lookups — fetchHistory's CDX trailer handling
 * (a truncated query must surface its resume key and must not emit the trailer rows
 * as capture records), findClosest's Availability-then-CDX resolution, the declared
 * reason an upstream 5xx surfaces as, and the recovery hint each service-thrown
 * reason forwards from the calling tool's error contract.
 * @module tests/services/wayback-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, type McpError, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();

/** Pass-through retry by default; a test flips `real` to run the framework's retry loop. */
const retryMode = { real: false };

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: Parameters<typeof fetchWithTimeout>) => fetchWithTimeout(...args),
    withRetry: <T>(fn: () => Promise<T>, options?: Parameters<typeof actual.withRetry>[1]) =>
      retryMode.real ? actual.withRetry(fn, options) : fn(),
  };
});

import { iaFindSnapshots } from '@/mcp-server/tools/definitions/ia-find-snapshots.tool.js';
import { iaGetSnapshot } from '@/mcp-server/tools/definitions/ia-get-snapshot.tool.js';
import { WaybackService } from '@/services/wayback/wayback-service.js';

const CDX_HEADER = ['timestamp', 'statuscode', 'mimetype', 'original', 'digest', 'length'];

/** One CDX capture row, in the column order the service requests. */
const capture = (timestamp: string): string[] => [
  timestamp,
  '200',
  'text/html',
  'http://www.example.com:80/',
  'UY3I2DT2AMWAY6DECFCFYMT5ZOTFHUCH',
  '481',
];

const RESUME_KEY = 'eJxLzs_VSa1IzC3ISdXUVzAyMDAyMDMwAUILAzMAf1cHkA';

/** A CDX response body as the API serializes it. */
const cdxResponse = (rows: unknown[][]): Response =>
  ({ text: async () => JSON.stringify(rows) }) as Response;

const buildService = (): WaybackService =>
  new WaybackService({ mcpServerVersion: '0.0.0-test' } as AppConfig, {} as StorageService);

const fetchHistory = (limit: number) => {
  const svc = buildService();
  const ctx = createMockContext({ errors: iaFindSnapshots.errors });
  return svc.fetchHistory({ url: 'example.com', limit }, ctx);
};

/** The declared recovery string for `reason` on a definition's error contract. */
const declaredRecovery = (
  errors: readonly { reason: string; recovery: string }[] | undefined,
  reason: string,
): string => {
  const entry = errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`contract declares no ${reason}`);
  return entry.recovery;
};

/** An Availability API JSON body as a 200 response. */
const availability = (body: unknown): Response => Response.json(body);

/** An Availability API 200 carrying `text` verbatim. */
const availabilityText = (text: string): Response =>
  new Response(text, { headers: { 'content-type': 'text/html' } });

/** A CDX body the service reads as text. */
const cdxText = (text: string): Response => ({ text: async () => text }) as Response;

/** A CDX closest-query body: header row, then `[timestamp, original, statuscode]` rows. */
const cdxClosest = (...rows: [string, string, string][]): Response =>
  cdxText(JSON.stringify([['timestamp', 'original', 'statuscode'], ...rows]));

/**
 * The error the real `fetchWithTimeout` throws when the upstream answers `status` —
 * produced by running the framework helper against a stubbed `fetch`, so its shape is
 * the one production code sees, not a hand-built imitation.
 */
const upstreamError = async (status: number, headers?: HeadersInit): Promise<McpError> => {
  const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
    '@cyanheads/mcp-ts-core/utils',
  );
  const http = createFetchMock([
    { match: () => true, respond: new Response('Temporarily Offline', { status, headers }) },
  ]);
  http.install();
  try {
    await actual.fetchWithTimeout(
      'https://web.archive.org/cdx/search/cdx',
      5_000,
      createMockContext(),
    );
  } catch (err) {
    return err as McpError;
  } finally {
    http.restore();
  }
  throw new Error(`fetchWithTimeout did not throw for HTTP ${status}`);
};

/** The `Timeout` the real `fetchWithTimeout` throws when the upstream never answers. */
const upstreamTimeout = async (): Promise<McpError> => {
  const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
    '@cyanheads/mcp-ts-core/utils',
  );
  const http = createFetchMock([
    {
      match: () => true,
      respond: (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason));
        }),
    },
  ]);
  http.install();
  try {
    await actual.fetchWithTimeout('https://web.archive.org/cdx/search/cdx', 5, createMockContext());
  } catch (err) {
    return err as McpError;
  } finally {
    http.restore();
  }
  throw new Error('fetchWithTimeout did not time out');
};

/** What a failed or timed-out CDX fallback must say, whichever tool asked. */
const FALLBACK_INCOMPLETE = {
  message: expect.stringMatching(/Availability API found no capture.*CDX .*did not complete/),
  hint: expect.stringContaining('history mode'),
};

/** The URL the service requested on call `n` (0-based). */
const requestedUrl = (n: number): URL => new URL(fetchWithTimeout.mock.calls[n]?.[0] as string);

beforeEach(() => {
  fetchWithTimeout.mockReset();
  fetchWithTimeout.mockImplementation((url: string) =>
    Promise.reject(new Error(`unmocked fetch: ${url}`)),
  );
});

afterEach(() => {
  retryMode.real = false;
  vi.useRealTimers();
});

describe('WaybackService.fetchHistory CDX trailer handling', () => {
  it('returns every capture and no resume key when the query is not truncated', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      cdxResponse([CDX_HEADER, capture('20020524041628'), capture('20020528114741')]),
    );

    const result = await fetchHistory(10);

    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.timestamp)).toEqual(['20020524041628', '20020528114741']);
    expect(result.resumeKey).toBeUndefined();
  });

  it('extracts the resume key when CDX separates it with a zero-length row', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      cdxResponse([
        CDX_HEADER,
        capture('20020524041628'),
        capture('20020528114741'),
        [],
        [RESUME_KEY],
      ]),
    );

    const result = await fetchHistory(2);

    expect(result.resumeKey).toBe(RESUME_KEY);
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.timestamp)).toEqual(['20020524041628', '20020528114741']);
  });

  it('extracts the resume key when the separator row holds a single empty string', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      cdxResponse([CDX_HEADER, capture('20020524041628'), [''], [RESUME_KEY]]),
    );

    const result = await fetchHistory(1);

    expect(result.resumeKey).toBe(RESUME_KEY);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.timestamp).toBe('20020524041628');
  });

  it('never emits a trailer row as a capture record', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      cdxResponse([CDX_HEADER, capture('20020524041628'), [], [RESUME_KEY]]),
    );

    const result = await fetchHistory(1);

    expect(result.records.map((r) => r.timestamp)).not.toContain('');
    expect(result.records.map((r) => r.timestamp)).not.toContain(RESUME_KEY);
  });

  it('forwards a resume key back to CDX as the resumeKey query parameter', async () => {
    fetchWithTimeout.mockResolvedValueOnce(cdxResponse([CDX_HEADER, capture('20020524041628')]));

    const svc = buildService();
    const ctx = createMockContext({ errors: iaFindSnapshots.errors });
    await svc.fetchHistory({ url: 'example.com', limit: 1, resumeKey: RESUME_KEY }, ctx);

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      expect.stringContaining(`resumeKey=${encodeURIComponent(RESUME_KEY)}`),
      expect.any(Number),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('WaybackService.findClosest resolution', () => {
  const findClosest = (url: string, timestamp: string, errors = iaFindSnapshots.errors) =>
    buildService().findClosest(url, timestamp, createMockContext({ errors }));

  it('returns the Availability capture with an https replay URL, in one request', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      availability({
        archived_snapshots: {
          closest: {
            url: 'http://web.archive.org/web/20200101231047/https://example.com/',
            timestamp: '20200101231047',
            status: '200',
            available: true,
          },
        },
      }),
    );

    await expect(findClosest('example.com', '20200101')).resolves.toEqual({
      snapshotUrl: 'https://web.archive.org/web/20200101231047/https://example.com/',
      timestamp: '20200101231047',
      status: '200',
    });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(requestedUrl(0).origin + requestedUrl(0).pathname).toBe(
      'https://archive.org/wayback/available',
    );
  });

  it('falls back to a CDX closest query when the Availability API answers empty', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(availability({ archived_snapshots: {} }))
      .mockResolvedValueOnce(
        cdxClosest(
          ['20200101231916', 'https://www.nasa.gov/', '200'],
          ['20200101230622', 'http://nasa.gov/', '301'],
        ),
      );

    await expect(findClosest('nasa.gov', '20200101')).resolves.toEqual({
      snapshotUrl: 'https://web.archive.org/web/20200101231916/https://www.nasa.gov/',
      timestamp: '20200101231916',
      status: '200',
    });

    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    const cdx = requestedUrl(1);
    expect(cdx.origin + cdx.pathname).toBe('https://web.archive.org/cdx/search/cdx');
    expect(cdx.searchParams.get('url')).toBe('nasa.gov');
    expect(cdx.searchParams.get('closest')).toBe('20200101');
    expect(cdx.searchParams.get('sort')).toBe('closest');
    expect(cdx.searchParams.get('output')).toBe('json');
  });

  it('prefers the nearest 200 capture over nearer redirects and revisits', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(availability({ archived_snapshots: {} }))
      .mockResolvedValueOnce(
        cdxClosest(
          ['20200101230622', 'http://nasa.gov/', '301'],
          ['20200101222024', 'https://www.nasa.gov/', '-'],
          ['20200101215134', 'https://www.nasa.gov/', '200'],
          ['20200102030753', 'https://www.nasa.gov/', '200'],
        ),
      );

    await expect(findClosest('nasa.gov', '20200101')).resolves.toMatchObject({
      timestamp: '20200101215134',
      status: '200',
    });
  });

  it('takes the nearest capture of any status when none nearby is a 200', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(availability({ archived_snapshots: {} }))
      .mockResolvedValueOnce(
        cdxClosest(
          ['20200101235909', 'https://example.com', '-'],
          ['20200102000147', 'http://example.com/', '301'],
        ),
      );

    await expect(findClosest('example.com', '20200101')).resolves.toEqual({
      snapshotUrl: 'https://web.archive.org/web/20200101235909/https://example.com',
      timestamp: '20200101235909',
      status: '-',
    });
  });

  it('falls back to CDX when the Availability URL is not a Wayback replay URL', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(
        availability({
          archived_snapshots: {
            closest: { url: 'https://evil.example/x', timestamp: '20200101000000', status: '200' },
          },
        }),
      )
      .mockResolvedValueOnce(cdxClosest(['20200101000100', 'https://example.com/', '200']));

    await expect(findClosest('example.com', '2020')).resolves.toMatchObject({
      snapshotUrl: 'https://web.archive.org/web/20200101000100/https://example.com/',
    });
  });

  it('surfaces cdx_unavailable when the fallback CDX query answers with an HTML page', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(availability({ archived_snapshots: {} }))
      .mockResolvedValueOnce(cdxText('<html><body>Temporarily Offline</body></html>'));

    await expect(findClosest('example.com', '20200101')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: FALLBACK_INCOMPLETE.message,
      data: { reason: 'cdx_unavailable', recovery: { hint: FALLBACK_INCOMPLETE.hint } },
    });
  });

  it('gives the CDX fallback one attempt under a deadline shorter than the request timeout', async () => {
    const timedOut = await upstreamTimeout();
    retryMode.real = true;
    vi.useFakeTimers();
    fetchWithTimeout
      .mockResolvedValueOnce(availability({ archived_snapshots: {} }))
      .mockRejectedValue(timedOut);

    const pending = findClosest('github.com', '20180101').catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    const err = (await pending) as McpError;

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: FALLBACK_INCOMPLETE.message,
      data: { reason: 'cdx_unavailable', recovery: { hint: FALLBACK_INCOMPLETE.hint } },
    });
    expect(err.cause).toBe(timedOut);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    const [availabilityTimeout, cdxDeadline] = fetchWithTimeout.mock.calls.map((c) => c[1]);
    expect(availabilityTimeout).toBe(30_000);
    expect(cdxDeadline).toBe(25_000);
  });

  it('never reports a failed CDX fallback as no_snapshot_available', async () => {
    retryMode.real = true;
    vi.useFakeTimers();
    fetchWithTimeout
      .mockResolvedValueOnce(availability({ archived_snapshots: {} }))
      .mockRejectedValue(await upstreamError(503));

    const pending = buildService()
      .findClosest('example.com', '20200101', createMockContext({ errors: iaGetSnapshot.errors }))
      .catch((err: unknown) => err);
    await vi.runAllTimersAsync();

    const err = (await pending) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data?.reason).not.toBe('no_snapshot_available');
    expect(err).toMatchObject({
      message: FALLBACK_INCOMPLETE.message,
      data: { recovery: { hint: FALLBACK_INCOMPLETE.hint } },
    });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it('passes a caller cancellation during the CDX fallback through untouched', async () => {
    const cancelled = requestCancelled(
      'fetch GET https://web.archive.org/cdx/search/cdx was aborted.',
    );
    fetchWithTimeout
      .mockResolvedValueOnce(availability({ archived_snapshots: {} }))
      .mockRejectedValueOnce(cancelled);

    await expect(findClosest('example.com', '20200101')).rejects.toBe(cancelled);
  });

  it('never falls back when the caller cancels the Availability request', async () => {
    const cancelled = requestCancelled(
      'fetch GET https://archive.org/wayback/available was aborted.',
    );
    fetchWithTimeout.mockRejectedValueOnce(cancelled);

    await expect(findClosest('example.com', '20200101')).rejects.toBe(cancelled);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });
});

describe('WaybackService upstream 5xx surfaces as a declared reason (#26)', () => {
  const findErrors = iaFindSnapshots.errors;
  const cdxHint = declaredRecovery(findErrors, 'cdx_unavailable');

  it('fetchWithTimeout throws a status-mapped McpError on a 5xx, never returning the response', async () => {
    const err = await upstreamError(503, { 'retry-after': '7' });
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { statusCode: 503, retryAfter: '7', errorSource: 'FetchHttpError' },
    });
    expect(err.data?.reason).toBeUndefined();
  });

  it.each([500, 502, 503])('maps a CDX history %i onto cdx_unavailable', async (status) => {
    fetchWithTimeout.mockRejectedValueOnce(await upstreamError(status));

    await expect(
      buildService().fetchHistory(
        { url: 'example.com' },
        createMockContext({ errors: findErrors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'cdx_unavailable', status, recovery: { hint: cdxHint } },
    });
  });

  it('maps a CDX history 504, which the framework classifies as Timeout, onto cdx_unavailable', async () => {
    const gateway = await upstreamError(504);
    expect(gateway.code).toBe(JsonRpcErrorCode.Timeout);
    fetchWithTimeout.mockRejectedValueOnce(gateway);

    await expect(
      buildService().fetchHistory(
        { url: 'example.com' },
        createMockContext({ errors: findErrors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'cdx_unavailable', status: 504, recovery: { hint: cdxHint } },
    });
  });

  it('keeps the Retry-After, the 501 retryability, and the cause on the reclassified error', async () => {
    const limited = await upstreamError(503, { 'retry-after': '7' });
    fetchWithTimeout.mockRejectedValueOnce(limited);
    const ctx = createMockContext({ errors: findErrors });
    const err = (await buildService()
      .fetchHistory({ url: 'example.com' }, ctx)
      .catch((e: unknown) => e)) as McpError;
    expect(err.data).toMatchObject({ reason: 'cdx_unavailable', retryAfter: '7' });
    expect(err.cause).toBe(limited);

    fetchWithTimeout.mockRejectedValueOnce(await upstreamError(501));
    await expect(buildService().fetchHistory({ url: 'example.com' }, ctx)).rejects.toMatchObject({
      data: { reason: 'cdx_unavailable', retryable: false },
    });
  });

  it('leaves a 4xx from CDX as the framework classified it', async () => {
    const missing = await upstreamError(404);
    fetchWithTimeout.mockRejectedValueOnce(missing);

    await expect(
      buildService().fetchHistory(
        { url: 'example.com' },
        createMockContext({ errors: findErrors }),
      ),
    ).rejects.toBe(missing);
  });

  it('leaves a caller cancellation untouched', async () => {
    const cancelled = requestCancelled(
      'fetch GET https://web.archive.org/cdx/search/cdx was aborted.',
    );
    fetchWithTimeout.mockRejectedValueOnce(cancelled);

    await expect(
      buildService().fetchHistory(
        { url: 'example.com' },
        createMockContext({ errors: findErrors }),
      ),
    ).rejects.toBe(cancelled);
  });

  it('maps an Availability 5xx onto availability_unavailable under ia_find_snapshots', async () => {
    fetchWithTimeout.mockRejectedValueOnce(await upstreamError(503));

    await expect(
      buildService().findClosest(
        'example.com',
        '20200101',
        createMockContext({ errors: findErrors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'availability_unavailable',
        status: 503,
        recovery: { hint: declaredRecovery(findErrors, 'availability_unavailable') },
      },
    });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('maps a 5xx from the fallback CDX query onto cdx_unavailable', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(availability({ archived_snapshots: {} }))
      .mockRejectedValueOnce(await upstreamError(502));

    await expect(
      buildService().findClosest(
        'example.com',
        '20200101',
        createMockContext({ errors: findErrors }),
      ),
    ).rejects.toMatchObject({
      message: FALLBACK_INCOMPLETE.message,
      data: { reason: 'cdx_unavailable', recovery: { hint: FALLBACK_INCOMPLETE.hint } },
    });
  });

  it('retries a CDX 503 through the real retry loop and surfaces the reason only on exhaustion', async () => {
    retryMode.real = true;
    vi.useFakeTimers();
    const unavailable = await upstreamError(503);
    fetchWithTimeout.mockImplementation(() => Promise.reject(unavailable));

    const pending = buildService()
      .fetchHistory({ url: 'example.com' }, createMockContext({ errors: findErrors }))
      .catch((err: unknown) => err);
    await vi.runAllTimersAsync();

    expect(await pending).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'cdx_unavailable', retryAttempts: 4, recovery: { hint: cdxHint } },
    });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(4);
  });

  it('still fails a 501 fast through the real retry loop', async () => {
    retryMode.real = true;
    vi.useFakeTimers();
    const unimplemented = await upstreamError(501);
    fetchWithTimeout.mockImplementation(() => Promise.reject(unimplemented));

    const pending = buildService()
      .fetchHistory({ url: 'example.com' }, createMockContext({ errors: findErrors }))
      .catch((err: unknown) => err);
    await vi.runAllTimersAsync();

    expect(await pending).toMatchObject({ data: { reason: 'cdx_unavailable', retryable: false } });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('answers a CDX 429 after one request with a wait hint, not four retries', async () => {
    retryMode.real = true;
    vi.useFakeTimers();
    const limited = await upstreamError(429);
    fetchWithTimeout.mockImplementation(() => Promise.reject(limited));

    const pending = buildService()
      .fetchHistory({ url: 'example.com' }, createMockContext({ errors: findErrors }))
      .catch((err: unknown) => err);
    await vi.runAllTimersAsync();

    expect(await pending).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'cdx_unavailable',
        status: 429,
        retryable: false,
        recovery: { hint: expect.stringMatching(/rate-limit.*wait several minutes/i) },
      },
    });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('names the Retry-After wait in the 429 hint when the upstream sends one', async () => {
    fetchWithTimeout.mockRejectedValueOnce(await upstreamError(429, { 'retry-after': '120' }));

    await expect(
      buildService().fetchHistory(
        { url: 'example.com' },
        createMockContext({ errors: findErrors }),
      ),
    ).rejects.toMatchObject({
      data: {
        reason: 'cdx_unavailable',
        retryAfter: '120',
        retryable: false,
        recovery: { hint: expect.stringContaining('wait 120 seconds') },
      },
    });
  });

  it('answers an Availability 429 after one request under availability_unavailable', async () => {
    retryMode.real = true;
    vi.useFakeTimers();
    const limited = await upstreamError(429);
    fetchWithTimeout.mockImplementation(() => Promise.reject(limited));

    const pending = buildService()
      .findClosest('example.com', '20200101', createMockContext({ errors: findErrors }))
      .catch((err: unknown) => err);
    await vi.runAllTimersAsync();

    expect(await pending).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'availability_unavailable',
        retryable: false,
        recovery: { hint: expect.stringMatching(/wait/) },
      },
    });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an HTML page', '<html><body>Temporarily Offline</body></html>'],
    ['unparseable JSON', '{"url": "example.com", "archived_snap'],
  ])('maps an Availability 200 carrying %s onto availability_unavailable', async (_name, body) => {
    fetchWithTimeout.mockResolvedValueOnce(availabilityText(body));

    const err = (await buildService()
      .findClosest('example.com', '20200101', createMockContext({ errors: findErrors }))
      .catch((e: unknown) => e)) as McpError;

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'availability_unavailable',
        recovery: { hint: declaredRecovery(findErrors, 'availability_unavailable') },
      },
    });
    expect(err.code).not.toBe(JsonRpcErrorCode.ValidationError);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('retries an Availability HTML page as CDX’s HTML case is retried', async () => {
    retryMode.real = true;
    vi.useFakeTimers();
    fetchWithTimeout.mockImplementation(() =>
      Promise.resolve(availabilityText('<html><body>Temporarily Offline</body></html>')),
    );

    const pending = buildService()
      .findClosest('example.com', '20200101', createMockContext({ errors: findErrors }))
      .catch((err: unknown) => err);
    await vi.runAllTimersAsync();

    expect(await pending).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'availability_unavailable', retryAttempts: 4 },
    });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(4);
  });
});

describe('WaybackService service-thrown reasons carry the caller’s recovery hint', () => {
  const closestCallers = [
    ['ia_find_snapshots', iaFindSnapshots.errors],
    ['ia_get_snapshot', iaGetSnapshot.errors],
  ] as const;

  it('declares different no_snapshot_available hints on the two calling tools', () => {
    expect(declaredRecovery(iaFindSnapshots.errors, 'no_snapshot_available')).not.toBe(
      declaredRecovery(iaGetSnapshot.errors, 'no_snapshot_available'),
    );
  });

  describe.each(closestCallers)('findClosest under the %s contract', (_name, errors) => {
    const hint = declaredRecovery(errors, 'no_snapshot_available');

    it('forwards the hint when neither the Availability API nor CDX has a capture', async () => {
      fetchWithTimeout
        .mockResolvedValueOnce(availability({ archived_snapshots: {} }))
        .mockResolvedValueOnce(cdxClosest());

      await expect(
        buildService().findClosest('example.com', '19900101', createMockContext({ errors })),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: 'No snapshot available for example.com near 19900101.',
        data: {
          reason: 'no_snapshot_available',
          url: 'example.com',
          timestamp: '19900101',
          recovery: { hint },
        },
      });
    });

    it('forwards the hint when CDX answers with an empty body', async () => {
      fetchWithTimeout
        .mockResolvedValueOnce(availability({ archived_snapshots: {} }))
        .mockResolvedValueOnce(cdxText('[]'));

      await expect(
        buildService().findClosest('example.com', '19900101', createMockContext({ errors })),
      ).rejects.toMatchObject({ data: { reason: 'no_snapshot_available', recovery: { hint } } });
    });

    it('forwards the hint when the only Availability URL is not a Wayback replay URL', async () => {
      fetchWithTimeout
        .mockResolvedValueOnce(
          availability({
            archived_snapshots: {
              closest: {
                url: 'https://evil.example/x',
                timestamp: '20200101000000',
                status: '200',
              },
            },
          }),
        )
        .mockResolvedValueOnce(cdxClosest());

      await expect(
        buildService().findClosest('example.com', '2020', createMockContext({ errors })),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'no_snapshot_available',
          url: 'example.com',
          timestamp: '2020',
          recovery: { hint },
        },
      });
    });
  });

  describe('fetchHistory under the ia_find_snapshots contract', () => {
    const errors = iaFindSnapshots.errors;
    const hint = declaredRecovery(errors, 'cdx_unavailable');

    it('forwards the hint when CDX answers with an HTML page', async () => {
      fetchWithTimeout.mockResolvedValueOnce(cdxText('<!DOCTYPE html><html><body>busy</body>'));

      await expect(
        buildService().fetchHistory({ url: 'example.com' }, createMockContext({ errors })),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'CDX API returned HTML — likely overloaded.',
        data: { reason: 'cdx_unavailable', recovery: { hint } },
      });
    });

    it('forwards the hint when the CDX body is unparseable', async () => {
      fetchWithTimeout.mockResolvedValueOnce(cdxText('[["timestamp"'));

      await expect(
        buildService().fetchHistory({ url: 'example.com' }, createMockContext({ errors })),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'CDX API returned unparseable response.',
        data: { reason: 'cdx_unavailable', recovery: { hint } },
      });
    });

    it('keeps the hint on the error the real retry loop surfaces after exhaustion', async () => {
      retryMode.real = true;
      vi.useFakeTimers();
      fetchWithTimeout.mockImplementation(() =>
        Promise.resolve(cdxText('<html><body>overloaded</body></html>')),
      );

      const pending = buildService()
        .fetchHistory({ url: 'example.com' }, createMockContext({ errors }))
        .catch((err: unknown) => err);
      await vi.runAllTimersAsync();

      expect(await pending).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'cdx_unavailable', retryAttempts: 4, recovery: { hint } },
      });
      expect(fetchWithTimeout).toHaveBeenCalledTimes(4);
    });
  });
});
