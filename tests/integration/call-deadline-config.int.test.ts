/**
 * @fileoverview The call deadline under a configured IA_REQUEST_TIMEOUT_MS other than the
 * default: at 90 s the deadline rises to it, so one request runs its full timeout and the call
 * still ends by 90 s; at 10 s two whole timeouts fit inside the 55 s deadline, where the
 * Metadata service's one retry after a first timeout, and its stop at a second, stay
 * observable. Real services, `fetchWithTimeout`, and retry loop on a fake clock, with only the
 * HTTP boundary stubbed.
 * @module tests/integration/call-deadline-config.int.test
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

const config = vi.hoisted(() => ({ requestTimeoutMs: 30_000 }));
vi.mock('@/config/server-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/server-config.js')>();
  return { ...actual, getServerConfig: () => ({ ...actual.getServerConfig(), ...config }) };
});

import { iaFindSnapshots } from '@/mcp-server/tools/definitions/ia-find-snapshots.tool.js';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import { iaGetText } from '@/mcp-server/tools/definitions/ia-get-text.tool.js';
import { iaSearchItems } from '@/mcp-server/tools/definitions/ia-search-items.tool.js';
import { initArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';
import { initArchiveSearchService } from '@/services/archive-search/archive-search-service.js';
import { initWaybackService } from '@/services/wayback/wayback-service.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

const ID = 'a-volume';
const FILE = 'a-volume_djvu.txt';

/** Unmatched requests throw — no test in this file reaches the network. */
const http = createFetchMock();

const ARCHIVE = 'https://archive.org';
const onPath = (prefix: string) => (r: Request) => {
  const url = new URL(r.url);
  return url.origin === ARCHIVE && url.pathname.startsWith(prefix);
};
const isMetadata = onPath('/metadata/');
const isDownload = onPath('/download/');
const isSearch = onPath('/advancedsearch.php');
const isAvailability = onPath('/wayback/available');
const isCdx = (r: Request) => r.url.startsWith('https://web.archive.org/cdx/search/cdx?');
const calls = (match: (r: Request) => boolean) => http.calls.filter((c) => match(c.request));
const route = (match: (r: Request) => boolean, respond: FetchMockResponder) =>
  http.route({ match, respond });

/** A text item's metadata: the file list ia_get_text reads, or the whole record ia_get_item reads. */
const MANIFEST: FetchMockResponder = (request) => {
  const files = [{ name: FILE, format: 'DjVuTXT', size: '12' }];
  return request.url === `${ARCHIVE}/metadata/${ID}/files`
    ? Response.json({ result: files })
    : Response.json({ metadata: { identifier: ID, title: 'A Volume', mediatype: 'texts' }, files });
};
const S503 = () => new Response('Service Unavailable', { status: 503 });

/** Never answers until the request's signal aborts. */
const hang: FetchMockResponder = (request) =>
  new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason));
  });

/** Answers as `respond` would after `ms`, unless the request's signal aborts first. */
const answerAfter =
  (ms: number, respond: FetchMockResponder): FetchMockResponder =>
  (request, ...rest) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(respond(request, ...rest)), ms);
      request.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(request.signal.reason);
      });
    });

/** Answers each request with the next responder, repeating the last. */
const inSequence = (...sequence: FetchMockResponder[]): FetchMockResponder => {
  let n = 0;
  return (request, ...rest) =>
    (sequence[Math.min(n++, sequence.length - 1)] as FetchMockResponder)(request, ...rest);
};

const errorOf = (result: ToolResult) =>
  (
    result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    }
  ).error;

/** Runs a tool under fake timers to completion, reporting the fake time it took. */
const runTimed = async (run: () => Promise<ToolResult>) => {
  vi.useFakeTimers();
  const start = Date.now();
  const pending = run();
  await vi.runAllTimersAsync();
  const result = await pending;
  return { result, elapsedMs: Date.now() - start };
};

/** Sets IA_REQUEST_TIMEOUT_MS for the tests of one block, with services built under it. */
const withRequestTimeout = (ms: number) => {
  beforeAll(() => {
    config.requestTimeoutMs = ms;
    const appConfig = { mcpServerVersion: '0.0.0-test' } as AppConfig;
    initArchiveMetadataService(appConfig, createInMemoryStorage());
    initArchiveSearchService(appConfig, createInMemoryStorage());
    initWaybackService(appConfig, createInMemoryStorage());
  });
};

let random: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  http.install();
});

afterAll(() => {
  http.restore();
});

beforeEach(() => {
  http.reset();
  // Backoff without jitter: exactly 1 s, then 2 s, then 4 s.
  random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  random.mockRestore();
  vi.useRealTimers();
});

describe('IA_REQUEST_TIMEOUT_MS=90000', () => {
  withRequestTimeout(90_000);

  it('lets one request run past 55 s, up to its own 90 s timeout', async () => {
    route(isMetadata, answerAfter(89_900, MANIFEST));

    const { result, elapsedMs } = await runTimed(() =>
      runToolContract(iaGetItem, { identifier: ID }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ identifier: ID, title: 'A Volume' });
    expect(elapsedMs).toBe(89_900);
    expect(calls(isMetadata)).toHaveLength(1);
  });

  it('ends ia_get_item at 90 s when its one request runs the whole deadline', async () => {
    route(isMetadata, hang);

    const { result, elapsedMs } = await runTimed(() =>
      runToolContract(iaGetItem, { identifier: ID }),
    );

    expect(elapsedMs).toBe(90_000);
    expect(calls(isMetadata)).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'The Internet Archive Metadata API did not finish within the 90 s call deadline.',
        data: { reason: 'archive_unavailable' },
      },
    });
  });

  it('ends ia_search_items by 90 s when its first answer leaves no time for a backoff', async () => {
    route(isSearch, answerAfter(89_900, S503));

    const { result, elapsedMs } = await runTimed(() =>
      runToolContract(iaSearchItems, { query: 'tesla' }),
    );

    expect(elapsedMs).toBe(89_900);
    expect(calls(isSearch)).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'Advanced Search did not finish within the 90 s call deadline.',
        data: { reason: 'search_unavailable' },
      },
    });
    expect(errorOf(result).data).not.toHaveProperty('retryable');
  });

  it('ends ia_find_snapshots closest mode at 90 s when its first answer leaves no time for a backoff', async () => {
    route(isAvailability, answerAfter(89_900, S503));
    route(isCdx, hang);

    const { result, elapsedMs } = await runTimed(() =>
      runToolContract(iaFindSnapshots, { url: 'nasa.gov', mode: 'closest', timestamp: '20200101' }),
    );

    // The CDX check gets the 100 ms that remain, and the deadline cuts it off.
    expect(elapsedMs).toBe(90_000);
    expect(calls(isAvailability)).toHaveLength(1);
    expect(calls(isCdx)).toHaveLength(1);
    const message =
      'The closest-capture lookup for nasa.gov near 20200101 did not complete: Availability API returned HTTP 503. The CDX closest-capture check it fell back to did not finish within the 90 s call deadline.';
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message,
      data: { reason: 'availability_unavailable', status: 503 },
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining(`Error: ${message}`) }),
    );
  });
});

describe('IA_REQUEST_TIMEOUT_MS=10000', () => {
  withRequestTimeout(10_000);

  it('gives the metadata request and the download one timeout retry each', async () => {
    route(isMetadata, inSequence(hang, MANIFEST));
    route(
      isDownload,
      inSequence(hang, () => new Response('Chapter one.')),
    );

    const { result, elapsedMs } = await runTimed(() =>
      runToolContract(iaGetText, { identifier: ID }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ text: 'Chapter one.' });
    expect(calls(isMetadata)).toHaveLength(2);
    expect(calls(isDownload)).toHaveLength(2);
    expect(elapsedMs).toBe(2 * (10_000 + 1_000));
  });

  it('stops at a second whole timeout, with a 5xx between the two', async () => {
    route(isMetadata, inSequence(hang, S503, hang));

    const { result, elapsedMs } = await runTimed(() =>
      runToolContract(iaGetItem, { identifier: ID }),
    );

    expect(calls(isMetadata)).toHaveLength(3);
    expect(elapsedMs).toBe(10_000 + 1_000 + 2_000 + 10_000);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'The Internet Archive Metadata API timed out after 10 s.',
      data: { reason: 'archive_unavailable' },
    });
  });
});
