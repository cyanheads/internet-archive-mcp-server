/**
 * @fileoverview Tests for the ia_get_item tool.
 * @module tests/tools/ia-get-item.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

    it('puts each value of a list description on its own line, keeping its line breaks', () => {
      const text = (
        iaGetItem.format!({
          identifier: 'x',
          description: ['First line\nsecond line', 'Third'],
          file_count: 0,
          files: [],
        })[0] as { text: string }
      ).text;
      expect(text).toContain('**Description:** First line\\\nsecond line\\\nThird\n');
    });

    it('renders a converted description as literal text', () => {
      const text = (
        iaGetItem.format!({
          identifier: 'x',
          description:
            '-from IMDB <a href="http://www.imdb.com/title/tt0092792/" rel="nofollow"></a>',
          file_count: 0,
          files: [],
        })[0] as { text: string }
      ).text;
      expect(text).toContain(
        '**Description:** -from IMDB \\<a href="http://www.imdb.com/title/tt0092792/" rel="nofollow">\\</a>',
      );
    });

    it('renders an image_count of 0, which structuredContent carries', () => {
      const text = (
        iaGetItem.format!({ identifier: 'x', image_count: 0, file_count: 0, files: [] })[0] as {
          text: string;
        }
      ).text;
      expect(text).toContain('**Page Images:** 0');
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

  describe('blank identifier', () => {
    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
    ])(
      'rejects the %s identifier as invalid_arguments without a metadata lookup',
      async (_label, identifier) => {
        const result = await runToolContract(iaGetItem, { identifier });

        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: unknown }).error).toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments' },
        });
        expect(contentText(result)).toContain('identifier: Must not be blank');
        expect(mockService.getItem).not.toHaveBeenCalled();
      },
    );

    it('trims surrounding whitespace from the identifier before the lookup', async () => {
      mockService.getItem.mockResolvedValue(fullItem);

      const result = await runToolContract(iaGetItem, { identifier: ' pg1342  ' });

      expect(result.isError).toBeFalsy();
      expect(mockService.getItem).toHaveBeenCalledWith('pg1342', expect.anything());
    });
  });

  describe('archive.org item URLs', () => {
    const errorData = (result: ToolResult) =>
      (result.structuredContent as { error: { code: number; data: Record<string, unknown> } })
        .error;

    it('looks up the identifier an archive.org details URL names', async () => {
      mockService.getItem.mockResolvedValue({
        ...fullItem,
        metadata: { ...fullItem.metadata, identifier: 'prideprejudice00aust' },
      });

      const result = await runToolContract(iaGetItem, {
        identifier: 'https://archive.org/details/prideprejudice00aust',
      });

      expect(result.isError).toBeFalsy();
      expect(mockService.getItem).toHaveBeenCalledWith('prideprejudice00aust', expect.anything());
      expect((result.structuredContent as { identifier: string }).identifier).toBe(
        'prideprejudice00aust',
      );
    });

    it('rejects a URL that names no item as invalid_identifier, on both surfaces, with no lookup', async () => {
      const result = await runToolContract(iaGetItem, { identifier: 'https://example.com/foo' });

      const recovery = iaGetItem.errors?.find((e) => e.reason === 'invalid_identifier')?.recovery;
      expect(errorData(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_identifier', recovery: { hint: recovery } },
      });
      expect(recovery).toContain('prideprejudice00aust');
      expect(contentText(result)).toContain('identifier is a URL on example.com');
      expect(contentText(result)).toContain(`Recovery: ${recovery}`);
      expect(mockService.getItem).not.toHaveBeenCalled();
    });

    it('points a Wayback Machine URL to ia_get_snapshot, with no lookup', async () => {
      const result = await runToolContract(iaGetItem, {
        identifier: 'https://web.archive.org/web/2020/https://example.com/',
      });

      expect(errorData(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'invalid_identifier',
          recovery: { hint: expect.stringContaining('ia_get_snapshot') },
        },
      });
      expect(contentText(result)).toContain('ia_get_snapshot');
      expect(mockService.getItem).not.toHaveBeenCalled();
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

  describe('title and date (documented single-valued, sometimes lists upstream)', () => {
    it('returns a list-valued title and date through output validation and renders every value', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: {
          identifier: '00hamigoog',
          title: ['Afganistan ', 'Афганистанъ '],
          date: ['1908', '1909'],
        },
        files: [],
      });

      const result = await runToolContract(iaGetItem, { identifier: '00hamigoog' });

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { title: unknown; date: unknown };
      expect(sc.title).toEqual(['Afganistan ', 'Афганистанъ ']);
      expect(sc.date).toEqual(['1908', '1909']);
      const text = contentText(result);
      expect(text).toMatch(/^# Afganistan , Афганистанъ/);
      expect(text).toContain('**Date:** 1908, 1909');
    });

    it('keeps a string title and date unchanged', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: {
          identifier: 'prideprejudice00aust',
          title: 'Pride and prejudice',
          date: '1894',
        },
        files: [],
      });

      const result = await runToolContract(iaGetItem, { identifier: 'prideprejudice00aust' });

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { title: unknown; date: unknown };
      expect(sc.title).toBe('Pride and prejudice');
      expect(sc.date).toBe('1894');
      expect(contentText(result)).toMatch(/^# Pride and prejudice\n/);
      expect(contentText(result)).toContain('**Date:** 1894');
    });

    it('keeps a list title holding a line break out of the heading', () => {
      const text = (
        iaGetItem.format!({
          identifier: 'x',
          title: ['First', 'Second\nline'],
          file_count: 0,
          files: [],
        })[0] as { text: string }
      ).text;
      expect(text).toMatch(/^First, Second\\\nline\n/);
    });

    it('accepts both shapes in the declared output schema', () => {
      const base = { identifier: 'x', file_count: 0, files: [] };
      expect(
        iaGetItem.output.parse({ ...base, title: ['a', 'b'], date: ['1', '2'] }),
      ).toMatchObject({ title: ['a', 'b'], date: ['1', '2'] });
      expect(iaGetItem.output.parse({ ...base, title: 'a', date: '1' })).toMatchObject({
        title: 'a',
        date: '1',
      });
    });
  });

  describe('catalog identifiers, access restriction, and private files', () => {
    const catalogued = {
      metadata: {
        identifier: 'dictionaryofmedi0002unse_x3v6',
        mediatype: 'texts',
        publisher: ['Westport, Conn. : Greenwood Press', 'Greenwood'],
        isbn: ['9780313328770', '0313328773'],
        oclc_id: '85792390',
        lccn: ['2006022953', 'cn 87032552'],
        openlibrary_edition: 'OL10420367M',
        openlibrary_work: 'OL3939167W',
        volume: '2',
        access_restricted: true,
        image_count: 354,
      },
      files: [
        {
          name: 'dictionaryofmedi0002unse_x3v6_djvu.txt',
          format: 'DjVuTXT',
          private: true,
          downloadUrl:
            'https://archive.org/download/dictionaryofmedi0002unse_x3v6/dictionaryofmedi0002unse_x3v6_djvu.txt',
        },
        {
          name: 'dictionaryofmedi0002unse_x3v6_meta.xml',
          format: 'Metadata',
          downloadUrl:
            'https://archive.org/download/dictionaryofmedi0002unse_x3v6/dictionaryofmedi0002unse_x3v6_meta.xml',
        },
      ],
    };

    it('returns every catalog and access field through output validation on both surfaces', async () => {
      mockService.getItem.mockResolvedValue(catalogued);

      const result = await runToolContract(iaGetItem, {
        identifier: 'dictionaryofmedi0002unse_x3v6',
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        publisher: ['Westport, Conn. : Greenwood Press', 'Greenwood'],
        isbn: ['9780313328770', '0313328773'],
        oclc_id: '85792390',
        lccn: ['2006022953', 'cn 87032552'],
        openlibrary_edition: 'OL10420367M',
        openlibrary_work: 'OL3939167W',
        volume: '2',
        access_restricted: true,
        image_count: 354,
      });
      const text = contentText(result);
      for (const line of [
        '**Publisher:** Westport, Conn. : Greenwood Press, Greenwood',
        '**Volume:** 2',
        '**ISBN:** 9780313328770, 0313328773',
        '**OCLC ID:** 85792390',
        '**LCCN:** 2006022953, cn 87032552',
        '**Open Library Edition:** OL10420367M',
        '**Open Library Work:** OL3939167W',
        '**Page Images:** 354',
        '**Access Restricted:** true',
      ]) {
        expect(text).toContain(line);
      }
    });

    it('marks a private file on both surfaces and leaves a public one unmarked', async () => {
      mockService.getItem.mockResolvedValue(catalogued);

      const result = await runToolContract(iaGetItem, {
        identifier: 'dictionaryofmedi0002unse_x3v6',
      });

      const files = (result.structuredContent as { files: Record<string, unknown>[] }).files;
      expect(files[0]).toMatchObject({ private: true });
      expect(files[1]).not.toHaveProperty('private');
      const text = contentText(result);
      expect(text).toContain('- **dictionaryofmedi0002unse_x3v6_djvu.txt** (DjVuTXT, private):');
      expect(text).toContain('- **dictionaryofmedi0002unse_x3v6_meta.xml** (Metadata):');
    });

    it('omits every field the item lacks on both surfaces', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: { identifier: 'sparse-id' },
        files: [{ name: 'a.pdf', downloadUrl: 'https://archive.org/download/sparse-id/a.pdf' }],
      });

      const result = await runToolContract(iaGetItem, { identifier: 'sparse-id' });

      const sc = result.structuredContent as Record<string, unknown>;
      for (const key of [
        'publisher',
        'isbn',
        'oclc_id',
        'lccn',
        'openlibrary_edition',
        'openlibrary_work',
        'volume',
        'access_restricted',
        'image_count',
      ]) {
        expect(sc).not.toHaveProperty(key);
      }
      expect((sc.files as Record<string, unknown>[])[0]).not.toHaveProperty('private');
      const text = contentText(result);
      for (const label of [
        'Publisher',
        'ISBN',
        'OCLC',
        'LCCN',
        'Open Library',
        'Volume',
        'Page Images',
        'Access',
        'private',
      ]) {
        expect(text).not.toContain(label);
      }
    });

    it('accepts a single value or a list for publisher, isbn, oclc_id, and lccn', () => {
      const base = { identifier: 'x', file_count: 0, files: [] };
      const lists = {
        publisher: ['a', 'b'],
        isbn: ['1', '2'],
        oclc_id: ['3', '4'],
        lccn: ['5', '6'],
      };
      const singles = { publisher: 'a', isbn: '1', oclc_id: '3', lccn: '5' };
      expect(iaGetItem.output.parse({ ...base, ...lists })).toMatchObject(lists);
      expect(iaGetItem.output.parse({ ...base, ...singles })).toMatchObject(singles);
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
      ['max_files 300001', { max_files: 300_001 }, 'max_files', 'too_big'],
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

    it('serves max_files above the cap on an item with fewer files, with no truncation or notice', async () => {
      const { result, sc } = await run({ max_files: 1000 });

      expect(structuredNames(result)).toEqual(names(bigManifest));
      expect(sc).not.toHaveProperty('truncated');
      expect(sc).not.toHaveProperty('cap');
      expect(sc).not.toHaveProperty('notice');
      expect(contentText(result)).toContain('**Files (297):**');
    });
  });

  describe('max_files above the 500 cap', () => {
    /** 1,234 files, half of them `JPEG Thumb`, so both the whole manifest and a filtered one run past the cap. */
    const hugeManifest = Array.from({ length: 1_234 }, (_, i) => {
      const name = `f_${String(i).padStart(4, '0')}`;
      return {
        name,
        format: i % 2 === 0 ? 'JPEG Thumb' : 'Text PDF',
        downloadUrl: `https://archive.org/download/huge/${name}`,
      };
    });
    const names = (files: { name: string }[]) => files.map((f) => f.name);

    beforeEach(() => {
      mockService.getItem.mockResolvedValue({
        metadata: { identifier: 'huge', title: 'Huge item' },
        files: hugeManifest,
      });
    });

    const run = async (input: Record<string, unknown>) => {
      const result = await runToolContract(iaGetItem, { identifier: 'huge', ...input });
      expect(result.isError).toBeFalsy();
      expect(renderedNames(result)).toEqual(structuredNames(result));
      return { result, sc: result.structuredContent as Record<string, unknown> };
    };

    it('serves max_files 1000 at 500, naming the cap and the next file_offset on both surfaces', async () => {
      const { result, sc } = await run({ max_files: 1000 });

      expect(structuredNames(result)).toEqual(names(hugeManifest.slice(0, 500)));
      expect(sc).toMatchObject({ truncated: true, shown: 500, cap: 500 });
      expect(sc.notice).toContain('max_files 1000 is above the cap of 500 per call');
      expect(sc.notice).toContain('Showing files 1–500 of 1234');
      expect(sc.notice).toContain('file_offset: 500');
      const text = contentText(result);
      expect(text).toContain('max_files 1000 is above the cap of 500 per call');
      expect(text).toContain('file_offset: 500');
      expect(text).toContain('showing 500 of 1234');
    });

    it('serves the 300,000 ceiling at 500', async () => {
      const { result, sc } = await run({ max_files: 300_000 });

      expect(structuredNames(result)).toEqual(names(hugeManifest.slice(0, 500)));
      expect(sc).toMatchObject({ truncated: true, shown: 500, cap: 500 });
    });

    it('walks the whole manifest by the advertised file_offset with no gap or repeat', async () => {
      const seen: string[] = [];
      const offsets: number[] = [];
      let offset = 0;
      for (let pages = 0; pages < 10; pages++) {
        offsets.push(offset);
        const { result, sc } = await run({ max_files: 1000, file_offset: offset });
        seen.push(...structuredNames(result));
        if (!sc.truncated) {
          expect(sc).not.toHaveProperty('notice');
          break;
        }
        expect(sc.cap).toBe(500);
        offset = Number(/file_offset: (\d+)/.exec(sc.notice as string)?.[1]);
      }

      expect(offsets).toEqual([0, 500, 1000]);
      expect(seen).toEqual(names(hugeManifest));
    });

    it('applies the cap after the format filter and names the filtered count', async () => {
      const thumbs = hugeManifest.filter((f) => f.format === 'JPEG Thumb');

      const first = await run({ format: 'JPEG Thumb', max_files: 2000 });
      expect(structuredNames(first.result)).toEqual(names(thumbs.slice(0, 500)));
      expect(first.sc).toMatchObject({ totalCount: 617, truncated: true, shown: 500, cap: 500 });
      expect(first.sc.notice).toContain('Showing files 1–500 of 617 matching');
      expect(first.sc.notice).toContain('file_offset: 500');

      const last = await run({ format: 'JPEG Thumb', max_files: 2000, file_offset: 500 });
      expect(structuredNames(last.result)).toEqual(names(thumbs.slice(500)));
      expect(last.sc).not.toHaveProperty('truncated');
      expect(last.sc).not.toHaveProperty('notice');
    });

    it('keeps the past-the-end notice for an over-cap max_files', async () => {
      const { sc } = await run({ max_files: 1000, file_offset: 5000 });

      expect(sc.files).toEqual([]);
      expect(sc).not.toHaveProperty('truncated');
      expect(sc.notice).toContain('file_offset 5000 is past the last of 1234 files');
      expect(sc.notice).not.toContain('cap of 500');
    });

    it('reports the requested cap, not 500, when max_files is at or below it', async () => {
      const { sc } = await run({ max_files: 499 });

      expect(sc).toMatchObject({ truncated: true, shown: 499, cap: 499 });
      expect(sc.notice).not.toContain('cap of 500');
      expect(sc.notice).toContain('file_offset: 499');
    });

    it('rejects max_files above the 300,000 ceiling, naming it, before any lookup', async () => {
      const result = await runToolContract(iaGetItem, { identifier: 'huge', max_files: 300_001 });

      expect(result.isError).toBe(true);
      expect(contentText(result)).toContain('max_files: Too big: expected number to be <=300000');
      expect(mockService.getItem).not.toHaveBeenCalled();
    });
  });
});
