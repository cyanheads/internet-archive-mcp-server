/**
 * @fileoverview Tests for the ia_get_item tool.
 * @module tests/tools/ia-get-item.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import type { CallDeadline } from '@/services/call-deadline.js';

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
        'fetch GET https://archive.org/metadata/pg1342 was aborted.',
      );
      /**
       * The call outlives its deadline and the caller leaves; the service checks the deadline
       * before its next request, which then fails as the cancellation it is.
       */
      mockService.getItem.mockImplementation(
        (_identifier: string, _ctx: unknown, deadline: CallDeadline) => {
          vi.advanceTimersByTime(56_000);
          caller.abort();
          deadline.assertTimeLeft();
          return Promise.reject(cancelled);
        },
      );
      const ctx = createMockContext({ errors: iaGetItem.errors, signal: caller.signal });

      await expect(
        iaGetItem.handler(iaGetItem.input.parse({ identifier: 'pg1342' }), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
        message: cancelled.message,
      });
    });
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

    it('renders each list of two or more values as one item per value between blank lines', () => {
      const output = {
        identifier: 'test',
        subject: ['s1', 's2'],
        collection: ['c1', 'c2'],
        file_count: 0,
        files: [],
      };
      const [block] = iaGetItem.format!(output) as [{ text: string }];
      expect(block.text).toBe(
        '# test\n**Identifier:** test\n**Subjects:**\n\n- s1\n- s2\n\n**Collection:**\n\n- c1\n- c2\n\n**Files (0):**',
      );
    });

    it('renders each value of a list description as its own item, keeping its line breaks', () => {
      const render = (description: string[]) =>
        (
          iaGetItem.format!({ identifier: 'x', description, file_count: 0, files: [] })[0] as {
            text: string;
          }
        ).text;
      expect(render(['First line\nsecond line', 'Third'])).toBe(
        '# x\n**Identifier:** x\n\n**Description:**\n\n- First line\\\nsecond line\n- Third\n\n**Files (0):**',
      );
      // Three values, and two whose second holds the line break: no longer the same text.
      expect(render(['Digitized.', 'Photocopy', 'Mode of access: Internet'])).toBe(
        '# x\n**Identifier:** x\n\n**Description:**\n\n- Digitized.\n- Photocopy\n- Mode of access: Internet\n\n**Files (0):**',
      );
      expect(render(['Digitized.', 'Photocopy\nMode of access: Internet'])).toBe(
        '# x\n**Identifier:** x\n\n**Description:**\n\n- Digitized.\n- Photocopy\\\nMode of access: Internet\n\n**Files (0):**',
      );
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

    it('renders a string or one-value list inline after its label, and a one-value title as the heading', () => {
      const text = (
        iaGetItem.format!({
          identifier: 'prideprejudice00aust',
          title: ['Pride and prejudice'],
          creator: 'Austen, Jane, 1775-1817',
          date: '1894',
          collection: ['americana'],
          description: ['A novel.'],
          file_count: 0,
          files: [],
        })[0] as { text: string }
      ).text;
      expect(text).toBe(
        '# Pride and prejudice\n**Identifier:** prideprejudice00aust\n**Creator:** Austen, Jane, 1775-1817\n**Date:** 1894\n**Collection:** americana\n\n**Description:** A novel.\n\n**Files (0):**',
      );
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

  describe('a stored description read by the real ArchiveMetadataService (#75)', () => {
    it('reads a text-level tag as nothing, so the comma stays on the word before it, on both surfaces', async () => {
      const { ArchiveMetadataService } = await vi.importActual<
        typeof import('@/services/archive-metadata/archive-metadata-service.js')
      >('@/services/archive-metadata/archive-metadata-service.js');
      (getArchiveMetadataService as ReturnType<typeof vi.fn>).mockReturnValue(
        new ArchiveMetadataService(
          { mcpServerVersion: '0.0.0-test' } as AppConfig,
          createInMemoryStorage(),
        ),
      );
      const http = createFetchMock([
        {
          method: 'GET',
          match: 'https://archive.org/metadata/recorded-live-1977',
          respond: Response.json({
            metadata: {
              identifier: 'recorded-live-1977',
              description: 'Recorded <i>live</i>, 1977.',
            },
            files: [],
          }),
        },
      ]);
      http.install();
      try {
        const result = await runToolContract(iaGetItem, { identifier: 'recorded-live-1977' });

        expect(result.isError).toBeFalsy();
        expect((result.structuredContent as { description?: unknown }).description).toBe(
          'Recorded live, 1977.',
        );
        expect(contentText(result)).toBe(
          '# recorded-live-1977\n**Identifier:** recorded-live-1977\n\n**Description:** Recorded live, 1977.\n\n**Files (0):**',
        );
        expect(http.calls).toHaveLength(1);
      } finally {
        http.restore();
      }
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
      expect(mockService.getItem).toHaveBeenCalledWith(
        'pg1342',
        expect.anything(),
        expect.objectContaining({ budgetSeconds: 55 }),
      );
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
      expect(mockService.getItem).toHaveBeenCalledWith(
        'prideprejudice00aust',
        expect.anything(),
        expect.objectContaining({ budgetSeconds: 55 }),
      );
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
    it('returns an array language through output validation and renders one item per language', async () => {
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
      expect(contentText(result)).toContain(
        '**Language:**\n\n- German\n- English\n- French\n\n**Files (0):**',
      );
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
    it('returns a list-valued title and date through output validation and lists every value, the identifier as the heading', async () => {
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
      expect(contentText(result)).toBe(
        '# 00hamigoog\n**Title:**\n\n- Afganistan&#32;\n- Афганистанъ&#32;\n\n**Identifier:** 00hamigoog\n**Date:**\n\n- 1908\n- 1909\n\n**Files (0):**',
      );
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

    it('keeps a title holding a line break out of the heading', () => {
      const render = (title: string[]) =>
        (
          iaGetItem.format!({ identifier: 'x', title, file_count: 0, files: [] })[0] as {
            text: string;
          }
        ).text;
      expect(render(['First', 'Second\nline'])).toBe(
        '# x\n**Title:**\n\n- First\n- Second\\\nline\n\n**Identifier:** x\n\n**Files (0):**',
      );
      expect(render(['Second\nline'])).toBe('Second\\\nline\n**Identifier:** x\n\n**Files (0):**');
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
      expect(contentText(result)).toContain(
        '\n**Media Type:** texts\n**Publisher:**\n\n- Westport, Conn. : Greenwood Press\n- Greenwood\n\n**Volume:** 2\n**ISBN:**\n\n- 9780313328770\n- 0313328773\n\n**OCLC ID:** 85792390\n**LCCN:**\n\n- 2006022953\n- cn 87032552\n\n**Open Library Edition:** OL10420367M\n**Open Library Work:** OL3939167W\n**Page Images:** 354\n**Access Restricted:** true\n\n**Files (2):**',
      );
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

  describe('rights, licenseurl, volume, mediatype, and Open Library IDs as strings or lists', () => {
    const WIDENED = [
      'mediatype',
      'licenseurl',
      'rights',
      'volume',
      'openlibrary_edition',
      'openlibrary_work',
    ] as const;

    /** format() text for one output with no files. */
    const render = (fields: Record<string, unknown>) =>
      (
        iaGetItem.format!({ identifier: 'x', file_count: 0, files: [], ...fields })[0] as {
          text: string;
        }
      ).text;

    it('returns a list in each of the six fields through output validation, one item per value', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: {
          identifier: 'x',
          mediatype: ['texts', 'texts'],
          licenseurl: [
            'https://opensource.org/licenses/MIT',
            'http://creativecommons.org/licenses/by-nc-sa/3.0',
          ],
          rights: ['Accessible without restriction.', 'Archived under fair use.'],
          volume: ['1931', '18'],
          openlibrary_edition: ['OL1M', 'OL2M'],
          openlibrary_work: ['OL1W', 'OL2W'],
        },
        files: [],
      });

      const result = await runToolContract(iaGetItem, { identifier: 'x' });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        mediatype: ['texts', 'texts'],
        licenseurl: [
          'https://opensource.org/licenses/MIT',
          'http://creativecommons.org/licenses/by-nc-sa/3.0',
        ],
        rights: ['Accessible without restriction.', 'Archived under fair use.'],
        volume: ['1931', '18'],
        openlibrary_edition: ['OL1M', 'OL2M'],
        openlibrary_work: ['OL1W', 'OL2W'],
      });
      expect(contentText(result)).toBe(
        '# x\n**Identifier:** x\n**Media Type:**\n\n- texts\n- texts\n\n**Volume:**\n\n- 1931\n- 18\n\n**Open Library Edition:**\n\n- OL1M\n- OL2M\n\n**Open Library Work:**\n\n- OL1W\n- OL2W\n\n**License:**\n\n- [https://opensource.org/licenses/MIT](<https://opensource.org/licenses/MIT>)\n- [http://creativecommons.org/licenses/by-nc-sa/3.0](<http://creativecommons.org/licenses/by-nc-sa/3.0>)\n\n**Rights:**\n\n- Accessible without restriction.\n- Archived under fair use.\n\n**Files (0):**',
      );
    });

    it('renders a string or one-value list license as an inline link, and a string rights statement escaped', () => {
      expect(render({ licenseurl: 'https://opensource.org/licenses/MIT', rights: '*r*' })).toBe(
        '# x\n**Identifier:** x\n**License:** [https://opensource.org/licenses/MIT](<https://opensource.org/licenses/MIT>)\n**Rights:** \\*r\\*\n\n**Files (0):**',
      );
      expect(render({ licenseurl: ['https://opensource.org/licenses/MIT'], rights: ['*r*'] })).toBe(
        '# x\n**Identifier:** x\n**License:** [https://opensource.org/licenses/MIT](<https://opensource.org/licenses/MIT>)\n**Rights:** \\*r\\*\n\n**Files (0):**',
      );
    });

    it('renders a license value that is not a web URL as literal text, never a link', () => {
      expect(render({ licenseurl: 'CC0 1.0' })).toBe(
        '# x\n**Identifier:** x\n**License:** CC0 1.0\n\n**Files (0):**',
      );
      expect(
        render({ licenseurl: ['javascript:alert(1)', 'https://example.org/a_(b)', 'CC0 1.0'] }),
      ).toBe(
        '# x\n**Identifier:** x\n**License:**\n\n- javascript:alert(1)\n- [https://example.org/a\\_(b)](<https://example.org/a_(b)>)\n- CC0 1.0\n\n**Files (0):**',
      );
    });

    it.each([
      ['a relative path', '/licenses/mit', '/licenses/mit'],
      ['an ftp URL', 'ftp://example.org/l', 'ftp://example.org/l'],
      ['a URL with a line break', 'https://a.org/\nx', 'https://a.org/\\\nx'],
      ['Markdown syntax', '*CC* [x](y)', '\\*CC\\* \\[x\\](y)'],
      ['a URL with a carriage return', 'https://a.org/\rx', 'https://a.org/\\\nx'],
    ])('renders a license value that is %s once, escaped', (_label, licenseurl, rendered) => {
      expect(render({ licenseurl })).toBe(
        `# x\n**Identifier:** x\n**License:** ${rendered}\n\n**Files (0):**`,
      );
    });

    it('links an http or https license URL in any letter case, as markdownLink does', () => {
      expect(render({ licenseurl: ['HTTPS://Example.org/A', 'http://a.org/b c'] })).toBe(
        '# x\n**Identifier:** x\n**License:**\n\n- [HTTPS://Example.org/A](<HTTPS://Example.org/A>)\n- [http://a.org/b c](<http://a.org/b c>)\n\n**Files (0):**',
      );
    });

    it('keeps the rights items apart from the access line after them, commas and line breaks inside their item', () => {
      expect(
        render({ rights: ['a, b', 'c\nd'], access_restricted: true, description: 'Desc' }),
      ).toBe(
        '# x\n**Identifier:** x\n**Rights:**\n\n- a, b\n- c\\\nd\n\n**Access Restricted:** true\n\n**Description:** Desc\n\n**Files (0):**',
      );
    });

    it('accepts a single value or a list for each of the six fields', () => {
      const base = { identifier: 'x', file_count: 0, files: [] };
      for (const key of WIDENED) {
        expect(iaGetItem.output.parse({ ...base, [key]: ['a', 'b'] })).toHaveProperty(key, [
          'a',
          'b',
        ]);
        expect(iaGetItem.output.parse({ ...base, [key]: 'a' })).toHaveProperty(key, 'a');
        expect(() => iaGetItem.output.parse({ ...base, [key]: 5 })).toThrow();
      }
    });

    it('declares each of the six fields as a string or a list of strings', () => {
      const { properties } = z.toJSONSchema(iaGetItem.output) as {
        properties: Record<string, { anyOf?: { type: string; items?: { type: string } }[] }>;
      };
      for (const key of WIDENED) {
        expect(properties[key]?.anyOf?.map((s) => [s.type, s.items?.type])).toEqual([
          ['string', undefined],
          ['array', 'string'],
        ]);
      }
    });
  });

  describe('publicdate and addeddate (when the item reached the Archive)', () => {
    it('returns both upload dates on both surfaces, after the publication date', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: {
          identifier: 'prideprejudice00aust',
          title: 'Pride and prejudice',
          date: '1894',
          publicdate: '2007-07-26 11:49:20',
          addeddate: '2007-07-26 11:49:10',
          language: 'eng',
        },
        files: [],
      });

      const result = await runToolContract(iaGetItem, { identifier: 'prideprejudice00aust' });

      expect(result.isError).toBeFalsy();
      expect(Object.keys(result.structuredContent as object)).toEqual([
        'identifier',
        'title',
        'date',
        'publicdate',
        'addeddate',
        'language',
        'file_count',
        'files',
      ]);
      expect(result.structuredContent).toMatchObject({
        publicdate: '2007-07-26 11:49:20',
        addeddate: '2007-07-26 11:49:10',
      });
      expect(contentText(result)).toBe(
        '# Pride and prejudice\n**Identifier:** prideprejudice00aust\n**Date:** 1894\n**Public Date:** 2007-07-26 11:49:20\n**Added Date:** 2007-07-26 11:49:10\n**Language:** eng\n\n**Files (0):**',
      );
    });

    it('omits either date the record lacks, on both surfaces, and the call succeeds', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: { identifier: 'openmind_ep431', date: '2020', addeddate: '2020-01-02' },
        files: [],
      });

      const result = await runToolContract(iaGetItem, { identifier: 'openmind_ep431' });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).not.toHaveProperty('publicdate');
      expect(contentText(result)).toBe(
        '# openmind_ep431\n**Identifier:** openmind_ep431\n**Date:** 2020\n**Added Date:** 2020-01-02\n\n**Files (0):**',
      );
    });

    it('lists each value of a list-valued publicdate', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: { identifier: 'x', publicdate: ['2007-07-26 11:49:20', '2008-01-01 00:00:00'] },
        files: [],
      });

      const result = await runToolContract(iaGetItem, { identifier: 'x' });

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { publicdate: unknown }).publicdate).toEqual([
        '2007-07-26 11:49:20',
        '2008-01-01 00:00:00',
      ]);
      expect(contentText(result)).toBe(
        '# x\n**Identifier:** x\n**Public Date:**\n\n- 2007-07-26 11:49:20\n- 2008-01-01 00:00:00\n\n**Files (0):**',
      );
    });

    it('describes date as the publication date only, pointing to the upload dates', () => {
      const { properties } = z.toJSONSchema(iaGetItem.output) as {
        properties: Record<string, { description?: string }>;
      };
      expect(JSON.stringify(z.toJSONSchema(iaGetItem.output))).not.toMatch(/or upload/);
      expect(iaGetItem.description).toContain(
        'description (as plain text), the publication date, when the item was made public and when it was added to the Archive, subjects,',
      );
      expect(properties.date?.description).toBe(
        'Publication date when provided; a few records carry a list, relayed as received. For when the item reached the Archive, see publicdate and addeddate.',
      );
      expect(properties.publicdate?.description).toBe(
        'When the item was made public on the Archive, as the Metadata API stores it: "YYYY-MM-DD HH:MM:SS" in UTC; a list is relayed as received. Nearly every item has it, dated or not.',
      );
      expect(properties.addeddate?.description).toBe(
        'When the item was added to the Archive, as the Metadata API stores it: "YYYY-MM-DD HH:MM:SS" in UTC, or on some records a bare "YYYY-MM-DD"; a list is relayed as received.',
      );
    });
  });

  describe('each audio or video file’s title, track, and length, and the item’s runtime', () => {
    const GD = 'gd77-05-08.sbd.hicks.4982.sbeok.shnf';
    const url = (name: string) => `https://archive.org/download/${GD}/${name}`;
    const link = (name: string) => `[${url(name)}](<${url(name)}>)`;

    /** format() text for one output; files carry only their name and URL unless given more. */
    const render = (fields: Record<string, unknown>) =>
      (
        iaGetItem.format!({ identifier: GD, file_count: 0, files: [], ...fields })[0] as {
          text: string;
        }
      ).text;

    it('returns each file’s title, track, and length on both surfaces, a nested item per detail', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: { identifier: GD, title: 'Grateful Dead Live at Barton Hall' },
        files: [
          {
            name: 'gd77-05-08eaton-d1t01.mp3',
            downloadUrl: url('gd77-05-08eaton-d1t01.mp3'),
            format: 'VBR MP3',
            size: '8838656',
            md5: '96d1fc48cae5e3bdd62c383d5b458a43',
            title: 'Minglewood Blues',
            track: '1',
            length: '06:21',
          },
          {
            name: 'gd77-05-08eaton-d1t01.ogg',
            downloadUrl: url('gd77-05-08eaton-d1t01.ogg'),
            format: 'Ogg Vorbis',
            length: '381.1',
          },
          {
            name: 'gd77-05-08eaton-d1t01.shn',
            downloadUrl: url('gd77-05-08eaton-d1t01.shn'),
            format: 'Shorten',
            title: 'Minglewood Blues',
            track: '1',
            length: '232.58',
            private: true,
          },
        ],
      });

      const result = await runToolContract(iaGetItem, { identifier: GD });

      expect(result.isError).toBeFalsy();
      expect(JSON.stringify((result.structuredContent as { files: unknown }).files)).toBe(
        JSON.stringify([
          {
            name: 'gd77-05-08eaton-d1t01.mp3',
            title: 'Minglewood Blues',
            track: '1',
            length: '06:21',
            format: 'VBR MP3',
            size: '8838656',
            md5: '96d1fc48cae5e3bdd62c383d5b458a43',
            download_url: url('gd77-05-08eaton-d1t01.mp3'),
          },
          {
            name: 'gd77-05-08eaton-d1t01.ogg',
            length: '381.1',
            format: 'Ogg Vorbis',
            download_url: url('gd77-05-08eaton-d1t01.ogg'),
          },
          {
            name: 'gd77-05-08eaton-d1t01.shn',
            title: 'Minglewood Blues',
            track: '1',
            length: '232.58',
            format: 'Shorten',
            private: true,
            download_url: url('gd77-05-08eaton-d1t01.shn'),
          },
        ]),
      );
      expect(contentText(result)).toBe(
        `# Grateful Dead Live at Barton Hall\n**Identifier:** ${GD}\n\n**Files (3):**\n- **gd77-05-08eaton-d1t01.mp3** (VBR MP3, 8838656 bytes, md5:96d1fc48cae5e3bdd62c383d5b458a43): ${link('gd77-05-08eaton-d1t01.mp3')}\n  - **Title:** Minglewood Blues\n  - **Track:** 1\n  - **Length:** 06:21\n- **gd77-05-08eaton-d1t01.ogg** (Ogg Vorbis): ${link('gd77-05-08eaton-d1t01.ogg')}\n  - **Length:** 381.1\n- **gd77-05-08eaton-d1t01.shn** (Shorten, private): ${link('gd77-05-08eaton-d1t01.shn')}\n  - **Title:** Minglewood Blues\n  - **Track:** 1\n  - **Length:** 232.58`,
      );
    });

    it('renders a file with none of the three on exactly its one line', () => {
      const files = [
        { name: 'gd77-05-08eaton-d1t01.png', format: 'PNG', size: '9430', md5: 'd1' },
        { name: 'notes.txt' },
      ].map((f) => ({ ...f, download_url: url(f.name) }));

      expect(render({ file_count: 2, files })).toBe(
        `# ${GD}\n**Identifier:** ${GD}\n\n**Files (2):**\n- **gd77-05-08eaton-d1t01.png** (PNG, 9430 bytes, md5:d1): ${link('gd77-05-08eaton-d1t01.png')}\n- **notes.txt**: ${link('notes.txt')}`,
      );
    });

    it('keeps a title holding a comma, a line break, or Markdown syntax inside its own item', () => {
      const files = [
        {
          name: 'a.mp3',
          title: 'One, two\nthree',
          track: '- 1',
          length: '*06:21*',
          download_url: url('a.mp3'),
        },
        { name: 'b.mp3', title: '# [x](y) <b>z</b>', download_url: url('b.mp3') },
      ];

      expect(render({ file_count: 2, files })).toBe(
        `# ${GD}\n**Identifier:** ${GD}\n\n**Files (2):**\n- **a.mp3**: ${link('a.mp3')}\n  - **Title:** One, two\\\nthree\n  - **Track:** \\- 1\n  - **Length:** \\*06:21\\*\n- **b.mp3**: ${link('b.mp3')}\n  - **Title:** \\# \\[x\\](y) \\<b>z\\</b>`,
      );
      expect(files[0]?.title).toBe('One, two\nthree');
    });

    it('renders the track "0" a checksum file is catalogued with as its own item', () => {
      const files = [
        {
          name: 'gd1977-05-08-d1.md5',
          format: 'Checksums',
          title: 'gd77-05-08.sbd.hicks.4982.sbeok.shnf_shn.zip',
          track: '0',
          download_url: url('gd1977-05-08-d1.md5'),
        },
      ];

      expect(render({ file_count: 1, files })).toBe(
        `# ${GD}\n**Identifier:** ${GD}\n\n**Files (1):**\n- **gd1977-05-08-d1.md5** (Checksums): ${link('gd1977-05-08-d1.md5')}\n  - **Title:** gd77-05-08.sbd.hicks.4982.sbeok.shnf_shn.zip\n  - **Track:** 0`,
      );
    });

    it('returns runtime on both surfaces as a Runtime line, after the Open Library IDs', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: {
          identifier: 'pride_and_prejudice_librivox',
          title: 'Pride and Prejudice',
          mediatype: 'audio',
          openlibrary_work: 'OL66554W',
          runtime: '13:06:44',
        },
        files: [],
      });

      const result = await runToolContract(iaGetItem, {
        identifier: 'pride_and_prejudice_librivox',
      });

      expect(result.isError).toBeFalsy();
      expect(Object.keys(result.structuredContent as object)).toEqual([
        'identifier',
        'title',
        'mediatype',
        'openlibrary_work',
        'runtime',
        'file_count',
        'files',
      ]);
      expect(result.structuredContent).toMatchObject({ runtime: '13:06:44' });
      expect(contentText(result)).toBe(
        '# Pride and Prejudice\n**Identifier:** pride_and_prejudice_librivox\n**Media Type:** audio\n**Open Library Work:** OL66554W\n**Runtime:** 13:06:44\n\n**Files (0):**',
      );
    });

    it('lists each value of a list runtime, through output validation', async () => {
      mockService.getItem.mockResolvedValue({
        metadata: { identifier: 'x', runtime: ['00:03:09', '27 min 13 sec'], image_count: 2 },
        files: [],
      });

      const result = await runToolContract(iaGetItem, { identifier: 'x' });

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { runtime: unknown }).runtime).toEqual([
        '00:03:09',
        '27 min 13 sec',
      ]);
      expect(contentText(result)).toBe(
        '# x\n**Identifier:** x\n**Runtime:**\n\n- 00:03:09\n- 27 min 13 sec\n\n**Page Images:** 2\n\n**Files (0):**',
      );
    });

    it('declares runtime as a string or a list, and title, track, and length as file strings', () => {
      const schema = z.toJSONSchema(iaGetItem.output) as {
        properties: Record<
          string,
          {
            anyOf?: { type: string; items?: { type: string } }[];
            items?: { properties: Record<string, { type: string; description: string }> };
          }
        >;
      };
      const { runtime, files } = schema.properties;
      expect(runtime?.anyOf?.map((s) => [s.type, s.items?.type])).toEqual([
        ['string', undefined],
        ['array', 'string'],
      ]);
      const file = files?.items?.properties ?? {};
      expect(Object.keys(file)).toEqual([
        'name',
        'title',
        'track',
        'length',
        'format',
        'size',
        'md5',
        'private',
        'download_url',
      ]);
      expect([file.title?.type, file.track?.type, file.length?.type]).toEqual([
        'string',
        'string',
        'string',
      ]);
      expect(() =>
        iaGetItem.output.parse({
          identifier: 'x',
          file_count: 1,
          files: [{ name: 'a', download_url: 'u', track: 1 }],
        }),
      ).toThrow();
      expect(iaGetItem.description).toContain(
        'volume, the running time of an audio or video item, the page-image count of a text item,',
      );
      expect(iaGetItem.description).toContain(
        'and for an audio or video file the track title, track number, and duration it is catalogued with;',
      );
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
      expect(mockService.getItem).toHaveBeenCalledWith(
        'big',
        expect.anything(),
        expect.objectContaining({ budgetSeconds: 55 }),
      );
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
