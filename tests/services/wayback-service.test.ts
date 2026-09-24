/**
 * @fileoverview Tests for WaybackService — fetchHistory's CDX trailer handling (a
 * truncated query must surface its resume key and must not emit the trailer rows
 * as capture records), and the recovery hint each service-thrown reason forwards
 * from the calling tool's error contract.
 * @module tests/services/wayback-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

describe('WaybackService.fetchHistory CDX trailer handling', () => {
  beforeEach(() => {
    fetchWithTimeout.mockReset();
  });

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

/** The declared recovery string for `reason` on a definition's error contract. */
const declaredRecovery = (
  errors: readonly { reason: string; recovery: string }[] | undefined,
  reason: string,
): string => {
  const entry = errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`contract declares no ${reason}`);
  return entry.recovery;
};

/** An Availability API body as the service reads it (`response.json()`). */
const availability = (body: unknown): Response => ({ json: async () => body }) as Response;

/** A CDX body the service reads as text. */
const cdxText = (text: string): Response => ({ text: async () => text }) as Response;

describe('WaybackService service-thrown reasons carry the caller’s recovery hint', () => {
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

    it('forwards the hint when archived_snapshots is empty', async () => {
      fetchWithTimeout.mockResolvedValueOnce(availability({ archived_snapshots: {} }));

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

    it('forwards the hint when the snapshot URL is not a Wayback replay URL', async () => {
      fetchWithTimeout.mockResolvedValueOnce(
        availability({
          archived_snapshots: {
            closest: { url: 'https://evil.example/x', timestamp: '20200101000000', status: '200' },
          },
        }),
      );

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
