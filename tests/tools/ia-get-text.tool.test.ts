/**
 * @fileoverview Tests for the ia_get_text tool.
 * @module tests/tools/ia-get-text.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iaGetText } from '@/mcp-server/tools/definitions/ia-get-text.tool.js';

vi.mock('@/services/archive-metadata/archive-metadata-service.js', () => ({
  getArchiveMetadataService: vi.fn(),
}));

// Server config: expose a deterministic maxSnapshotChars so tests aren't environment-dependent.
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    requestTimeoutMs: 30_000,
    maxSnapshotChars: 50_000,
    userAgent: undefined,
  }),
  getUserAgent: vi.fn().mockReturnValue('test-agent/0.0.0'),
}));

import { getArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

const mockService = {
  getTextContent: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (getArchiveMetadataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

describe('iaGetText', () => {
  it('returns text slice, total_chars, has_more=false for a short document', async () => {
    mockService.getTextContent.mockResolvedValue({
      text: 'Chapter 1. It is a truth universally acknowledged...',
      totalChars: 52,
      charOffset: 0,
      maxChars: 50_000,
      sourceFile: 'pg1342_djvu.txt',
    });

    const ctx = createMockContext({ errors: iaGetText.errors });
    const input = iaGetText.input.parse({ identifier: 'pg1342' });
    const result = await iaGetText.handler(input, ctx);

    expect(result.text).toBe('Chapter 1. It is a truth universally acknowledged...');
    expect(result.total_chars).toBe(52);
    expect(result.char_offset).toBe(0);
    expect(result.max_chars).toBe(50_000);
    expect(result.has_more).toBe(false);
    expect(result.source_file).toBe('pg1342_djvu.txt');
  });

  it('sets has_more=true when offset + max_chars < total_chars', async () => {
    mockService.getTextContent.mockResolvedValue({
      text: 'A'.repeat(50_000),
      totalChars: 200_000,
      charOffset: 0,
      maxChars: 50_000,
      sourceFile: 'book.txt',
    });

    const ctx = createMockContext({ errors: iaGetText.errors });
    const input = iaGetText.input.parse({ identifier: 'long-book' });
    const result = await iaGetText.handler(input, ctx);

    expect(result.has_more).toBe(true);
  });

  it('forwards custom max_chars and char_offset to the service, sets has_more correctly', async () => {
    mockService.getTextContent.mockResolvedValue({
      text: 'page2text',
      totalChars: 5000,
      charOffset: 1000,
      maxChars: 500,
      sourceFile: 'doc.txt',
    });

    const ctx = createMockContext({ errors: iaGetText.errors });
    const input = iaGetText.input.parse({
      identifier: 'paged-doc',
      max_chars: 500,
      char_offset: 1000,
    });
    const result = await iaGetText.handler(input, ctx);

    expect(mockService.getTextContent).toHaveBeenCalledWith(
      'paged-doc',
      500,
      1000,
      expect.anything(),
    );
    // 1000 + 500 = 1500 < 5000 → has_more should be true
    expect(result.has_more).toBe(true);
  });

  it('throws item_not_found when identifier does not exist (empty {} from API)', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.getTextContent.mockRejectedValue(
      notFound('Item "nonexistent" not found in the Internet Archive.', {
        reason: 'item_not_found',
        identifier: 'nonexistent',
      }),
    );

    const ctx = createMockContext({ errors: iaGetText.errors });
    const input = iaGetText.input.parse({ identifier: 'nonexistent' });

    await expect(iaGetText.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'item_not_found' },
    });
  });

  it('throws no_text_file when item has no DjVuTXT or plain-text file', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.getTextContent.mockRejectedValue(
      notFound('No readable text file found for item "video-only".', {
        reason: 'no_text_file',
        identifier: 'video-only',
      }),
    );

    const ctx = createMockContext({ errors: iaGetText.errors });
    const input = iaGetText.input.parse({ identifier: 'video-only' });

    await expect(iaGetText.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_text_file' },
    });
  });

  it('throws download_forbidden when text file returns HTTP 403', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.getTextContent.mockRejectedValue(
      new McpError(JsonRpcErrorCode.Forbidden, 'Access denied.', {
        reason: 'download_forbidden',
      }),
    );

    const ctx = createMockContext({ errors: iaGetText.errors });
    const input = iaGetText.input.parse({ identifier: 'restricted-item' });

    await expect(iaGetText.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'download_forbidden' },
    });
  });

  describe('format', () => {
    it('renders source file, offset info, and text content', () => {
      const output = {
        text: 'The full text goes here.',
        total_chars: 1000,
        char_offset: 0,
        max_chars: 500,
        has_more: true,
        source_file: 'book_djvu.txt',
      };
      const blocks = iaGetText.format!(output);
      expect(blocks.some((b) => b.type === 'text')).toBe(true);
      const text = blocks.map((b) => (b as { type: string; text: string }).text).join('');
      expect(text).toContain('book_djvu.txt');
      expect(text).toContain('The full text goes here.');
      // Should show "more follows" since has_more is true
      expect(text).toContain('500');
    });

    it('renders end-of-document note when has_more is false', () => {
      const output = {
        text: 'End of book.',
        total_chars: 100,
        char_offset: 0,
        max_chars: 500,
        has_more: false,
        source_file: 'short.txt',
      };
      const blocks = iaGetText.format!(output);
      const text = blocks.map((b) => (b as { type: string; text: string }).text).join('');
      expect(text).toContain('end of document');
    });
  });
});
