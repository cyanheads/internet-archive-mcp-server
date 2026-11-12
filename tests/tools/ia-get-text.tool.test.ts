/**
 * @fileoverview Tests for the ia_get_text tool.
 * @module tests/tools/ia-get-text.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

/** The assembled `content[]` text of a tool result. */
const contentText = (result: Awaited<ReturnType<typeof runToolContract>>): string =>
  result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

describe('iaGetText', () => {
  it('returns the text slice and has_more=false for a short document', async () => {
    mockService.getTextContent.mockResolvedValue({
      text: 'Chapter 1. It is a truth universally acknowledged...',
      hasMore: false,
      charOffset: 0,
      maxChars: 50_000,
      sourceFile: 'pg1342_djvu.txt',
    });

    const ctx = createMockContext({ errors: iaGetText.errors });
    const input = iaGetText.input.parse({ identifier: 'pg1342' });
    const result = await iaGetText.handler(input, ctx);

    expect(result.text).toBe('Chapter 1. It is a truth universally acknowledged...');
    expect(result.char_offset).toBe(0);
    expect(result.max_chars).toBe(50_000);
    expect(result.has_more).toBe(false);
    expect(result.source_file).toBe('pg1342_djvu.txt');
  });

  it('passes the service has_more through when more text follows', async () => {
    mockService.getTextContent.mockResolvedValue({
      text: 'A'.repeat(50_000),
      hasMore: true,
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
      hasMore: true,
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
      {},
    );
    expect(result.has_more).toBe(true);
  });

  describe('max_chars ceiling', () => {
    const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.structuredContent as { notice?: string }).notice;

    it('serves a max_chars above IA_MAX_SNAPSHOT_CHARS at the maximum, with a notice on both surfaces', async () => {
      mockService.getTextContent.mockResolvedValue({
        text: 'A'.repeat(50_000),
        hasMore: true,
        charOffset: 0,
        maxChars: 50_000,
        sourceFile: 'volume_djvu.txt',
      });

      const result = await runToolContract(iaGetText, {
        identifier: 'big-volume',
        max_chars: 100_000_000,
      });

      expect(mockService.getTextContent).toHaveBeenCalledWith(
        'big-volume',
        50_000,
        0,
        expect.anything(),
        {},
      );
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { max_chars: number; text: string };
      expect(structured.max_chars).toBe(50_000);
      expect(structured.text).toHaveLength(50_000);
      const notice = noticeOf(result) ?? '';
      expect(notice).toContain('max_chars 100,000,000');
      expect(notice).toContain('50,000');
      expect(notice).toContain('char_offset 50,000');
      expect(contentText(result)).toContain(notice);
      expect(contentText(result)).toContain('next offset: 50,000');
    });

    it.each([
      ['equal to', 50_000],
      ['below', 500],
    ])(
      'serves a max_chars %s the maximum as requested, without a notice',
      async (_label, maxChars) => {
        mockService.getTextContent.mockResolvedValue({
          text: 'short',
          hasMore: false,
          charOffset: 0,
          maxChars,
          sourceFile: 'doc.txt',
        });

        const result = await runToolContract(iaGetText, { identifier: 'doc', max_chars: maxChars });

        expect(mockService.getTextContent).toHaveBeenCalledWith(
          'doc',
          maxChars,
          0,
          expect.anything(),
          {},
        );
        expect((result.structuredContent as { max_chars: number }).max_chars).toBe(maxChars);
        expect(noticeOf(result)).toBeUndefined();
      },
    );

    it('names no next offset when the clamped page reaches the end of the document', async () => {
      mockService.getTextContent.mockResolvedValue({
        text: 'C'.repeat(509),
        hasMore: false,
        charOffset: 40_000,
        maxChars: 50_000,
        sourceFile: 'volume_djvu.txt',
      });

      const result = await runToolContract(iaGetText, {
        identifier: 'volume',
        max_chars: 60_000,
        char_offset: 40_000,
      });

      const notice = noticeOf(result) ?? '';
      expect(notice).toContain('max_chars 60,000');
      expect(notice).toContain('end of the document');
      expect(notice).not.toContain('Continue from');
    });

    it('keeps the requested char_offset when the clamp applies', async () => {
      mockService.getTextContent.mockResolvedValue({
        text: 'B'.repeat(50_000),
        hasMore: true,
        charOffset: 250_000,
        maxChars: 50_000,
        sourceFile: 'volume_djvu.txt',
      });

      const result = await runToolContract(iaGetText, {
        identifier: 'big-volume',
        max_chars: 75_000,
        char_offset: 250_000,
      });

      expect(mockService.getTextContent).toHaveBeenCalledWith(
        'big-volume',
        50_000,
        250_000,
        expect.anything(),
        {},
      );
      expect(noticeOf(result)).toContain('char_offset 300,000');
    });
  });

  describe('output fields', () => {
    it('forwards an opaque continuation and reports its resumed offset and next token on both surfaces', async () => {
      mockService.getTextContent.mockResolvedValue({
        text: 'page',
        hasMore: true,
        charOffset: 120,
        maxChars: 50_000,
        sourceFile: 'book.txt',
        nextContinuation: 'next-token',
      });
      const result = await runToolContract(iaGetText, {
        identifier: 'book',
        continuation: ' previous-token ',
        max_chars: 100_000,
      });
      expect(mockService.getTextContent).toHaveBeenCalledWith(
        'book',
        50_000,
        0,
        expect.anything(),
        { continuation: 'previous-token' },
      );
      expect(result.structuredContent).toMatchObject({
        char_offset: 120,
        next_continuation: 'next-token',
        notice: expect.stringContaining('char_offset 50,120'),
      });
      expect(contentText(result)).toContain('next-token');
      expect(contentText(result)).toContain('50,120');
    });

    it('reports source_file_bytes from the manifest size on both surfaces, and no total_chars', async () => {
      mockService.getTextContent.mockResolvedValue({
        text: 'Volume text.',
        hasMore: true,
        charOffset: 0,
        maxChars: 50_000,
        sourceFile: 'volume_djvu.txt',
        sourceFileBytes: 9_915_421,
      });

      const result = await runToolContract(iaGetText, { identifier: 'volume' });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.source_file_bytes).toBe(9_915_421);
      expect(structured).not.toHaveProperty('total_chars');
      expect(contentText(result)).toContain('9,915,421 bytes');
      expect(() => iaGetText.output.parse(structured)).not.toThrow();
    });

    it('omits source_file_bytes when the manifest lists no size', async () => {
      mockService.getTextContent.mockResolvedValue({
        text: 'Volume text.',
        hasMore: false,
        charOffset: 0,
        maxChars: 50_000,
        sourceFile: 'volume.txt',
      });

      const result = await runToolContract(iaGetText, { identifier: 'volume' });

      expect(result.structuredContent).not.toHaveProperty('source_file_bytes');
      expect(contentText(result)).not.toContain('bytes');
    });

    it('serves empty text with has_more=false for an offset past the end', async () => {
      mockService.getTextContent.mockResolvedValue({
        text: '',
        hasMore: false,
        charOffset: 9_999_999,
        maxChars: 50_000,
        sourceFile: 'volume_djvu.txt',
        sourceFileBytes: 9_915_421,
      });

      const result = await runToolContract(iaGetText, {
        identifier: 'volume',
        char_offset: 9_999_999,
      });

      const structured = result.structuredContent as { text: string; has_more: boolean };
      expect(structured.text).toBe('');
      expect(structured.has_more).toBe(false);
      expect(contentText(result)).toContain('end of document');
    });
  });

  describe('text file selection', () => {
    const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.structuredContent as { notice?: string }).notice;
    const page = (extra: Record<string, unknown> = {}) => ({
      text: 'Book I.',
      hasMore: true,
      charOffset: 0,
      maxChars: 50_000,
      sourceFile: 'Strabo 01 Geography 1-2_djvu.txt',
      ...extra,
    });

    it('forwards file to the service exactly as given', async () => {
      mockService.getTextContent.mockResolvedValue(page());

      await runToolContract(iaGetText, {
        identifier: 'Strabo08Geography17AndIndex',
        file: 'Strabo 02 Geography 3-5_djvu.txt',
      });

      expect(mockService.getTextContent).toHaveBeenCalledWith(
        'Strabo08Geography17AndIndex',
        50_000,
        0,
        expect.anything(),
        { file: 'Strabo 02 Geography 3-5_djvu.txt' },
      );
    });

    it.each([
      ['empty', ''],
      ['whitespace-only', '  '],
    ])('treats an %s file as omitted', async (_label, file) => {
      mockService.getTextContent.mockResolvedValue(page());

      await runToolContract(iaGetText, { identifier: 'strabo', file });

      expect(mockService.getTextContent.mock.calls[0]?.[4]).toEqual({});
    });

    it('names the readable file count and the format that lists them on both surfaces', async () => {
      mockService.getTextContent.mockResolvedValue(
        page({ textFiles: { count: 8, formats: ['DjVuTXT'], unformatted: 0 } }),
      );

      const result = await runToolContract(iaGetText, {
        identifier: 'Strabo08Geography17AndIndex',
      });

      expect(noticeOf(result)).toBe(
        'This item has 8 readable text files; this page is from the default one, source_file. ia_get_item with format "DjVuTXT" lists them. Pass another one\'s name as file to read it.',
      );
      expect(contentText(result)).toContain(noticeOf(result));
      expect(() => iaGetText.output.parse(result.structuredContent)).not.toThrow();
    });

    it.each([
      [
        'two formats',
        { count: 3, formats: ['DjVuTXT', 'Text'], unformatted: 0 },
        'ia_get_item with format "DjVuTXT" or "Text" lists them.',
      ],
      [
        'three formats',
        { count: 3, formats: ['DjVuTXT', 'Text', 'Closed Caption Text'], unformatted: 0 },
        'format "DjVuTXT", "Text", or "Closed Caption Text" lists them.',
      ],
      [
        'files with no format besides formatted ones',
        { count: 3, formats: ['DjVuTXT'], unformatted: 2 },
        'format "DjVuTXT" lists them, except 2 with no format, listed only in the unfiltered manifest.',
      ],
      [
        'only files with no format',
        { count: 2, formats: [], unformatted: 2 },
        'The unfiltered ia_get_item manifest lists them.',
      ],
    ])('says how to list the files for %s', async (_label, textFiles, expected) => {
      mockService.getTextContent.mockResolvedValue(page({ textFiles }));

      const result = await runToolContract(iaGetText, { identifier: 'item' });

      expect(noticeOf(result)).toContain(`This item has ${textFiles.count} readable text files`);
      expect(noticeOf(result)).toContain(expected);
    });

    it('keeps an upstream format raw in structuredContent and escapes it in content[]', async () => {
      mockService.getTextContent.mockResolvedValue(
        page({ textFiles: { count: 2, formats: ['*Text*'], unformatted: 0 } }),
      );

      const result = await runToolContract(iaGetText, { identifier: 'item' });

      expect(noticeOf(result)).toContain('format "*Text*" lists them');
      expect(contentText(result)).toContain('format "\\*Text\\*" lists them');
      expect(contentText(result)).not.toContain('"*Text*"');
    });

    it('sends the clamp and file-count notices together', async () => {
      mockService.getTextContent.mockResolvedValue(
        page({ textFiles: { count: 8, formats: ['DjVuTXT'], unformatted: 0 } }),
      );

      const result = await runToolContract(iaGetText, { identifier: 'item', max_chars: 60_000 });

      const notice = noticeOf(result) ?? '';
      expect(notice).toMatch(/^max_chars 60,000 is above .* Continue from char_offset 50,000\. /);
      expect(notice).toContain('This item has 8 readable text files');
      expect(contentText(result)).toContain(notice);
    });

    it('adds no file-count notice when the service reports no textFiles', async () => {
      mockService.getTextContent.mockResolvedValue(page());

      const result = await runToolContract(iaGetText, { identifier: 'prideprejudice00aust' });

      expect(noticeOf(result)).toBeUndefined();
    });

    const STRABO_URL =
      'https://archive.org/download/Strabo08Geography17AndIndex/Strabo%2002%20Geography%203-5_djvu.txt';

    it('reads the identifier and file a download URL names', async () => {
      mockService.getTextContent.mockResolvedValue(page());

      await runToolContract(iaGetText, { identifier: STRABO_URL });

      expect(mockService.getTextContent).toHaveBeenCalledWith(
        'Strabo08Geography17AndIndex',
        50_000,
        0,
        expect.anything(),
        { file: 'Strabo 02 Geography 3-5_djvu.txt' },
      );
    });

    it('lets an explicit file win over the file a download URL names', async () => {
      mockService.getTextContent.mockResolvedValue(page());

      await runToolContract(iaGetText, {
        identifier: STRABO_URL,
        file: 'Strabo 03 Geography_djvu.txt',
      });

      expect(mockService.getTextContent.mock.calls[0]?.[4]).toEqual({
        file: 'Strabo 03 Geography_djvu.txt',
      });
    });

    it('reads a details URL as its identifier with the default file', async () => {
      mockService.getTextContent.mockResolvedValue(page());

      await runToolContract(iaGetText, {
        identifier: 'archive.org/details/prideprejudice00aust/page/n5/mode/2up',
      });

      expect(mockService.getTextContent.mock.calls[0]?.[0]).toBe('prideprejudice00aust');
      expect(mockService.getTextContent.mock.calls[0]?.[4]).toEqual({});
    });

    it.each([
      ['a URL on another host', 'https://example.com/foo', 'invalid_identifier'],
      [
        'a Wayback Machine URL',
        'https://web.archive.org/web/2020/https://example.com/',
        'ia_get_snapshot',
      ],
    ])('rejects %s as invalid_identifier with no lookup', async (_label, identifier, hintTerm) => {
      const result = await runToolContract(iaGetText, { identifier });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_identifier', recovery: { hint: expect.any(String) } },
        },
      });
      expect(contentText(result)).toContain(hintTerm);
      expect(mockService.getTextContent).not.toHaveBeenCalled();
    });

    it('declares invalid_file as InvalidParams with a recovery naming the readable formats and download_url', () => {
      const entry = iaGetText.errors?.find((e) => e.reason === 'invalid_file');
      expect(entry?.code).toBe(JsonRpcErrorCode.InvalidParams);
      for (const term of ['DjVuTXT', 'Text', 'Plain Text', 'Metadata', 'download_url']) {
        expect(entry?.recovery).toContain(term);
      }
    });
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

  describe('blank identifier', () => {
    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
    ])(
      'rejects the %s identifier as invalid_arguments without a lookup',
      async (_label, identifier) => {
        const result = await runToolContract(iaGetText, { identifier });

        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: unknown }).error).toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments' },
        });
        const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
        expect(text).toContain('identifier: Must not be blank');
        expect(text).not.toContain('no_text_file');
        expect(mockService.getTextContent).not.toHaveBeenCalled();
      },
    );

    it('trims surrounding whitespace from the identifier before the lookup', async () => {
      mockService.getTextContent.mockResolvedValue({
        text: 'Chapter 1.',
        hasMore: false,
        charOffset: 0,
        maxChars: 50_000,
        sourceFile: 'pg1342_djvu.txt',
      });

      const result = await runToolContract(iaGetText, { identifier: '  pg1342 ' });

      expect(result.isError).toBeFalsy();
      expect(mockService.getTextContent).toHaveBeenCalledWith(
        'pg1342',
        50_000,
        0,
        expect.anything(),
        {},
      );
    });
  });

  describe('format', () => {
    it('renders source file, offset info, file size, and text content', () => {
      const output = {
        text: 'The full text goes here.',
        source_file_bytes: 1_048_576,
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
      expect(text).toContain('more follows (next offset: 500)');
      expect(text).toContain('1,048,576 bytes');
    });

    it('renders end-of-document note when has_more is false', () => {
      const output = {
        text: 'End of book.',
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
