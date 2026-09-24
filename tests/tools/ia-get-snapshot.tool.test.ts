/**
 * @fileoverview Tests for the ia_get_snapshot tool.
 * @module tests/tools/ia-get-snapshot.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iaGetSnapshot } from '@/mcp-server/tools/definitions/ia-get-snapshot.tool.js';

vi.mock('@/services/wayback/wayback-service.js', () => ({
  getWaybackService: vi.fn(),
}));

import { getWaybackService } from '@/services/wayback/wayback-service.js';

const mockService = {
  findClosest: vi.fn(),
  fetchContent: vi.fn(),
  buildReplayUrl: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (getWaybackService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

describe('iaGetSnapshot', () => {
  it('uses direct path (no Availability API) when exact 14-digit timestamp is given', async () => {
    // With a full 14-digit timestamp, the handler skips findClosest and calls buildReplayUrl
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200101120000/https://example.com',
    );
    mockService.fetchContent.mockResolvedValue({
      text: 'Hello world, this is the archived page text.',
      replayUrl: 'https://web.archive.org/web/20200101120000/https://example.com',
      status: '200',
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: '20200101120000',
    });
    const result = await iaGetSnapshot.handler(input, ctx);

    expect(mockService.findClosest).not.toHaveBeenCalled();
    expect(mockService.buildReplayUrl).toHaveBeenCalledWith(
      '20200101120000',
      'https://example.com',
    );
    expect(result.text).toBe('Hello world, this is the archived page text.');
    expect(result.replay_url).toBe(
      'https://web.archive.org/web/20200101120000/https://example.com',
    );
    expect(result.resolved_timestamp).toBe('20200101120000');
    expect(result.resolved_status).toBe('200');
  });

  it('uses Availability API for imprecise timestamps (fewer than 14 digits)', async () => {
    mockService.findClosest.mockResolvedValue({
      snapshotUrl: 'https://web.archive.org/web/20200101120000/https://example.com',
      timestamp: '20200101120000',
      status: '200',
    });
    mockService.fetchContent.mockResolvedValue({
      text: 'Hello world, this is the archived page text.',
      replayUrl: 'https://web.archive.org/web/20200101120000/https://example.com',
      status: '200',
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: '20200101', // 8 digits — imprecise, uses Availability API
    });
    const result = await iaGetSnapshot.handler(input, ctx);

    expect(mockService.findClosest).toHaveBeenCalledWith('https://example.com', '20200101', ctx);
    expect(mockService.buildReplayUrl).not.toHaveBeenCalled();
    expect(result.resolved_timestamp).toBe('20200101120000');
    expect(result.resolved_status).toBe('200');
  });

  it('resolves the trimmed timestamp on the closest-capture path', async () => {
    const replayUrl = 'https://web.archive.org/web/20200101120000/https://example.com';
    mockService.findClosest.mockResolvedValue({
      snapshotUrl: replayUrl,
      timestamp: '20200101120000',
      status: '200',
    });
    mockService.fetchContent.mockResolvedValue({ text: 'page', replayUrl, status: '200' });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: ' 20200101 ',
    });
    await iaGetSnapshot.handler(input, ctx);

    expect(mockService.findClosest).toHaveBeenCalledWith('https://example.com', '20200101', ctx);
  });

  it('throws no_snapshot_available when Availability API returns no closest capture', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.findClosest.mockRejectedValue(
      notFound('No snapshot available for https://unknown.example near 20200101.', {
        reason: 'no_snapshot_available',
      }),
    );

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://unknown.example',
      timestamp: '20200101',
    });

    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toThrow();
  });

  it('throws content_fetch_failed when archived page fetch fails (exact timestamp)', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    // With a 14-digit timestamp, the handler uses buildReplayUrl + fetchContent (no findClosest)
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200101120000/https://example.com',
    );
    mockService.fetchContent.mockRejectedValue(
      serviceUnavailable('Fetch failed.', { reason: 'content_fetch_failed' }),
    );

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: '20200101120000',
    });

    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'content_fetch_failed',
        recovery: { hint: expect.stringContaining('retry') },
      },
    });
  });

  it('maps Wayback 404 on exact-timestamp direct path to no_snapshot_available', async () => {
    // fetchContent receives a 404 from Wayback — should surface as no_snapshot_available
    // rather than the raw NotFound McpError with no recovery hint.
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200601000000/https://thisurldoesnotexist99999.com',
    );
    mockService.fetchContent.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.NotFound,
        'Fetch failed for https://web.archive.org/web/20200601000000/... Status: 404',
        { statusCode: 404, errorSource: 'FetchHttpError' },
      ),
    );

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://thisurldoesnotexist99999.com',
      timestamp: '20200601000000',
    });

    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_snapshot_available' },
    });
  });

  it('maps a 503 on exact-timestamp path to content_fetch_failed, not no_snapshot_available', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200601000000/https://example.com',
    );
    mockService.fetchContent.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Fetch failed for https://web.archive.org/web/20200601000000/... Status: 503',
        { statusCode: 503, errorSource: 'FetchHttpError' },
      ),
    );

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: '20200601000000',
    });

    // The upstream 503 keeps its ServiceUnavailable code but reaches the caller
    // as the declared contract entry, carrying its recovery hint.
    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'content_fetch_failed' },
    });
  });

  it('propagates an unmapped upstream error unchanged', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200601000000/https://example.com',
    );
    const timeoutError = new McpError(
      JsonRpcErrorCode.Timeout,
      'Request to https://web.archive.org/web/20200601000000/... timed out',
      { statusCode: 504, errorSource: 'FetchHttpError' },
    );
    mockService.fetchContent.mockRejectedValue(timeoutError);

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: '20200601000000',
    });

    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toThrow(timeoutError);
  });

  it('reports the served capture when Wayback redirected an exact timestamp', async () => {
    const served = 'https://web.archive.org/web/20200104000551/https://example.com/';
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200104000000/example.com',
    );
    mockService.fetchContent.mockResolvedValue({
      text: 'Example Domain',
      replayUrl: served,
      timestamp: '20200104000551',
      status: '200',
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'example.com', timestamp: '20200104000000' });
    const result = await iaGetSnapshot.handler(input, ctx);

    expect(result.replay_url).toBe(served);
    expect(result.resolved_timestamp).toBe('20200104000551');
    const text = (iaGetSnapshot.format!(result)[0] as { text: string }).text;
    expect(text).toContain(`**Replay URL:** ${served}`);
    expect(text).toContain('**Resolved Timestamp:** 20200104000551');
  });

  it('reports the served capture, status included, on the resolution path too', async () => {
    // The lookup resolved a 301 capture; Wayback followed it and served a different one.
    mockService.findClosest.mockResolvedValue({
      snapshotUrl: 'https://web.archive.org/web/20200101230622/http://nasa.gov/',
      timestamp: '20200101230622',
      status: '301',
    });
    mockService.fetchContent.mockResolvedValue({
      text: 'NASA',
      replayUrl: 'https://web.archive.org/web/20200101230626/https://www.nasa.gov/',
      timestamp: '20200101230626',
      status: '200',
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'nasa.gov', timestamp: '20200101' });
    const result = await iaGetSnapshot.handler(input, ctx);

    expect(result.replay_url).toBe(
      'https://web.archive.org/web/20200101230626/https://www.nasa.gov/',
    );
    expect(result.resolved_timestamp).toBe('20200101230626');
    expect(result.resolved_status).toBe('200');
    const text = (iaGetSnapshot.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Resolved Timestamp:** 20200101230626 | **Status:** 200');
  });

  it('reports the status Wayback served on the exact-timestamp path instead of assuming 200', async () => {
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200104000551/https://example.com/',
    );
    mockService.fetchContent.mockResolvedValue({
      text: 'Example Domain',
      replayUrl: 'https://web.archive.org/web/20200104000551/https://example.com/',
      timestamp: '20200104000551',
      status: '203',
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'example.com', timestamp: '20200104000551' });
    await expect(iaGetSnapshot.handler(input, ctx)).resolves.toMatchObject({
      resolved_status: '203',
    });
  });

  it('discloses a body cut at the byte ceiling in a notice', async () => {
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20240601000205/https://edition.cnn.com/',
    );
    mockService.fetchContent.mockResolvedValue({
      text: 'CNN',
      replayUrl: 'https://web.archive.org/web/20240601000205/https://edition.cnn.com/',
      timestamp: '20240601000205',
      status: '200',
      truncatedAtBytes: 4_194_304,
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'cnn.com', timestamp: '20240601000205' });
    await iaGetSnapshot.handler(input, ctx);

    expect(getEnrichment(ctx)).toMatchObject({
      notice: expect.stringContaining('first 4,194,304 bytes'),
    });
  });

  it('adds no notice for a body read in full', async () => {
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200104000551/https://example.com/',
    );
    mockService.fetchContent.mockResolvedValue({
      text: 'Example Domain',
      replayUrl: 'https://web.archive.org/web/20200104000551/https://example.com/',
      timestamp: '20200104000551',
      status: '200',
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'example.com', timestamp: '20200104000551' });
    await iaGetSnapshot.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('keeps the service’s own next step when the lookup was rate-limited', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    const limited = serviceUnavailable('Availability API returned HTTP 429.', {
      reason: 'availability_unavailable',
      status: 429,
      retryable: false,
      retryAfter: '120',
      recovery: {
        hint: 'The Availability API is rate-limiting requests; wait 120 seconds before retrying.',
      },
    });
    mockService.findClosest.mockRejectedValue(limited);

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'https://example.com', timestamp: '20200101' });

    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'content_fetch_failed',
        retryable: false,
        retryAfter: '120',
        recovery: { hint: expect.stringContaining('wait 120 seconds') },
      },
    });
  });

  it('keeps the message and history-mode hint of an incomplete CDX fallback', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    const message =
      'The Availability API found no capture of example.com near 20200101, and the CDX closest-capture check did not complete: CDX API returned HTTP 503.';
    const hint =
      'List nearby captures with ia_find_snapshots in history mode, passing from and to around the timestamp.';
    mockService.findClosest.mockRejectedValue(
      serviceUnavailable(message, { reason: 'cdx_unavailable', recovery: { hint } }),
    );

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'example.com', timestamp: '20200101' });

    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toMatchObject({
      message,
      data: { reason: 'content_fetch_failed', recovery: { hint } },
    });
  });

  it('maps a ServiceUnavailable from closest resolution to content_fetch_failed', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    const unavailable = serviceUnavailable('Wayback Availability API returned HTTP 503.', {
      reason: 'availability_unavailable',
    });
    mockService.findClosest.mockRejectedValue(unavailable);

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'https://example.com', timestamp: '20200101' });
    const err = await iaGetSnapshot.handler(input, ctx).catch((e: unknown) => e);

    expect(err).toMatchObject({
      data: {
        reason: 'content_fetch_failed',
        recovery: { hint: expect.stringContaining('retry') },
      },
    });
    expect((err as Error).cause).toBe(unavailable);
    expect(mockService.fetchContent).not.toHaveBeenCalled();
  });

  it('propagates a closest-resolution miss and a cancellation unchanged', async () => {
    const { notFound, requestCancelled } = await import('@cyanheads/mcp-ts-core/errors');
    const input = iaGetSnapshot.input.parse({ url: 'https://example.com', timestamp: '20200101' });

    const miss = notFound('No snapshot available for https://example.com near 20200101.', {
      reason: 'no_snapshot_available',
    });
    mockService.findClosest.mockRejectedValueOnce(miss);
    await expect(
      iaGetSnapshot.handler(input, createMockContext({ errors: iaGetSnapshot.errors })),
    ).rejects.toBe(miss);

    const cancelled = requestCancelled(
      'fetch GET https://archive.org/wayback/available was aborted.',
    );
    mockService.findClosest.mockRejectedValueOnce(cancelled);
    await expect(
      iaGetSnapshot.handler(input, createMockContext({ errors: iaGetSnapshot.errors })),
    ).rejects.toBe(cancelled);
  });

  describe('blank inputs', () => {
    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
    ])('rejects the %s url as invalid_arguments without any Wayback call', async (_label, url) => {
      const result = await runToolContract(iaGetSnapshot, { url, timestamp: '20200104000551' });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: unknown }).error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('url: Must not be blank');
      expect(mockService.buildReplayUrl).not.toHaveBeenCalled();
      expect(mockService.findClosest).not.toHaveBeenCalled();
      expect(mockService.fetchContent).not.toHaveBeenCalled();
    });

    it('trims surrounding whitespace from the url', async () => {
      const replayUrl = 'https://web.archive.org/web/20200104000551/https://example.com';
      mockService.buildReplayUrl.mockReturnValue(replayUrl);
      mockService.fetchContent.mockResolvedValue({ text: 'page', replayUrl, status: '200' });

      const result = await runToolContract(iaGetSnapshot, {
        url: ' https://example.com  ',
        timestamp: '20200104000551',
      });

      expect(result.isError).toBeFalsy();
      expect(mockService.buildReplayUrl).toHaveBeenCalledWith(
        '20200104000551',
        'https://example.com',
      );
    });

    it('still accepts an empty timestamp and resolves it through the closest lookup', async () => {
      const replayUrl = 'https://web.archive.org/web/20260101000000/https://example.com';
      mockService.findClosest.mockResolvedValue({
        snapshotUrl: replayUrl,
        timestamp: '20260101000000',
        status: '200',
      });
      mockService.fetchContent.mockResolvedValue({ text: 'latest', replayUrl, status: '200' });

      const result = await runToolContract(iaGetSnapshot, {
        url: 'https://example.com',
        timestamp: '',
      });

      expect(result.isError).toBeFalsy();
      expect(mockService.findClosest).toHaveBeenCalledWith(
        'https://example.com',
        '',
        expect.anything(),
      );
    });
  });

  describe('format', () => {
    it('renders replay URL, resolved timestamp, status, and text', () => {
      const output = {
        text: 'Archived page body text.',
        replay_url: 'https://web.archive.org/web/20200101120000/https://example.com',
        resolved_timestamp: '20200101120000',
        resolved_status: '200',
      };
      const blocks = iaGetSnapshot.format!(output);
      expect(blocks.some((b) => b.type === 'text')).toBe(true);
      const text = blocks.map((b) => (b as { type: string; text: string }).text).join('');
      expect(text).toContain(output.replay_url);
      expect(text).toContain(output.resolved_timestamp);
      expect(text).toContain(output.resolved_status);
      expect(text).toContain(output.text);
    });
  });
});
