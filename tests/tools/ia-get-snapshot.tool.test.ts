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
};

beforeEach(() => {
  vi.clearAllMocks();
  (getWaybackService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

describe('iaGetSnapshot', () => {
  it('returns text, replay_url, and resolved metadata on success', async () => {
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
      timestamp: '20200101120000',
    });
    const result = await iaGetSnapshot.handler(input, ctx);

    expect(result.text).toBe('Hello world, this is the archived page text.');
    expect(result.replay_url).toBe(
      'https://web.archive.org/web/20200101120000/https://example.com',
    );
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

  it('throws content_fetch_failed when archived page fetch fails', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.findClosest.mockResolvedValue({
      snapshotUrl: 'https://web.archive.org/web/20200101120000/https://example.com',
      timestamp: '20200101120000',
      status: '200',
    });
    mockService.fetchContent.mockRejectedValue(
      serviceUnavailable('Fetch failed.', { reason: 'content_fetch_failed' }),
    );

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: '20200101120000',
    });

    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toThrow();
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
