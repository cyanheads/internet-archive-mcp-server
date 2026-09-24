/**
 * @fileoverview Tests for ArchiveMetadataService — the download-path error contract
 * (restricted-item 401/403 → `download_forbidden`), the recovery hint every
 * service-thrown reason forwards from the calling definition's contract, metadata
 * field mapping, and text-file selection across the full manifest.
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
    fetchWithTimeout.mockResolvedValueOnce({ text: async () => 'Full OCR text.' } as Response);

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
