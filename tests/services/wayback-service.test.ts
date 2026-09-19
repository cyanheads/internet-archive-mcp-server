/**
 * @fileoverview Tests for WaybackService.fetchHistory's CDX trailer handling — a
 * truncated query must surface its resume key and must not emit the trailer rows
 * as capture records.
 * @module tests/services/wayback-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
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

import { iaFindSnapshots } from '@/mcp-server/tools/definitions/ia-find-snapshots.tool.js';
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
