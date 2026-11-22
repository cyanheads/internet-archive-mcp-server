/**
 * @fileoverview Tests for the ia_get_text tool.
 * @module tests/tools/ia-get-text.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iaGetText } from '@/mcp-server/tools/definitions/ia-get-text.tool.js';
import type { CallDeadline } from '@/services/call-deadline.js';

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

/** The call deadline the handler starts and passes on: 55 s at the 30 s request timeout. */
const CALL_DEADLINE = expect.objectContaining({ budgetSeconds: 55, requestTimeoutMs: 30_000 });

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
      CALL_DEADLINE,
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
        CALL_DEADLINE,
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
          CALL_DEADLINE,
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
        CALL_DEADLINE,
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
        CALL_DEADLINE,
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
        CALL_DEADLINE,
        { file: 'Strabo 02 Geography 3-5_djvu.txt' },
      );
    });

    it.each([
      ['empty', ''],
      ['whitespace-only', '  '],
    ])('treats an %s file as omitted', async (_label, file) => {
      mockService.getTextContent.mockResolvedValue(page());

      await runToolContract(iaGetText, { identifier: 'strabo', file });

      expect(mockService.getTextContent.mock.calls[0]?.[5]).toEqual({});
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
        CALL_DEADLINE,
        { file: 'Strabo 02 Geography 3-5_djvu.txt' },
      );
    });

    it('lets an explicit file win over the file a download URL names', async () => {
      mockService.getTextContent.mockResolvedValue(page());

      await runToolContract(iaGetText, {
        identifier: STRABO_URL,
        file: 'Strabo 03 Geography_djvu.txt',
      });

      expect(mockService.getTextContent.mock.calls[0]?.[5]).toEqual({
        file: 'Strabo 03 Geography_djvu.txt',
      });
    });

    it('reads a details URL as its identifier with the default file', async () => {
      mockService.getTextContent.mockResolvedValue(page());

      await runToolContract(iaGetText, {
        identifier: 'archive.org/details/prideprejudice00aust/page/n5/mode/2up',
      });

      expect(mockService.getTextContent.mock.calls[0]?.[0]).toBe('prideprejudice00aust');
      expect(mockService.getTextContent.mock.calls[0]?.[5]).toEqual({});
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

  describe('find (#70)', () => {
    const FILE = 'prideprejudice00aust_djvu.txt';
    const TOKEN = '3f2a1b9c-0d4e-4f5a-8b6c-7d8e9f0a1b2c';
    const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.structuredContent as { notice?: string }).notice;
    const errorOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (
        result.structuredContent as {
          error: { code: number; message: string; data: Record<string, unknown> };
        }
      ).error;
    /** The service's answer to a search whose first match begins at 29,475. */
    const hit = (extra: Record<string, unknown> = {}) => ({
      text: 'Pemberley  as  with  it,',
      hasMore: true,
      charOffset: 29_475,
      matchOffset: 29_475,
      maxChars: 50_000,
      sourceFile: FILE,
      sourceFileBytes: 874_482,
      nextContinuation: TOKEN,
      ...extra,
    });
    /** The service's answer to a search from 29,476 that found nothing. */
    const miss = (extra: Record<string, unknown> = {}) => ({
      text: '',
      hasMore: false,
      charOffset: 29_476,
      maxChars: 50_000,
      sourceFile: FILE,
      sourceFileBytes: 874_482,
      ...extra,
    });
    const missNotice = (file: string, offset: string) =>
      `No match for find in "${file}" from char_offset ${offset} to its end. OCR misreads and words hyphenated across line ends break a phrase; a shorter or different phrase may still match.`;

    it('forwards find trimmed and reports a hit as match_offset and char_offset on both surfaces', async () => {
      mockService.getTextContent.mockResolvedValue(hit());

      const result = await runToolContract(iaGetText, {
        identifier: 'prideprejudice00aust',
        find: ' \tPEMBERLEY\n',
      });

      expect(mockService.getTextContent).toHaveBeenCalledWith(
        'prideprejudice00aust',
        50_000,
        0,
        expect.anything(),
        CALL_DEADLINE,
        { find: 'PEMBERLEY' },
      );
      expect(result.structuredContent).toEqual({
        text: 'Pemberley  as  with  it,',
        char_offset: 29_475,
        match_offset: 29_475,
        max_chars: 50_000,
        has_more: true,
        source_file: FILE,
        source_file_bytes: 874_482,
        next_continuation: TOKEN,
      });
      expect(contentText(result).split('\n')).toContain(
        '**Max Chars:** 50,000 | **Offset:** 29,475 — more follows (next offset: 79,475) | **Match Offset:** 29,475',
      );
      expect(() => iaGetText.output.parse(result.structuredContent)).not.toThrow();
    });

    it('keeps a hit on the last characters of the file a hit, with no miss notice', async () => {
      mockService.getTextContent.mockResolvedValue(
        hit({ text: 'END.', hasMore: false, charOffset: 873_514, matchOffset: 873_514 }),
      );

      const result = await runToolContract(iaGetText, { identifier: 'pp', find: 'end.' });

      expect(result.structuredContent).toMatchObject({
        text: 'END.',
        match_offset: 873_514,
        has_more: false,
      });
      expect(noticeOf(result)).toBeUndefined();
      expect(contentText(result).split('\n')).toContain(
        '**Max Chars:** 50,000 | **Offset:** 873,514 — end of document | **Match Offset:** 873,514',
      );
    });

    it('accepts find with continuation, and keeps continuation with char_offset ambiguous_pagination', async () => {
      mockService.getTextContent.mockResolvedValue(hit());

      const resumed = await runToolContract(iaGetText, {
        identifier: 'pp',
        continuation: TOKEN,
        find: 'Pemberley',
      });
      const ambiguous = await runToolContract(iaGetText, {
        identifier: 'pp',
        continuation: TOKEN,
        char_offset: 29_475,
        find: 'Pemberley',
      });

      expect(resumed.isError).toBeFalsy();
      expect(mockService.getTextContent).toHaveBeenCalledTimes(1);
      expect(mockService.getTextContent.mock.calls[0]?.[5]).toEqual({
        continuation: TOKEN,
        find: 'Pemberley',
      });
      expect(errorOf(ambiguous)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'ambiguous_pagination' },
      });
    });

    it('advertises find as optional with a 500-character maximum and rejects a longer one before any request', async () => {
      const schema = z.toJSONSchema(iaGetText.input, { io: 'input' }) as {
        properties: Record<string, { type?: string; maxLength?: number }>;
        required: string[];
      };
      expect(schema.properties.find).toMatchObject({ type: 'string', maxLength: 500 });
      expect(schema.required).toEqual(['identifier']);

      for (const find of ['a'.repeat(501), `${'a'.repeat(499)}  `]) {
        const result = await runToolContract(iaGetText, { identifier: 'pp', find });
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments' },
        });
        expect(contentText(result)).toContain('find');
      }
      expect(mockService.getTextContent).not.toHaveBeenCalled();

      mockService.getTextContent.mockResolvedValue(hit());
      await runToolContract(iaGetText, { identifier: 'pp', find: 'a'.repeat(500) });
      expect(mockService.getTextContent.mock.calls[0]?.[5]).toEqual({ find: 'a'.repeat(500) });
    });

    it.each([
      ['empty', ''],
      ['spaces', '   '],
      ['a line break and a tab', '\n\t'],
      ['U+0085, White_Space that String#trim keeps', '\u0085'],
      ['U+3000 then U+0085', String.fromCodePoint(0x3000, 0x85)],
      ['U+FEFF, which String#trim strips', String.fromCodePoint(0xfeff)],
    ])('answers a find of only %s exactly as the call without find', async (_label, find) => {
      mockService.getTextContent.mockResolvedValue({
        text: 'Chapter 1.',
        hasMore: true,
        charOffset: 0,
        maxChars: 50_000,
        sourceFile: FILE,
        textFiles: { count: 2, formats: ['DjVuTXT'], unformatted: 0 },
      });

      const without = await runToolContract(iaGetText, { identifier: 'pp' });
      const blank = await runToolContract(iaGetText, { identifier: 'pp', find });

      const [plain, withBlank] = mockService.getTextContent.mock.calls;
      expect(withBlank?.[5]).toEqual(plain?.[5]);
      expect(withBlank?.[5]).toEqual({});
      expect(blank.structuredContent).toEqual(without.structuredContent);
      expect(blank.content).toEqual(without.content);
      expect(noticeOf(blank)).not.toContain('No match');
    });

    it('answers a miss with empty text, has_more false, no match_offset or next_continuation, and a notice on both surfaces', async () => {
      mockService.getTextContent.mockResolvedValue(miss());

      const result = await runToolContract(iaGetText, {
        identifier: 'pp',
        char_offset: 29_476,
        find: 'zzqqxxjj',
      });

      expect(mockService.getTextContent.mock.calls[0]?.[2]).toBe(29_476);
      expect(result.structuredContent).toEqual({
        text: '',
        char_offset: 29_476,
        max_chars: 50_000,
        has_more: false,
        source_file: FILE,
        source_file_bytes: 874_482,
        notice: missNotice(FILE, '29,476'),
      });
      const text = contentText(result);
      expect(text).toContain(missNotice(FILE, '29,476'));
      expect(text.split('\n')).toContain(
        '**Max Chars:** 50,000 | **Offset:** 29,476 — end of document',
      );
      expect(text).not.toContain('Match Offset');
      expect(() => iaGetText.output.parse(result.structuredContent)).not.toThrow();
    });

    it('keeps the readable-file-count notice beside the miss notice on a default-pick read', async () => {
      const volume = 'Strabo 01 Geography 1-2_djvu.txt';
      mockService.getTextContent.mockResolvedValue(
        miss({
          charOffset: 0,
          sourceFile: volume,
          textFiles: { count: 8, formats: ['DjVuTXT'], unformatted: 0 },
        }),
      );

      const result = await runToolContract(iaGetText, {
        identifier: 'Strabo08Geography17AndIndex',
        find: 'Pemberley',
      });

      const expected = `${missNotice(volume, '0')} This item has 8 readable text files; this page is from the default one, source_file. ia_get_item with format "DjVuTXT" lists them. Pass another one's name as file to read it.`;
      expect(noticeOf(result)).toBe(expected);
      expect(contentText(result)).toContain(expected);
    });

    it("carries the service's find_incomplete as Timeout with its char_offset, continuation, and hint on both surfaces", async () => {
      const { timeout } = await import('@cyanheads/mcp-ts-core/errors');
      const message = `The search of "${FILE}" stopped before the download's request timeout or the call deadline could cut it off. No match begins from char_offset 0 up to char_offset 412000, where the search resumes.`;
      const resume = `Call again with the same find and continuation ${TOKEN}.`;
      mockService.getTextContent.mockRejectedValue(
        timeout(message, {
          reason: 'find_incomplete',
          char_offset: 412_000,
          next_continuation: TOKEN,
          recovery: { hint: resume },
        }),
      );

      const result = await runToolContract(iaGetText, { identifier: 'pp', find: 'Pemberley' });

      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message,
        data: {
          reason: 'find_incomplete',
          char_offset: 412_000,
          next_continuation: TOKEN,
          recovery: { hint: resume },
        },
      });
      expect(errorOf(result).data).not.toHaveProperty('retryable');
      const text = contentText(result);
      expect(text).toContain(`Recovery: ${resume}`);
      expect(text).toContain('(reason find_incomplete');
    });

    it('declares find_incomplete as Timeout, whose recovery reaches a failure the service sends without a hint', async () => {
      const entry = iaGetText.errors?.find((e) => e.reason === 'find_incomplete');
      expect(entry?.code).toBe(JsonRpcErrorCode.Timeout);
      const { timeout } = await import('@cyanheads/mcp-ts-core/errors');
      mockService.getTextContent.mockRejectedValue(
        timeout('The search stopped.', { reason: 'find_incomplete', char_offset: 0 }),
      );

      const result = await runToolContract(iaGetText, { identifier: 'pp', find: 'Pemberley' });

      expect(errorOf(result).data).toMatchObject({
        reason: 'find_incomplete',
        recovery: { hint: entry?.recovery },
      });
      expect(contentText(result)).toContain(`Recovery: ${entry?.recovery}`);
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

  describe('the call deadline (#55)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("binds the deadline to the caller's signal, so a caller who left past 55 s gets the cancellation", async () => {
      const caller = new AbortController();
      const cancelled = requestCancelled(
        'fetch GET https://archive.org/download/pg1342/pg1342_djvu.txt was aborted.',
      );
      /**
       * The call outlives its deadline and the caller leaves; the service checks the deadline
       * before its next request, which then fails as the cancellation it is.
       */
      mockService.getTextContent.mockImplementation(
        (
          _identifier: string,
          _maxChars: number,
          _charOffset: number,
          _ctx: unknown,
          deadline: CallDeadline,
        ) => {
          vi.advanceTimersByTime(56_000);
          caller.abort();
          deadline.assertTimeLeft();
          return Promise.reject(cancelled);
        },
      );
      const ctx = createMockContext({ errors: iaGetText.errors, signal: caller.signal });

      await expect(
        iaGetText.handler(iaGetText.input.parse({ identifier: 'pg1342' }), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
        message: cancelled.message,
      });
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
        CALL_DEADLINE,
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

    it.each([
      [
        'a page that has more',
        true,
        '**Max Chars:** 50,000 | **Offset:** 29,475 — more follows (next offset: 79,475) | **Match Offset:** 29,475',
      ],
      [
        'the last page',
        false,
        '**Max Chars:** 50,000 | **Offset:** 29,475 — end of document | **Match Offset:** 29,475',
      ],
    ])('appends the match offset to the offset line of %s', (_label, hasMore, line) => {
      const [block] = iaGetText.format!({
        text: 'Pemberley',
        char_offset: 29_475,
        match_offset: 29_475,
        max_chars: 50_000,
        has_more: hasMore,
        source_file: 'pp_djvu.txt',
      }) as [{ text: string }];
      expect(block.text.split('\n')).toContain(line);
    });

    it('renders no match offset without match_offset', () => {
      const [block] = iaGetText.format!({
        text: '',
        char_offset: 29_476,
        max_chars: 50_000,
        has_more: false,
        source_file: 'pp_djvu.txt',
      }) as [{ text: string }];
      expect(block.text.split('\n')).toContain(
        '**Max Chars:** 50,000 | **Offset:** 29,476 — end of document',
      );
      expect(block.text).not.toContain('Match Offset');
    });
  });
});
