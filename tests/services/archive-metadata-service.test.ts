/**
 * @fileoverview Tests for the ArchiveMetadataService download-path error contract —
 * restricted-item 401/403 responses must surface as the declared `download_forbidden`
 * reason with its recovery hint, and other failures must pass through untouched.
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
