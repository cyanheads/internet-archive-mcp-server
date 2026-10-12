/**
 * @fileoverview Tests for ArchiveMetadataService — the download-path error contract
 * (restricted-item 401/403 → `download_forbidden`), the recovery hint every
 * service-thrown reason forwards from the calling definition's contract, metadata
 * field mapping, text-file selection across the full manifest, and the streamed page
 * read (whole-text equality, early stop, cancellation).
 * @module tests/services/archive-metadata-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: Parameters<typeof fetchWithTimeout>) => fetchWithTimeout(...args),
    withRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

import { iaItemResource } from '@/mcp-server/resources/definitions/ia-item.resource.js';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import { iaGetText } from '@/mcp-server/tools/definitions/ia-get-text.tool.js';
import { ArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

/** Metadata API response for an item with one readable text file. */
const metadataResponse = {
  text: async () =>
    JSON.stringify({
      metadata: { title: 'A Book' },
      files: [{ name: 'a-book_djvu.txt', format: 'Text' }],
    }),
} as Response;

/** Mirror of fetchWithTimeout's status-mapped error for a non-2xx download response. */
const statusError = (code: JsonRpcErrorCode, status: number): McpError =>
  new McpError(code, `Upstream returned HTTP ${status}.`, { status });

const buildService = (): ArchiveMetadataService =>
  new ArchiveMetadataService({ mcpServerVersion: '0.0.0-test' } as AppConfig, {} as StorageService);

describe('ArchiveMetadataService.getTextContent download contract', () => {
  beforeEach(() => {
    fetchWithTimeout.mockReset();
    // First call = metadata lookup succeeds; the download call is configured per-test.
    fetchWithTimeout.mockResolvedValueOnce(metadataResponse);
  });

  it('declares expectedStatuses [401, 403] on the download fetch', async () => {
    fetchWithTimeout.mockRejectedValueOnce(statusError(JsonRpcErrorCode.Forbidden, 403));

    const svc = buildService();
    const ctx = createMockContext({ errors: iaGetText.errors });
    await svc.getTextContent('restricted-item', 100, 0, ctx).catch(() => undefined);

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      expect.stringContaining('https://archive.org/download/restricted-item'),
      expect.any(Number),
      expect.anything(),
      expect.objectContaining({ expectedStatuses: [401, 403] }),
    );
  });

  it('remaps HTTP 403 to download_forbidden with the declared recovery hint', async () => {
    fetchWithTimeout.mockRejectedValueOnce(statusError(JsonRpcErrorCode.Forbidden, 403));

    const svc = buildService();
    const ctx = createMockContext({ errors: iaGetText.errors });

    await expect(svc.getTextContent('restricted-item', 100, 0, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: {
        reason: 'download_forbidden',
        identifier: 'restricted-item',
        file: 'a-book_djvu.txt',
        recovery: {
          hint: expect.stringContaining('restricted collection'),
        },
      },
    });
  });

  it('remaps HTTP 401 (login-required download) to download_forbidden as well', async () => {
    fetchWithTimeout.mockRejectedValueOnce(statusError(JsonRpcErrorCode.Unauthorized, 401));

    const svc = buildService();
    const ctx = createMockContext({ errors: iaGetText.errors });

    await expect(svc.getTextContent('login-item', 100, 0, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: {
        reason: 'download_forbidden',
        identifier: 'login-item',
        recovery: {
          hint: expect.stringContaining('restricted collection'),
        },
      },
    });
  });

  it('passes unrelated McpErrors through without remapping', async () => {
    const upstream = notFound('Item vanished.', { identifier: 'gone-item' });
    fetchWithTimeout.mockRejectedValueOnce(upstream);

    const svc = buildService();
    const ctx = createMockContext({ errors: iaGetText.errors });

    await expect(svc.getTextContent('gone-item', 100, 0, ctx)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBe(upstream);
      return true;
    });
  });
});

/** A Metadata API body as the service reads it (`response.text()`). */
const jsonBody = (body: unknown): Response =>
  ({ text: async () => JSON.stringify(body) }) as Response;

/** Reject any fetch a test did not stage, so an unexpected upstream call fails loudly. */
const rejectUnstagedFetches = (): void => {
  fetchWithTimeout.mockReset();
  fetchWithTimeout.mockImplementation((url: string) =>
    Promise.reject(new Error(`unmocked fetch: ${url}`)),
  );
};

describe('ArchiveMetadataService.getItem field mapping', () => {
  beforeEach(rejectUnstagedFetches);

  it('passes an array-valued language through unchanged', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({
        metadata: { title: 'Protestant review', language: ['German', 'English', 'French'] },
        files: [],
      }),
    );

    const item = await buildService().getItem('multi-lang', createMockContext());

    expect(item.metadata.language).toEqual(['German', 'English', 'French']);
  });

  it('keeps a single language as a plain string', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({ metadata: { title: 'Pride and prejudice', language: 'eng' }, files: [] }),
    );

    const item = await buildService().getItem('one-lang', createMockContext());

    expect(item.metadata.language).toBe('eng');
  });
});

describe('ArchiveMetadataService.getTextContent text-file selection', () => {
  beforeEach(rejectUnstagedFetches);

  it('finds a DjVuTXT file positioned far past the first 50 manifest entries', async () => {
    const files = Array.from({ length: 120 }, (_, i) => ({
      name: `page_${String(i).padStart(3, '0')}.jpg`,
      format: 'JPEG Thumb',
    }));
    files[100] = { name: 'big-item_djvu.txt', format: 'DjVuTXT' };
    fetchWithTimeout.mockResolvedValueOnce(jsonBody({ metadata: { title: 'Big' }, files }));
    fetchWithTimeout.mockResolvedValueOnce(new Response('Full OCR text.'));

    const result = await buildService().getTextContent('big-item', 100, 0, createMockContext());

    expect(result.sourceFile).toBe('big-item_djvu.txt');
    expect(result.text).toBe('Full OCR text.');
    expect(fetchWithTimeout).toHaveBeenLastCalledWith(
      'https://archive.org/download/big-item/big-item_djvu.txt',
      expect.any(Number),
      expect.anything(),
      expect.anything(),
    );
  });
});

/** Seeded PRNG (mulberry32) so a sweep is reproducible run to run. */
const seededRandom = (seed: number): (() => number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Pull and cancel counts observed on a streamed download body. */
interface BodyStats {
  cancelled: boolean;
  pulls: number;
}

/**
 * A download response whose body is served one chunk per pull (no read-ahead), recording
 * how many chunks were pulled and whether the body was cancelled. `chunkAt` returns
 * `undefined` past the last chunk.
 */
const streamedDownload = (
  chunkAt: (index: number) => Uint8Array | undefined,
): { response: Response; stats: BodyStats } => {
  const stats: BodyStats = { cancelled: false, pulls: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunkAt(stats.pulls++);
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(body), stats };
};

/** Split `bytes` into chunks of seeded sizes between 1 and `maxSize` bytes. */
const splitBytes = (bytes: Uint8Array, maxSize: number, random: () => number): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    const size = 1 + Math.floor(random() * maxSize);
    chunks.push(bytes.subarray(at, at + size));
    at += size;
  }
  return chunks;
};

/** Byte offsets where one chunk ends and the next begins. */
const chunkBoundaries = (chunks: readonly Uint8Array[]): number[] => {
  const boundaries: number[] = [];
  let at = 0;
  for (const chunk of chunks.slice(0, -1)) {
    at += chunk.byteLength;
    boundaries.push(at);
  }
  return boundaries;
};

const isContinuationByte = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80;

/**
 * Mixed-script fixture: ASCII, Cyrillic (2-byte UTF-8), CJK and Devanagari (3-byte),
 * astral emoji and musical symbols (4-byte UTF-8, surrogate pairs in UTF-16), and a
 * combining accent.
 */
const mixedScriptText = (random: () => number, pieces: number): string => {
  const vocabulary = ['The ', 'Глава ', '第一章 ', '📜', '🦉 ', 'naïve ', 'é ', '\n', 'ऄ', '𝄞'];
  return Array.from(
    { length: pieces },
    () => vocabulary[Math.floor(random() * vocabulary.length)],
  ).join('');
};

/** A manifest naming one DjVuTXT file, with `size` when given. */
const textManifest = (size?: string): Response =>
  jsonBody({
    metadata: { title: 'A Volume' },
    files: [{ name: 'volume_djvu.txt', format: 'DjVuTXT', ...(size !== undefined && { size }) }],
  });

describe('ArchiveMetadataService.getTextContent streamed page read', () => {
  beforeEach(rejectUnstagedFetches);

  /** Stage the manifest and one streamed download, then read one page. */
  const readPage = async (
    chunks: readonly Uint8Array[] | ((index: number) => Uint8Array | undefined),
    maxChars: number,
    charOffset: number,
    size?: string,
  ) => {
    const { response, stats } = streamedDownload(
      typeof chunks === 'function' ? chunks : (i) => chunks[i],
    );
    fetchWithTimeout.mockResolvedValueOnce(textManifest(size));
    fetchWithTimeout.mockResolvedValueOnce(response);
    const result = await buildService().getTextContent(
      'a-volume',
      maxChars,
      charOffset,
      createMockContext({ errors: iaGetText.errors }),
    );
    return { result, stats };
  };

  const random = seededRandom(33);
  const fixtureText = mixedScriptText(random, 700);
  const fixtureBytes = new TextEncoder().encode(fixtureText);
  const fixtureChunks = splitBytes(fixtureBytes, 7, random);
  /** What the whole-text read returned: the decoded file, sliced. */
  const whole = new TextDecoder().decode(fixtureBytes);
  const wholePage = (charOffset: number, maxChars: number) => ({
    text: whole.slice(charOffset, charOffset + maxChars),
    hasMore: charOffset + maxChars < whole.length,
  });

  /** Seeded (char_offset, max_chars) pairs plus the fixed edge cases. */
  const sweep: [charOffset: number, maxChars: number][] = [
    [0, whole.length],
    [0, whole.length - 1],
    [whole.length - 40, 40],
    [whole.length - 40, 39],
    [whole.length - 1, 1],
    [whole.length, 1],
    [whole.length + 25, 10],
    ...Array.from({ length: 300 }, (): [number, number] => [
      Math.floor(random() * (whole.length + 20)),
      1 + Math.floor(random() * (random() < 0.9 ? 300 : whole.length)),
    ]),
  ];

  it('builds a fixture whose chunk boundaries split multi-byte and astral sequences', () => {
    const splits = chunkBoundaries(fixtureChunks).filter((b) =>
      isContinuationByte(fixtureBytes[b]),
    );
    const leadByteOf = (b: number): number => {
      let at = b;
      while (isContinuationByte(fixtureBytes[at])) at--;
      return fixtureBytes[at] as number;
    };

    expect(fixtureChunks.length).toBeGreaterThan(100);
    expect(splits.length).toBeGreaterThan(10);
    expect(splits.some((b) => leadByteOf(b) >= 0xf0)).toBe(true);
    expect(whole).toContain('\u{1F4DC}');
  });

  it('serves the same text and has_more as slicing the whole decoded file, across a seeded sweep', {
    timeout: 30_000,
  }, async () => {
    for (const [charOffset, maxChars] of sweep) {
      const { result } = await readPage(fixtureChunks, maxChars, charOffset);
      expect(
        { text: result.text, hasMore: result.hasMore },
        `char_offset ${charOffset}, max_chars ${maxChars}`,
      ).toEqual(wholePage(charOffset, maxChars));
    }
  });

  it('strips a leading byte-order mark split across chunks, as the whole-text read did', async () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Глава 📜 one')]);
    const chunks = splitBytes(withBom, 2, seededRandom(7));

    const { result } = await readPage(chunks, 7, 0);

    expect(result.text).toBe(new TextDecoder().decode(withBom).slice(0, 7));
    expect(result.text.startsWith('Глава')).toBe(true);
    expect(result.hasMore).toBe(true);
  });

  it('decodes malformed, truncated, and mid-file byte-order-mark bytes as the whole-text read did, across chunk splits', async () => {
    const encode = (s: string) => [...new TextEncoder().encode(s)];
    const bytes = new Uint8Array([
      ...encode('Глава '),
      ...[0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xff, 0xfe],
      ...encode('📜 mid'),
      ...[0xef, 0xbb, 0xbf, 0x80],
      ...encode('𝄞 end'),
      ...[0xf0, 0x9f, 0x98],
    ]);
    const expected = await new Response(bytes).text();

    for (const maxSize of [1, 2, 3, 5]) {
      const { result } = await readPage(
        splitBytes(bytes, maxSize, seededRandom(maxSize)),
        1_000,
        0,
      );
      expect(result.text, `chunks of up to ${maxSize} bytes`).toBe(expected);
    }
  });

  it('keeps a mid-file U+FEFF when the first chunk ends inside a character', async () => {
    const bytes = new Uint8Array([0xd0, 0x93, 0xef, 0xbb, 0xbf, 0x61]);

    const { result } = await readPage([bytes.subarray(0, 1), bytes.subarray(1)], 10, 0);

    expect(result.text).toBe(await new Response(bytes).text());
    expect(result.text).toBe('Г\u{feff}a');
  });

  it('serves a page ending exactly at end of file with has_more false after reading to the end', async () => {
    const { result, stats } = await readPage(fixtureChunks, 40, whole.length - 40);

    expect(stats.pulls).toBe(fixtureChunks.length + 1);
    expect(stats.cancelled).toBe(false);
    expect(result.text).toBe(whole.slice(-40));
    expect(result.hasMore).toBe(false);
  });

  it('serves empty text and has_more false for an offset past the end', async () => {
    const { result } = await readPage(fixtureChunks, 100, whole.length + 1_000);

    expect(result.text).toBe('');
    expect(result.hasMore).toBe(false);
  });

  it('serves empty text and has_more false for an empty file', async () => {
    const { result, stats } = await readPage([], 100, 0);

    expect(result.text).toBe('');
    expect(result.hasMore).toBe(false);
    expect(stats.pulls).toBe(1);
  });

  /** 20 MB of synthetic ASCII, generated per pull: chunk i is 1 KiB of one letter. */
  const CHUNK = 1_024;
  const CHUNK_COUNT = 20_000;
  const letterChunk = (i: number): Uint8Array | undefined =>
    i < CHUNK_COUNT ? new Uint8Array(CHUNK).fill(97 + (i % 26)) : undefined;
  const letterText = (from: number, length: number): string =>
    Array.from({ length }, (_, k) =>
      String.fromCharCode(97 + (Math.floor((from + k) / CHUNK) % 26)),
    ).join('');

  it('stops a page near the start of a large body after the first chunks and cancels the rest', async () => {
    const { result, stats } = await readPage(letterChunk, 2_000, 0);

    expect(stats.pulls).toBe(2);
    expect(stats.cancelled).toBe(true);
    expect(result.text).toBe(letterText(0, 2_000));
    expect(result.hasMore).toBe(true);
  });

  it('stops a mid-body page at the chunk holding the character after the window', async () => {
    const charOffset = 1_000_000;
    const { result, stats } = await readPage(letterChunk, 1_000, charOffset);

    // The character after the window (index 1,001,000) sits in chunk 977 (0-based).
    expect(stats.pulls).toBe(978);
    expect(stats.cancelled).toBe(true);
    expect(result.text).toBe(letterText(charOffset, 1_000));
    expect(result.hasMore).toBe(true);
  });

  it('cancels when the window ends exactly at a chunk boundary and more follows', async () => {
    const { result, stats } = await readPage(letterChunk, CHUNK, 0);

    expect(stats.pulls).toBe(2);
    expect(stats.cancelled).toBe(true);
    expect(result.text).toBe(letterText(0, CHUNK));
    expect(result.hasMore).toBe(true);
  });

  it('propagates an error raised while the body is still streaming', async () => {
    const stalled = new McpError(JsonRpcErrorCode.Timeout, 'Body read timed out.');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial page'));
        controller.error(stalled);
      },
    });
    fetchWithTimeout.mockResolvedValueOnce(textManifest());
    fetchWithTimeout.mockResolvedValueOnce(new Response(body));

    await expect(
      buildService().getTextContent('a-volume', 100, 0, createMockContext()),
    ).rejects.toBe(stalled);
  });

  it('carries the manifest size as sourceFileBytes', async () => {
    const { result } = await readPage(fixtureChunks, 10, 0, '9915421');

    expect(result.sourceFileBytes).toBe(9_915_421);
  });

  it('omits sourceFileBytes when the manifest lists no size', async () => {
    const { result } = await readPage(fixtureChunks, 10, 0);

    expect(result).not.toHaveProperty('sourceFileBytes');
  });
});

/** The declared recovery string for `reason` on a definition's error contract. */
const declaredRecovery = (
  errors: readonly { reason: string; recovery: string }[] | undefined,
  reason: string,
): string => {
  const entry = errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`contract declares no ${reason}`);
  return entry.recovery;
};

describe('ArchiveMetadataService service-thrown reasons carry the caller’s recovery hint', () => {
  beforeEach(rejectUnstagedFetches);

  const callers = [
    ['ia_get_item', iaGetItem.errors],
    ['ia_get_text', iaGetText.errors],
    ['ia://item/{identifier}', iaItemResource.errors],
  ] as const;

  describe.each(callers)('item_not_found under the %s contract', (_name, errors) => {
    const hint = declaredRecovery(errors, 'item_not_found');

    it('forwards the hint when the Metadata API returns {} (unknown identifier)', async () => {
      fetchWithTimeout.mockResolvedValueOnce(jsonBody({}));

      await expect(
        buildService().getItem('no-such-item', createMockContext({ errors })),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: 'Item "no-such-item" not found in the Internet Archive.',
        data: { reason: 'item_not_found', identifier: 'no-such-item', recovery: { hint } },
      });
    });

    it('forwards the hint when the item is dark', async () => {
      fetchWithTimeout.mockResolvedValueOnce(
        jsonBody({ is_dark: true, server: 'ia800000.us.archive.org', dir: '/0/items/x' }),
      );

      await expect(
        buildService().getItem('dark-item', createMockContext({ errors })),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: 'Item "dark-item" is dark (restricted) in the Internet Archive.',
        data: { reason: 'item_not_found', identifier: 'dark-item', recovery: { hint } },
      });
    });
  });

  it('resolves different item_not_found hints for the tool and resource contracts', () => {
    expect(declaredRecovery(iaGetItem.errors, 'item_not_found')).not.toBe(
      declaredRecovery(iaItemResource.errors, 'item_not_found'),
    );
  });

  it('forwards the ia_get_text hint on no_text_file', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({
        metadata: { title: 'A Film' },
        files: [{ name: 'film.mp4', format: 'MPEG4' }],
      }),
    );

    await expect(
      buildService().getTextContent(
        'film-item',
        100,
        0,
        createMockContext({ errors: iaGetText.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'no_text_file',
        identifier: 'film-item',
        recovery: { hint: declaredRecovery(iaGetText.errors, 'no_text_file') },
      },
    });
  });
});
