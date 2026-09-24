/**
 * @fileoverview Tests for the ia_get_item tool.
 * @module tests/tools/ia-get-item.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Every text block of the assembled result — format() render plus the enrichment trailer. */
const contentText = (result: ToolResult): string =>
  result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

/** File names in structuredContent, in order. */
const structuredNames = (result: ToolResult): string[] =>
  ((result.structuredContent as { files: { name: string }[] }).files ?? []).map((f) => f.name);

/** File names listed in content[] (each file renders as a `- **name**` bullet). */
const renderedNames = (result: ToolResult): string[] =>
  [...contentText(result).matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1] as string);

vi.mock('@/services/archive-metadata/archive-metadata-service.js', () => ({
  getArchiveMetadataService: vi.fn(),
}));

import { getArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

const mockService = {
  getItem: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (getArchiveMetadataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

/** Minimal well-formed ArchiveItem with all optional metadata present. */
const fullItem = {
  metadata: {
    identifier: 'pg1342',
    title: 'Pride and Prejudice',
    creator: 'Jane Austen',
    description: 'A novel by Jane Austen.',
    mediatype: 'texts',
    date: '1813',
    subject: ['romance', 'england'],
    collection: ['gutenberg', 'opensource'],
    licenseurl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    language: 'English',
  },
  files: [
    {
      name: 'pg1342.txt',
      format: 'Plain Text',
      size: '700000',
      md5: 'abc123',
      downloadUrl: 'https://archive.org/download/pg1342/pg1342.txt',
    },
    {
      name: 'pg1342_djvu.txt',
      format: 'DjVuTXT',
      downloadUrl: 'https://archive.org/download/pg1342/pg1342_djvu.txt',
    },
  ],
};

describe('iaGetItem', () => {
  it('returns full metadata and file manifest for a found item', async () => {
    mockService.getItem.mockResolvedValue(fullItem);

    const ctx = createMockContext({ errors: iaGetItem.errors });
    const input = iaGetItem.input.parse({ identifier: 'pg1342' });
    const result = await iaGetItem.handler(input, ctx);

    expect(result.identifier).toBe('pg1342');
    expect(result.title).toBe('Pride and Prejudice');
    expect(result.creator).toBe('Jane Austen');
    expect(result.mediatype).toBe('texts');
    expect(result.file_count).toBe(2);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].name).toBe('pg1342.txt');
    expect(result.files[0].download_url).toBe('https://archive.org/download/pg1342/pg1342.txt');
    expect(result.files[0].format).toBe('Plain Text');
    expect(result.files[0].size).toBe('700000');
    expect(result.files[0].md5).toBe('abc123');
  });

  it('handles sparse metadata — optional fields absent', async () => {
    mockService.getItem.mockResolvedValue({
      metadata: { identifier: 'sparse-id' },
      files: [],
    });

    const ctx = createMockContext({ errors: iaGetItem.errors });
    const input = iaGetItem.input.parse({ identifier: 'sparse-id' });
    const result = await iaGetItem.handler(input, ctx);

    expect(result.identifier).toBe('sparse-id');
    expect(result.title).toBeUndefined();
    expect(result.creator).toBeUndefined();
    expect(result.file_count).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  it('throws item_not_found when metadata API returns {}', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.getItem.mockRejectedValue(
      notFound('Item "nonexistent" not found in the Internet Archive.', {
        reason: 'item_not_found',
        identifier: 'nonexistent',
      }),
    );

    const ctx = createMockContext({ errors: iaGetItem.errors });
    const input = iaGetItem.input.parse({ identifier: 'nonexistent' });

    await expect(iaGetItem.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'item_not_found' },
    });
  });

  it('throws item_not_found when the item is dark (restricted)', async () => {
    // Dark items: service detects is_dark: true and throws item_not_found
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.getItem.mockRejectedValue(
      notFound('Item "pg1342" is dark (restricted) in the Internet Archive.', {
        reason: 'item_not_found',
        identifier: 'pg1342',
      }),
    );

    const ctx = createMockContext({ errors: iaGetItem.errors });
    const input = iaGetItem.input.parse({ identifier: 'pg1342' });

    await expect(iaGetItem.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'item_not_found' },
    });
  });

  it('handles description as an array (IA can return string or string[])', async () => {
    mockService.getItem.mockResolvedValue({
      metadata: {
        identifier: 'array-desc-item',
        description: ['First description sentence.', 'Second description sentence.'],
      },
      files: [],
    });

    const ctx = createMockContext({ errors: iaGetItem.errors });
    const input = iaGetItem.input.parse({ identifier: 'array-desc-item' });
    const result = await iaGetItem.handler(input, ctx);

    expect(result.description).toEqual([
      'First description sentence.',
      'Second description sentence.',
    ]);
  });

  it('handles description as a string (scalar form)', async () => {
    mockService.getItem.mockResolvedValue({
      metadata: {
        identifier: 'string-desc-item',
        description: 'A single description.',
      },
      files: [],
    });

    const ctx = createMockContext({ errors: iaGetItem.errors });
    const input = iaGetItem.input.parse({ identifier: 'string-desc-item' });
    const result = await iaGetItem.handler(input, ctx);

    expect(result.description).toBe('A single description.');
  });

  it('handles items with array creator and subject fields', async () => {
    mockService.getItem.mockResolvedValue({
      metadata: {
        identifier: 'multi-author',
        creator: ['Author A', 'Author B'],
        subject: ['subject1', 'subject2'],
      },
      files: [],
    });

    const ctx = createMockContext({ errors: iaGetItem.errors });
    const input = iaGetItem.input.parse({ identifier: 'multi-author' });
    const result = await iaGetItem.handler(input, ctx);

    expect(result.creator).toEqual(['Author A', 'Author B']);
    expect(result.subject).toEqual(['subject1', 'subject2']);
  });

  describe('format', () => {
    it('renders identifier, title, creator, and file listing', () => {
      const output = {
        identifier: 'pg1342',
        title: 'Pride and Prejudice',
        creator: 'Jane Austen',
        mediatype: 'texts',
        date: '1813',
        language: 'English',
        file_count: 1,
        files: [
          {
            name: 'pg1342.txt',
            format: 'Plain Text',
            size: '700000',
            download_url: 'https://archive.org/download/pg1342/pg1342.txt',
          },
        ],
      };
      const blocks = iaGetItem.format!(output);
      expect(blocks.some((b) => b.type === 'text')).toBe(true);
      const text = blocks.map((b) => (b as { type: string; text: string }).text).join('');
      expect(text).toContain('pg1342');
      expect(text).toContain('Pride and Prejudice');
      expect(text).toContain('Jane Austen');
      expect(text).toContain('pg1342.txt');
      expect(text).toContain('https://archive.org/download/pg1342/pg1342.txt');
    });

    it('falls back to identifier in title when title is absent', () => {
      const output = {
        identifier: 'no-title-id',
        file_count: 0,
        files: [],
      };
      const blocks = iaGetItem.format!(output);
      const text = blocks.map((b) => (b as { type: string; text: string }).text).join('');
      expect(text).toContain('no-title-id');
    });

    it('renders array subject and collection with comma join', () => {
      const output = {
        identifier: 'test',
        subject: ['s1', 's2'],
        collection: ['c1', 'c2'],
        file_count: 0,
        files: [],
      };
      const blocks = iaGetItem.format!(output);
      const text = blocks.map((b) => (b as { type: string; text: string }).text).join('');
      expect(text).toContain('s1, s2');
      expect(text).toContain('c1, c2');
    });
  });

  describe('assembled result (runToolContract)', () => {
    it('returns a small item whole on both surfaces with no enrichment', async () => {
      mockService.getItem.mockResolvedValue(fullItem);

      const result = await runToolContract(iaGetItem, { identifier: 'pg1342' });

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.file_count).toBe(2);
      expect(structuredNames(result)).toEqual(['pg1342.txt', 'pg1342_djvu.txt']);
      expect(renderedNames(result)).toEqual(['pg1342.txt', 'pg1342_djvu.txt']);
      expect(contentText(result)).toContain('**Files (2):**');
      expect(sc).not.toHaveProperty('truncated');
      expect(sc).not.toHaveProperty('totalCount');
      expect(sc).not.toHaveProperty('notice');
    });
  });

  describe('language (repeatable upstream field)', () => {
    it('returns an array language through output validation and renders it joined', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: {
          identifier: 'protestant-review_1938-01_15_1',
          language: ['German', 'English', 'French'],
        },
        files: [],
      });

      const result = await runToolContract(iaGetItem, {
        identifier: 'protestant-review_1938-01_15_1',
      });

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { language: unknown }).language).toEqual([
        'German',
        'English',
        'French',
      ]);
      expect(contentText(result)).toContain('**Language:** German, English, French');
    });

    it('keeps a single language a plain string, not a one-element array', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: { identifier: 'prideprejudice00aust', language: 'eng' },
        files: [],
      });

      const result = await runToolContract(iaGetItem, { identifier: 'prideprejudice00aust' });

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { language: unknown }).language).toBe('eng');
      expect(contentText(result)).toContain('**Language:** eng');
    });

    it('accepts both shapes in the declared output schema', () => {
      const base = { identifier: 'x', file_count: 0, files: [] };
      expect(iaGetItem.output.parse({ ...base, language: ['a', 'b'] }).language).toEqual([
        'a',
        'b',
      ]);
      expect(iaGetItem.output.parse({ ...base, language: 'a' }).language).toBe('a');
    });
  });

  describe('file manifest paging and format filter', () => {
    /**
     * A 297-file manifest shaped like a large scanned item: 275 `JPEG Thumb`
     * derivatives, one `DjVuTXT` at index 134, and 21 assorted other formats.
     */
    const OTHER_FORMATS = [
      'Metadata',
      'Item Tile',
      'Archive BitTorrent',
      'Text PDF',
      'Abbyy GZ',
      'Djvu XML',
      'Single Page Processed JP2 ZIP',
    ];
    const bigManifest = Array.from({ length: 297 }, (_, i) => {
      const name = `file_${String(i).padStart(3, '0')}`;
      const format =
        i === 134
          ? 'DjVuTXT'
          : i < 21
            ? (OTHER_FORMATS[i % OTHER_FORMATS.length] as string)
            : 'JPEG Thumb';
      return { name, format, downloadUrl: `https://archive.org/download/big/${name}` };
    });
    const bigItem = { metadata: { identifier: 'big', title: 'Big item' }, files: bigManifest };
    const names = (files: { name: string }[]) => files.map((f) => f.name);

    beforeEach(() => {
      mockService.getItem.mockResolvedValue(bigItem);
    });

    /** Runs the tool and asserts content[] lists exactly the structuredContent file set. */
    const run = async (input: Record<string, unknown>) => {
      const result = await runToolContract(iaGetItem, { identifier: 'big', ...input });
      expect(result.isError).toBeFalsy();
      expect(renderedNames(result)).toEqual(structuredNames(result));
      return { result, sc: result.structuredContent as Record<string, unknown> };
    };

    it('returns the first 50 files by default and discloses the cap with the next offset', async () => {
      const { result, sc } = await run({});

      expect(structuredNames(result)).toEqual(names(bigManifest.slice(0, 50)));
      expect(sc.file_count).toBe(297);
      expect(sc).toMatchObject({ truncated: true, shown: 50, cap: 50 });
      expect(sc.notice).toContain('file_offset: 50');
      expect(sc).not.toHaveProperty('totalCount');
      expect(contentText(result)).toContain('file_offset: 50');
      expect(contentText(result)).toContain('showing 50 of 297');
    });

    it('reassembles the whole manifest page by page, in upstream order', async () => {
      const seen: string[] = [];
      const truncatedByOffset: Record<number, unknown> = {};
      for (let offset = 0; offset < 297; offset += 50) {
        const { result, sc } = await run({ file_offset: offset });
        seen.push(...structuredNames(result));
        truncatedByOffset[offset] = sc.truncated;
        if (sc.truncated) expect(sc.notice).toContain(`file_offset: ${offset + 50}`);
      }

      expect(seen).toEqual(names(bigManifest));
      expect(truncatedByOffset).toEqual({
        0: true,
        50: true,
        100: true,
        150: true,
        200: true,
        250: undefined,
      });
    });

    it('returns the last 47 files at file_offset 250 with no truncation', async () => {
      const { result, sc } = await run({ file_offset: 250 });

      expect(structuredNames(result)).toEqual(names(bigManifest.slice(250)));
      expect(sc.file_count).toBe(297);
      expect(sc).not.toHaveProperty('truncated');
      expect(sc).not.toHaveProperty('notice');
    });

    it('filters by format case-insensitively before paging', async () => {
      const { result, sc } = await run({ format: 'djvutxt' });

      expect(structuredNames(result)).toEqual(['file_134']);
      expect(sc.totalCount).toBe(1);
      expect(sc.file_count).toBe(297);
      expect(sc).not.toHaveProperty('truncated');
      expect(contentText(result)).toContain('**1 total**');
    });

    it('pages within a format filter past the first page', async () => {
      const thumbs = bigManifest.filter((f) => f.format === 'JPEG Thumb');

      const first = await run({ format: 'JPEG Thumb', max_files: 100 });
      expect(structuredNames(first.result)).toEqual(names(thumbs.slice(0, 100)));
      expect(first.sc).toMatchObject({ totalCount: 275, truncated: true, shown: 100, cap: 100 });
      expect(first.sc.notice).toContain('file_offset: 100');

      const last = await run({ format: 'JPEG Thumb', max_files: 100, file_offset: 200 });
      expect(structuredNames(last.result)).toEqual(names(thumbs.slice(200)));
      expect(last.sc.totalCount).toBe(275);
      expect(last.sc).not.toHaveProperty('truncated');
    });

    it('returns no files and lists the formats present when format matches nothing', async () => {
      const { result, sc } = await run({ format: 'VBR MP3' });

      expect(sc.files).toEqual([]);
      expect(sc.totalCount).toBe(0);
      expect(sc).not.toHaveProperty('truncated');
      for (const f of ['DjVuTXT', 'JPEG Thumb', 'Text PDF', 'Metadata']) {
        expect(sc.notice).toContain(f);
      }
      expect(contentText(result)).toContain('VBR MP3');
      expect(contentText(result)).toContain('JPEG Thumb');
    });

    it('returns no files, not an error, when file_offset is past the end', async () => {
      const { sc } = await run({ file_offset: 400 });

      expect(sc.files).toEqual([]);
      expect(sc.file_count).toBe(297);
      expect(sc).not.toHaveProperty('truncated');
      expect(sc.notice).toContain('297');
    });

    it('treats an empty-string format (form clients) as no filter', async () => {
      const { result, sc } = await run({ format: '  ' });

      expect(structuredNames(result)).toEqual(names(bigManifest.slice(0, 50)));
      expect(sc).not.toHaveProperty('totalCount');
    });

    it('does not report truncation when the cap is reached exactly with nothing left', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: { identifier: 'fifty' },
        files: bigManifest.slice(0, 50),
      });

      const result = await runToolContract(iaGetItem, { identifier: 'fifty' });
      const sc = result.structuredContent as Record<string, unknown>;

      expect(structuredNames(result)).toHaveLength(50);
      expect(sc).not.toHaveProperty('truncated');
      expect(sc).not.toHaveProperty('notice');
      expect(contentText(result)).toContain('**Files (50):**');
    });

    it('accepts max_files at its 1 and 500 bounds', async () => {
      const one = await run({ max_files: 1 });
      expect(structuredNames(one.result)).toEqual(['file_000']);
      expect(one.sc.notice).toContain('file_offset: 1');

      const all = await run({ max_files: 500 });
      expect(structuredNames(all.result)).toEqual(names(bigManifest));
      expect(all.sc).not.toHaveProperty('truncated');
    });

    it.each([
      ['max_files 0', { max_files: 0 }, 'max_files', 'too_small'],
      ['max_files 501', { max_files: 501 }, 'max_files', 'too_big'],
      ['max_files 2.5', { max_files: 2.5 }, 'max_files', 'invalid_type'],
      ['file_offset -1', { file_offset: -1 }, 'file_offset', 'too_small'],
    ])('rejects %s against the field bound', async (_label, input, field, issueCode) => {
      const result = await runToolContract(iaGetItem, { identifier: 'big', ...input });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { code: number; data: { issues: { code: string; path: string[] }[] } };
      };
      expect(error.code).toBe(-32602);
      expect(error.data.issues).toEqual([
        expect.objectContaining({ code: issueCode, path: [field] }),
      ]);
      expect(mockService.getItem).not.toHaveBeenCalled();
    });

    it('asks the service for the full item — slicing happens only in the handler', async () => {
      await run({ max_files: 5, file_offset: 10, format: 'JPEG Thumb' });

      expect(mockService.getItem).toHaveBeenCalledTimes(1);
      expect(mockService.getItem).toHaveBeenCalledWith('big', expect.anything());
    });
  });
});
