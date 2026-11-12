/**
 * @fileoverview Tests for the ia_find_snapshots tool.
 * @module tests/tools/ia-find-snapshots.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iaFindSnapshots } from '@/mcp-server/tools/definitions/ia-find-snapshots.tool.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Every text block of the assembled result. */
const contentText = (result: ToolResult): string =>
  result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

// Mock the wayback service module so no real HTTP calls are made.
vi.mock('@/services/wayback/wayback-service.js', () => ({
  getWaybackService: vi.fn(),
}));

import { getWaybackService } from '@/services/wayback/wayback-service.js';

const mockService = {
  findClosest: vi.fn(),
  fetchHistory: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (getWaybackService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

describe('iaFindSnapshots', () => {
  describe('mode: closest', () => {
    it('returns a single snapshot for a valid closest lookup', async () => {
      mockService.findClosest.mockResolvedValue({
        snapshotUrl: 'https://web.archive.org/web/20200101120000/https://example.com',
        timestamp: '20200101120000',
        status: '200',
      });

      const ctx = createMockContext({ errors: iaFindSnapshots.errors });
      const input = iaFindSnapshots.input.parse({
        url: 'https://example.com',
        mode: 'closest',
        timestamp: '20200101',
      });
      const result = await iaFindSnapshots.handler(input, ctx);

      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0].timestamp).toBe('20200101120000');
      expect(result.snapshots[0].replay_url).toBe(
        'https://web.archive.org/web/20200101120000/https://example.com',
      );
      expect(result.snapshots[0].statuscode).toBe('200');
      expect(result.resume_key).toBeUndefined();
    });

    it.each([
      ['omitted', undefined],
      ['empty', ''],
      ['whitespace-only', '   '],
    ])(
      'throws missing_timestamp when the timestamp is %s, without a lookup',
      async (_label, timestamp) => {
        const ctx = createMockContext({ errors: iaFindSnapshots.errors });
        const input = iaFindSnapshots.input.parse({
          url: 'https://example.com',
          mode: 'closest',
          ...(timestamp !== undefined && { timestamp }),
        });

        const err = await iaFindSnapshots.handler(input, ctx).catch((e: unknown) => e);

        expect(err).toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'missing_timestamp' },
        });
        const hint = (err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
        expect(hint).toContain('timestamp');
        expect(hint).toContain('YYYYMMDDHHMMSS');
        expect(hint).toContain('history');
        expect(mockService.findClosest).not.toHaveBeenCalled();
      },
    );

    it('renders missing_timestamp with its Recovery line in content[]', async () => {
      const result = await runToolContract(iaFindSnapshots, {
        url: 'https://example.com',
        mode: 'closest',
        timestamp: '  ',
      });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: unknown }).error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'missing_timestamp' },
      });
      const text = contentText(result);
      expect(text).toMatch(/^Recovery: .*timestamp.*YYYYMMDDHHMMSS/m);
      expect(text).toContain('(reason missing_timestamp');
      expect(text).not.toContain('no_snapshot_available');
      expect(mockService.findClosest).not.toHaveBeenCalled();
    });

    it('propagates no_snapshot_available from the service (empty archived_snapshots)', async () => {
      const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
      mockService.findClosest.mockRejectedValue(
        notFound('No snapshot available for https://example.com near 20200101.', {
          reason: 'no_snapshot_available',
        }),
      );

      const ctx = createMockContext({ errors: iaFindSnapshots.errors });
      const input = iaFindSnapshots.input.parse({
        url: 'https://example.com',
        mode: 'closest',
        timestamp: '20200101',
      });

      await expect(iaFindSnapshots.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_snapshot_available' },
      });
      expect(mockService.findClosest).toHaveBeenCalledWith(
        'https://example.com',
        '20200101',
        expect.anything(),
      );
    });

    it.each([
      ['an ISO date', '2020-06-15', '20200615'],
      ['an ISO UTC date-time', ' 2020-06-15T12:34:56Z ', '20200615123456'],
      ['a 3-digit prefix', '201', '201'],
    ])('looks up %s as its digit timestamp', async (_label, timestamp, digits) => {
      mockService.findClosest.mockResolvedValue({
        snapshotUrl: 'https://web.archive.org/web/20200615000000/https://www.nasa.gov/',
        timestamp: '20200615000000',
        status: '200',
      });

      const result = await runToolContract(iaFindSnapshots, {
        url: 'https://www.nasa.gov/',
        mode: 'closest',
        timestamp,
      });

      expect(result.isError).toBeFalsy();
      expect(mockService.findClosest).toHaveBeenCalledWith(
        'https://www.nasa.gov/',
        digits,
        expect.anything(),
      );
    });

    it.each([
      ['a month name', 'January 2015'],
      ['an impossible month', '20151345'],
      ['15 digits', '201506150527291'],
      ['a UTC offset', '2020-06-15T12:34:56+02:00'],
    ])(
      'rejects %s as invalid_timestamp naming timestamp on both surfaces, without a lookup',
      async (_label, timestamp) => {
        const result = await runToolContract(iaFindSnapshots, {
          url: 'example.com',
          mode: 'closest',
          timestamp,
        });

        const recovery = iaFindSnapshots.errors?.find(
          (e) => e.reason === 'invalid_timestamp',
        )?.recovery;
        expect(recovery).toBeDefined();
        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: unknown }).error).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringMatching(/^timestamp .*1–14 digits.*ISO 8601/),
          data: { reason: 'invalid_timestamp', field: 'timestamp', recovery: { hint: recovery } },
        });
        const text = contentText(result);
        expect(text).toContain(`Recovery: ${recovery}`);
        expect(text).toContain('(reason invalid_timestamp');
        expect(mockService.findClosest).not.toHaveBeenCalled();
      },
    );

    it('does not read from or to, which only history mode uses', async () => {
      mockService.findClosest.mockResolvedValue({
        snapshotUrl: 'https://web.archive.org/web/20200101120000/https://example.com',
        timestamp: '20200101120000',
        status: '200',
      });

      const result = await runToolContract(iaFindSnapshots, {
        url: 'example.com',
        mode: 'closest',
        timestamp: '20200101',
        from: 'January 2015',
        to: '2015/12/31',
      });

      expect(result.isError).toBeFalsy();
    });

    it('propagates a service-thrown availability_unavailable unchanged', async () => {
      const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
      const unavailable = serviceUnavailable('Wayback Availability API returned HTTP 503.', {
        reason: 'availability_unavailable',
      });
      mockService.findClosest.mockRejectedValue(unavailable);

      const ctx = createMockContext({ errors: iaFindSnapshots.errors });
      const input = iaFindSnapshots.input.parse({
        url: 'https://example.com',
        mode: 'closest',
        timestamp: '20200101',
      });

      await expect(iaFindSnapshots.handler(input, ctx)).rejects.toBe(unavailable);
    });
  });

  describe('mode: history', () => {
    it('returns CDX records with replay URLs', async () => {
      mockService.fetchHistory.mockResolvedValue({
        records: [
          {
            timestamp: '20200601120000',
            statuscode: '200',
            mimetype: 'text/html',
            original: 'https://example.com/',
            digest: 'ABCDEF1234',
          },
        ],
      });

      const ctx = createMockContext({ errors: iaFindSnapshots.errors });
      const input = iaFindSnapshots.input.parse({
        url: 'https://example.com',
        mode: 'history',
      });
      const result = await iaFindSnapshots.handler(input, ctx);

      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0].timestamp).toBe('20200601120000');
      expect(result.snapshots[0].replay_url).toContain('20200601120000');
      expect(result.snapshots[0].statuscode).toBe('200');
      expect(result.snapshots[0].mimetype).toBe('text/html');
      expect(result.resume_key).toBeUndefined();
    });

    it('includes resume_key in output when service returns one', async () => {
      mockService.fetchHistory.mockResolvedValue({
        records: [
          {
            timestamp: '20200601120000',
            statuscode: '200',
            mimetype: 'text/html',
            original: 'https://example.com/',
            digest: 'XYZ',
          },
        ],
        resumeKey: 'abc123resumekey',
      });

      const ctx = createMockContext({ errors: iaFindSnapshots.errors });
      const input = iaFindSnapshots.input.parse({
        url: 'https://example.com',
        mode: 'history',
      });
      const result = await iaFindSnapshots.handler(input, ctx);

      expect(result.resume_key).toBe('abc123resumekey');
    });

    it('throws no_snapshots when CDX returns zero records', async () => {
      mockService.fetchHistory.mockResolvedValue({ records: [] });

      const ctx = createMockContext({ errors: iaFindSnapshots.errors });
      const input = iaFindSnapshots.input.parse({
        url: 'https://no-snapshots.example.com',
        mode: 'history',
      });

      await expect(iaFindSnapshots.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_snapshots' },
      });
    });

    const oneRecord = {
      records: [
        {
          timestamp: '20150105000000',
          statuscode: '200',
          mimetype: 'text/html',
          original: 'https://example.com/',
          digest: 'X',
        },
      ],
    };

    it.each([
      ['ISO dates', '2015-01-01', '2015-02-01', '20150101', '20150201'],
      [
        'ISO date-times',
        '2015-01-01T00:00Z',
        '2015-02-01T23:59:59Z',
        '201501010000',
        '20150201235959',
      ],
      ['3-digit prefixes', '201', '201', '201', '201'],
      ['an 8-digit from and a year to', '20150615', '2015', '20150615', '2015'],
      ['a reversed range', '20160101', '20150101', '20160101', '20150101'],
    ])('sends %s to CDX as their digit timestamps', async (_label, from, to, cdxFrom, cdxTo) => {
      mockService.fetchHistory.mockResolvedValue(oneRecord);

      const result = await runToolContract(iaFindSnapshots, {
        url: 'example.com',
        mode: 'history',
        from,
        to,
      });

      expect(result.isError).toBeFalsy();
      expect(mockService.fetchHistory).toHaveBeenCalledWith(
        expect.objectContaining({ from: cdxFrom, to: cdxTo }),
        expect.anything(),
      );
    });

    it.each([
      ['from', 'January 2015'],
      ['from', '2015/01/01'],
      ['to', '20151345'],
      ['to', '2015-06-15T12:34:56+02:00'],
    ] as const)(
      'rejects %s %s as invalid_timestamp naming that field, without a CDX query',
      async (field, value) => {
        const result = await runToolContract(iaFindSnapshots, {
          url: 'example.com',
          mode: 'history',
          [field]: value,
        });

        expect((result.structuredContent as { error: unknown }).error).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringMatching(new RegExp(`^${field} `)),
          data: { reason: 'invalid_timestamp', field },
        });
        expect(contentText(result)).toContain('(reason invalid_timestamp');
        expect(mockService.fetchHistory).not.toHaveBeenCalled();
      },
    );

    it('does not read timestamp, which only closest mode uses', async () => {
      mockService.fetchHistory.mockResolvedValue(oneRecord);

      const result = await runToolContract(iaFindSnapshots, {
        url: 'example.com',
        mode: 'history',
        timestamp: 'January 2015',
      });

      expect(result.isError).toBeFalsy();
    });

    it('passes collapse="" as undefined to service, which applies its timestamp:8 default', async () => {
      mockService.fetchHistory.mockResolvedValue({
        records: [
          {
            timestamp: '20200601120000',
            statuscode: '200',
            mimetype: 'text/html',
            original: 'https://example.com/',
            digest: 'X',
          },
        ],
      });

      const ctx = createMockContext({ errors: iaFindSnapshots.errors });
      const input = iaFindSnapshots.input.parse({
        url: 'https://example.com',
        mode: 'history',
        collapse: '',
      });
      await iaFindSnapshots.handler(input, ctx);

      expect(mockService.fetchHistory).toHaveBeenCalledWith(
        expect.objectContaining({ collapse: undefined }),
        expect.anything(),
      );
    });
  });

  describe('blank url', () => {
    it.each([
      ['empty', 'closest', ''],
      ['whitespace-only', 'closest', '  '],
      ['empty', 'history', ''],
      ['whitespace-only', 'history', '  '],
    ] as const)(
      'rejects the %s url in %s mode as invalid_arguments without a lookup',
      async (_label, mode, url) => {
        const result = await runToolContract(iaFindSnapshots, {
          url,
          mode,
          timestamp: '20200101',
        });

        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: unknown }).error).toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments' },
        });
        expect(contentText(result)).toContain('url: Must not be blank');
        expect(mockService.findClosest).not.toHaveBeenCalled();
        expect(mockService.fetchHistory).not.toHaveBeenCalled();
      },
    );

    it('trims surrounding whitespace from the url before the lookup', async () => {
      mockService.findClosest.mockResolvedValue({
        snapshotUrl: 'https://web.archive.org/web/20200101120000/https://example.com',
        timestamp: '20200101120000',
        status: '200',
      });

      await runToolContract(iaFindSnapshots, {
        url: '  https://example.com ',
        mode: 'closest',
        timestamp: '20200101',
      });

      expect(mockService.findClosest).toHaveBeenCalledWith(
        'https://example.com',
        '20200101',
        expect.anything(),
      );
    });
  });

  describe('format', () => {
    it('renders snapshot timestamp and replay URL in text', () => {
      const result = {
        snapshots: [
          {
            timestamp: '20200101120000',
            replay_url: 'https://web.archive.org/web/20200101120000/https://example.com',
            statuscode: '200',
          },
        ],
      };
      const blocks = iaFindSnapshots.format!(result);
      expect(blocks.some((b) => b.type === 'text')).toBe(true);
      const text = blocks.map((b) => (b as { type: string; text: string }).text).join('');
      expect(text).toContain('20200101120000');
      expect(text).toContain('https://web.archive.org/web/20200101120000/https://example.com');
    });

    it('renders resume_key line when present', () => {
      const result = {
        snapshots: [
          {
            timestamp: '20200101120000',
            replay_url: 'https://web.archive.org/web/20200101120000/https://example.com',
          },
        ],
        resume_key: 'token123',
      };
      const blocks = iaFindSnapshots.format!(result);
      const text = blocks.map((b) => (b as { type: string; text: string }).text).join('');
      expect(text).toContain('token123');
    });
  });
});
