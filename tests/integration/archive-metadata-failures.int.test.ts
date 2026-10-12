/**
 * @fileoverview Upstream-failure coverage for ia_get_item, ia_get_text, and the
 * ia://item resource — the real ArchiveMetadataService, fetchWithTimeout, and retry loop,
 * with only the Metadata API and download HTTP boundary stubbed. Every failure class
 * (header timeout, stalled body, refused or dropped connection, 5xx, 429, 4xx, HTML or
 * unparseable body) is checked for its declared reason, its recovery hint, its attempt
 * count, and the absence of the upstream body, on both the structuredContent and content[]
 * surfaces.
 * @module tests/integration/archive-metadata-failures.int.test
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { iaItemResource } from '@/mcp-server/resources/definitions/ia-item.resource.js';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import { iaGetText } from '@/mcp-server/tools/definitions/ia-get-text.tool.js';
import { initArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** IA_REQUEST_TIMEOUT_MS at its default. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The longest wait between a first and second attempt: the 1 s base backoff plus its 25% jitter. */
const FIRST_BACKOFF_MAX_MS = 1_250;

/** Two timed-out attempts and the backoff between them. */
const TWO_TIMEOUTS_MS = 2 * REQUEST_TIMEOUT_MS + FIRST_BACKOFF_MAX_MS;

const ID = 'a-volume';
const FILE = 'a-volume_djvu.txt';

/** Unmatched requests throw — no test in this file reaches the network. */
const http = createFetchMock();

const isMetadata = (r: Request) => r.url.startsWith('https://archive.org/metadata/');
const isDownload = (r: Request) => r.url.startsWith('https://archive.org/download/');
const calls = (match: (r: Request) => boolean) => http.calls.filter((c) => match(c.request));

const routeMetadata = (respond: FetchMockResponder) => http.route({ match: isMetadata, respond });
const routeDownload = (respond: FetchMockResponder) => http.route({ match: isDownload, respond });

/** A text item's manifest. */
const MANIFEST = () =>
  Response.json({
    metadata: { identifier: ID, title: 'A Volume', mediatype: 'texts' },
    files: [{ name: FILE, format: 'DjVuTXT', size: '119000000' }],
  });

/** The archive.org error page an upstream non-2xx carries, which must never reach the caller. */
const ERROR_PAGE = '<!DOCTYPE html><html><body>upstream-error-page-marker</body></html>';
const status =
  (code: number, headers: Record<string, string> = {}): FetchMockResponder =>
  () =>
    new Response(ERROR_PAGE, {
      status: code,
      headers: { 'content-type': 'text/html', ...headers },
    });

/** A responder that never answers until the request's signal aborts. */
const hang: FetchMockResponder = (request) =>
  new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason));
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
  () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(head));
          queueMicrotask(() => controller.error(new TypeError('terminated')));
        },
      }),
    );

/** Answers each request with the next responder in `sequence`, repeating the last. */
const inSequence = (...sequence: FetchMockResponder[]): FetchMockResponder => {
  let n = 0;
  return (request, ...rest) => {
    const respond = sequence[Math.min(n++, sequence.length - 1)] as FetchMockResponder;
    return respond(request, ...rest);
  };
};

const contentText = (result: ToolResult): string =>
  result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

const errorOf = (result: ToolResult) =>
  (
    result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    }
  ).error;

const hint = (
  errors: readonly { reason: string; recovery: string }[] | undefined,
  reason: string,
) => {
  const entry = errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`contract declares no ${reason}`);
  return entry.recovery;
};

/** Runs a tool under fake timers to completion, reporting the fake time it took. */
const runTimed = async (run: () => Promise<ToolResult>) => {
  vi.useFakeTimers();
  const start = Date.now();
  const pending = run();
  await vi.runAllTimersAsync();
  const result = await pending;
  return { result, elapsedMs: Date.now() - start };
};

const getItem = () => runToolContract(iaGetItem, { identifier: ID });
const getText = (charOffset = 0) =>
  runToolContract(iaGetText, { identifier: ID, char_offset: charOffset });

/** The upstream body never reaches either surface. */
const expectNoBody = (result: ToolResult) => {
  const data = errorOf(result).data;
  expect(data).not.toHaveProperty('body');
  expect(data).not.toHaveProperty('responseBody');
  expect(JSON.stringify(result.structuredContent)).not.toContain('upstream-error-page-marker');
  expect(contentText(result)).not.toContain('upstream-error-page-marker');
};

/** `archive_unavailable` with `recovery` on both surfaces, no upstream body, not marked unretryable. */
const expectUnavailable = (result: ToolResult, recovery: string) => {
  expect(result.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'archive_unavailable', recovery: { hint: recovery } },
    },
  });
  expect(contentText(result)).toContain(`Recovery: ${recovery}`);
  expect(errorOf(result).data).not.toHaveProperty('retryable');
  expect(contentText(result)).not.toContain('not retryable');
  expectNoBody(result);
};

beforeAll(() => {
  initArchiveMetadataService(
    { mcpServerVersion: '0.0.0-test' } as AppConfig,
    createInMemoryStorage(),
  );
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

describe('Metadata and download handling that stays as it was', () => {
  it('ia_get_text serves a page from the manifest and the download', async () => {
    routeMetadata(MANIFEST);
    routeDownload(() => new Response('Chapter one. It was a dark night.'));

    const result = await runToolContract(iaGetText, { identifier: ID, max_chars: 11 });

    expect(result.structuredContent).toMatchObject({
      text: 'Chapter one',
      has_more: true,
      source_file: FILE,
      source_file_bytes: 119_000_000,
    });
    expect(contentText(result)).toContain('Chapter one');
    expect(calls(isMetadata)).toHaveLength(1);
    expect(calls(isDownload)).toHaveLength(1);
  });

  it.each([
    [401, 'login-required'],
    [403, 'limited collection'],
  ])('answers a download %i as download_forbidden after one request', async (code) => {
    routeMetadata(MANIFEST);
    routeDownload(status(code));

    const { result } = await runTimed(() => getText());

    const recovery = hint(iaGetText.errors, 'download_forbidden');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Forbidden,
        data: {
          reason: 'download_forbidden',
          identifier: ID,
          file: FILE,
          recovery: { hint: recovery },
        },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${recovery}`);
    expect(calls(isDownload)).toHaveLength(1);
  });

  it.each([
    ['ia_get_item', getItem, iaGetItem],
    ['ia_get_text', () => getText(), iaGetText],
  ] as const)('%s answers {} as item_not_found after one request', async (_name, run, def) => {
    routeMetadata(() => Response.json({}));

    const { result } = await runTimed(run);

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'item_not_found', recovery: { hint: hint(def.errors, 'item_not_found') } },
      },
    });
    expect(calls(isMetadata)).toHaveLength(1);
  });

  it('ia_get_text answers a manifest without a text file as no_text_file, with no download', async () => {
    routeMetadata(() =>
      Response.json({ metadata: {}, files: [{ name: 'a.mp4', format: 'MPEG4' }] }),
    );

    const { result } = await runTimed(() => getText());

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_text_file' } },
    });
    expect(calls(isDownload)).toHaveLength(0);
  });
});

describe('Metadata API failures surface as archive_unavailable', () => {
  describe.each([
    ['ia_get_item', getItem, iaGetItem],
    ['ia_get_text', () => getText(), iaGetText],
  ] as const)('%s', (_name, run, def) => {
    const declared = () => hint(def.errors, 'archive_unavailable');

    it.each([
      ['headers never arrive', hang],
      ['the body stalls', stall('{"metadata":')],
    ])(
      'answers a second timeout (%s) after two requests, within two request timeouts',
      async (_label, respond) => {
        routeMetadata(respond);

        const { result, elapsedMs } = await runTimed(run);

        expect(calls(isMetadata)).toHaveLength(2);
        expect(elapsedMs).toBeGreaterThanOrEqual(2 * REQUEST_TIMEOUT_MS);
        expect(elapsedMs).toBeLessThanOrEqual(TWO_TIMEOUTS_MS);
        expectUnavailable(result, declared());
        expect(errorOf(result).message).toMatch(/Metadata API timed out after 30 s/);
        expect(calls(isDownload)).toHaveLength(0);
      },
    );

    it.each([
      ['headers never arrive', hang],
      ['the body stalls', stall('{"metadata":')],
    ])('serves the second answer after a first timeout (%s)', async (_label, respond) => {
      routeMetadata(inSequence(respond, MANIFEST));
      routeDownload(() => new Response('Chapter one. It was a dark night.'));

      const { result } = await runTimed(run);

      expect(result.isError).toBeFalsy();
      expect(calls(isMetadata)).toHaveLength(2);
      if (def === iaGetItem) {
        expect(result.structuredContent).toMatchObject({ identifier: ID, title: 'A Volume' });
        expect(contentText(result)).toContain('A Volume');
      } else {
        expect(result.structuredContent).toMatchObject({
          text: 'Chapter one. It was a dark night.',
        });
        expect(contentText(result)).toContain('Chapter one. It was a dark night.');
      }
    });

    it('keeps the 5xx ladder after a first timeout: four attempts in all', async () => {
      routeMetadata(inSequence(hang, status(503)));

      const { result } = await runTimed(run);

      expect(calls(isMetadata)).toHaveLength(4);
      expectUnavailable(result, declared());
      expect(errorOf(result).message).toContain('HTTP 503');
    });

    it('stops at the second timeout even with a 5xx between the two', async () => {
      routeMetadata(inSequence(hang, status(503), hang));

      const { result } = await runTimed(run);

      expect(calls(isMetadata)).toHaveLength(3);
      expectUnavailable(result, declared());
      expect(errorOf(result).message).toMatch(/Metadata API timed out after 30 s/);
    });

    it.each([
      ['a refused connection', refused],
      ['a connection dropped mid-body', dropped('{"metadata":')],
      ['an HTTP 503', status(503)],
      ['an HTTP 500', status(500)],
      ['an HTML page on a 200', () => new Response(ERROR_PAGE)],
      ['an unparseable body', () => new Response('{"metadata": {')],
    ])('answers %s after four attempts', async (_label, respond) => {
      routeMetadata(respond);

      const { result } = await runTimed(run);

      expect(calls(isMetadata)).toHaveLength(4);
      expectUnavailable(result, declared());
    });

    it('answers a 429 after one request with a hint to wait the Retry-After seconds', async () => {
      routeMetadata(status(429, { 'retry-after': '120' }));

      const { result } = await runTimed(run);

      expect(calls(isMetadata)).toHaveLength(1);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: {
            reason: 'archive_unavailable',
            status: 429,
            retryAfter: '120',
            recovery: { hint: expect.stringContaining('wait 120 seconds') },
          },
        },
      });
      expect(contentText(result)).toContain('wait 120 seconds');
      expect(errorOf(result).data).not.toHaveProperty('retryable');
      expectNoBody(result);
    });

    it.each([400, 403, 404, 410, 451])(
      'answers an HTTP %i after one request as a refusal a retry cannot fix',
      async (code) => {
        routeMetadata(status(code));

        const { result } = await runTimed(run);

        expect(calls(isMetadata)).toHaveLength(1);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ServiceUnavailable,
            message: expect.stringContaining(`HTTP ${code}`),
            data: {
              reason: 'archive_unavailable',
              status: code,
              retryable: false,
              recovery: { hint: expect.stringContaining('ia_search_items') },
            },
          },
        });
        expect(contentText(result)).toContain('ia_search_items');
        expect(contentText(result)).not.toContain(declared());
        expectNoBody(result);
      },
    );

    it.each([
      ['an error body for a sub-path identifier', { error: "Couldn't get 'b' for item a" }],
      ['a field value for a sub-path identifier', { result: 27 }],
    ])('answers %s as item_not_found after one request', async (_label, body) => {
      routeMetadata(() => Response.json(body));

      const { result } = await runTimed(run);

      expect(calls(isMetadata)).toHaveLength(1);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'item_not_found',
            recovery: { hint: hint(def.errors, 'item_not_found') },
          },
        },
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain("Couldn't get");
    });

    it('keeps a caller cancellation a cancellation after one request', async () => {
      routeMetadata(hang);
      const controller = new AbortController();

      const pending =
        def === iaGetItem
          ? runToolContract(
              iaGetItem,
              { identifier: ID },
              { context: { signal: controller.signal } },
            )
          : runToolContract(
              iaGetText,
              { identifier: ID },
              { context: { signal: controller.signal } },
            );
      await vi.waitFor(() => expect(calls(isMetadata)).toHaveLength(1));
      controller.abort();
      const result = await pending;

      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      expect(errorOf(result).data?.reason).toBeUndefined();
      expect(calls(isMetadata)).toHaveLength(1);
    });
  });

  it('ia://item answers a Metadata API 503 as archive_unavailable with its own hint', async () => {
    routeMetadata(status(503));
    const ctx = createMockContext({ errors: iaItemResource.errors });

    vi.useFakeTimers();
    const pending = iaItemResource
      .handler(iaItemResource.params.parse({ identifier: ID }), ctx)
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await pending;

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'archive_unavailable',
        recovery: { hint: hint(iaItemResource.errors, 'archive_unavailable') },
      },
    });
    expect(err).not.toHaveProperty('data.body');
    expect(calls(isMetadata)).toHaveLength(4);
  });
});

describe('ia_get_text download failures surface as archive_unavailable', () => {
  const declared = () => hint(iaGetText.errors, 'archive_unavailable');

  beforeEach(() => {
    routeMetadata(MANIFEST);
  });

  it('answers a second header timeout after two download requests, within two request timeouts', async () => {
    routeDownload(hang);

    const { result, elapsedMs } = await runTimed(() => getText());

    expect(calls(isDownload)).toHaveLength(2);
    expect(calls(isMetadata)).toHaveLength(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(2 * REQUEST_TIMEOUT_MS);
    expect(elapsedMs).toBeLessThanOrEqual(TWO_TIMEOUTS_MS);
    expectUnavailable(result, declared());
    expect(errorOf(result).message).toContain(`download of "${FILE}" timed out after 30 s`);
  });

  it('answers a deep page whose read stalls mid-file twice after two download requests', async () => {
    /** The file streams 1 MiB of text, then stops before the page at char_offset 5,000,000. */
    routeDownload(stall('x'.repeat(1024 * 1024)));

    const { result, elapsedMs } = await runTimed(() => getText(5_000_000));

    expect(calls(isDownload)).toHaveLength(2);
    expect(elapsedMs).toBeLessThanOrEqual(TWO_TIMEOUTS_MS);
    expectUnavailable(result, declared());
    expect(declared()).toMatch(/can time out the same way; the download_url/);
  });

  it.each([
    ['headers never arrive', hang],
    ['the body stalls', stall('Chapter')],
  ])('serves the page from a second download after a first timeout (%s)', async (_l, respond) => {
    routeDownload(inSequence(respond, () => new Response('Chapter one. It was a dark night.')));

    const { result } = await runTimed(() => getText());

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      text: 'Chapter one. It was a dark night.',
      has_more: false,
      source_file: FILE,
    });
    expect(contentText(result)).toContain('Chapter one. It was a dark night.');
    expect(calls(isDownload)).toHaveLength(2);
    expect(calls(isMetadata)).toHaveLength(1);
  });

  it('gives the metadata request and the download one timeout retry each', async () => {
    http.reset();
    routeMetadata(inSequence(hang, MANIFEST));
    routeDownload(inSequence(hang, () => new Response('Chapter one.')));

    const { result } = await runTimed(() => getText());

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ text: 'Chapter one.' });
    expect(calls(isMetadata)).toHaveLength(2);
    expect(calls(isDownload)).toHaveLength(2);
  });

  it.each([
    ['a refused connection', refused],
    ['a connection dropped mid-body', dropped('Chapter one.')],
    ['an HTTP 503', status(503)],
    ['an HTTP 502', status(502)],
  ])('answers %s after four download attempts', async (_label, respond) => {
    routeDownload(respond);

    const { result } = await runTimed(() => getText());

    expect(calls(isDownload)).toHaveLength(4);
    expect(calls(isMetadata)).toHaveLength(1);
    expectUnavailable(result, declared());
  });

  it('answers a download 429 after one request with a hint to wait', async () => {
    routeDownload(status(429));

    const { result } = await runTimed(() => getText());

    expect(calls(isDownload)).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'archive_unavailable',
          status: 429,
          recovery: { hint: expect.stringContaining('wait several minutes') },
        },
      },
    });
    expect(errorOf(result).data).not.toHaveProperty('retryable');
    expectNoBody(result);
  });

  it.each([404, 410, 451])(
    'answers a download %i after one request, pointing at the manifest',
    async (code) => {
      routeDownload(status(code));

      const { result } = await runTimed(() => getText());

      expect(calls(isDownload)).toHaveLength(1);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringContaining(`HTTP ${code}`),
          data: {
            reason: 'archive_unavailable',
            status: code,
            retryable: false,
            recovery: { hint: expect.stringContaining('ia_get_item') },
          },
        },
      });
      expect(contentText(result)).not.toContain(declared());
      expectNoBody(result);
    },
  );

  it('keeps a caller cancellation during the download a cancellation after one request', async () => {
    routeDownload(hang);
    const controller = new AbortController();

    const pending = runToolContract(
      iaGetText,
      { identifier: ID },
      { context: { signal: controller.signal } },
    );
    await vi.waitFor(() => expect(calls(isDownload)).toHaveLength(1));
    controller.abort();
    const result = await pending;

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(errorOf(result).data?.reason).toBeUndefined();
    expect(calls(isDownload)).toHaveLength(1);
  });
});
