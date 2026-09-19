/**
 * @fileoverview Tests for the ia_get_snapshot tool.
 * @module tests/tools/ia-get-snapshot.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
