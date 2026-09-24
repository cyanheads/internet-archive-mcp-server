/**
 * @fileoverview Tests for the ia_search_items tool.
 * @module tests/tools/ia-search-items.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iaSearchItems } from '@/mcp-server/tools/definitions/ia-search-items.tool.js';

vi.mock('@/services/archive-search/archive-search-service.js', () => ({
  getArchiveSearchService: vi.fn(),
}));

import { getArchiveSearchService } from '@/services/archive-search/archive-search-service.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

const mockService = {
  search: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (getArchiveSearchService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

/** Every text block of the assembled result — format() render plus the enrichment trailer. */
const contentText = (result: ToolResult): string =>
  result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

/** The error envelope a client reads from structuredContent. */
const errorOf = (result: ToolResult) =>
  (
    result.structuredContent as {
      error: { code: number; data: { reason: string; recovery?: { hint: string } } };
    }
  ).error;

/** The complete Advanced Search mediatype vocabulary. */
const CANONICAL_MEDIATYPES = [
  'texts',
  'web',
  'movies',
  'audio',
  'data',
  'image',
  'collection',
  'software',
  'etree',
  'account',
];

const EMPTY_PAGE = { items: [], totalFound: 0, page: 1, rows: 50 };

/** The mediatype the handler forwarded to the service on its only call. */
const forwardedMediatype = () => {
  expect(mockService.search).toHaveBeenCalledOnce();
  const [params] = mockService.search.mock.calls[0] as [{ mediatype?: string }];
  return params.mediatype;
};

describe('iaSearchItems blank query', () => {
  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])(
    'rejects the %s query as invalid_arguments without calling the service',
    async (_label, query) => {
      const result = await runToolContract(iaSearchItems, { query });

      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      expect(contentText(result)).toContain('query: Must not be blank');
      expect(mockService.search).not.toHaveBeenCalled();
    },
  );

  it('trims surrounding whitespace from the query before searching', async () => {
    mockService.search.mockResolvedValue(EMPTY_PAGE);

    await runToolContract(iaSearchItems, { query: ' tesla ' });

    expect(mockService.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'tesla' }),
      expect.anything(),
    );
  });
});

describe('iaSearchItems mediatype', () => {
  it.each(CANONICAL_MEDIATYPES)('forwards the canonical value "%s" unchanged', async (value) => {
    mockService.search.mockResolvedValue(EMPTY_PAGE);

    const result = await runToolContract(iaSearchItems, { query: 'x', mediatype: value });

    expect(result.isError).toBeFalsy();
    expect(forwardedMediatype()).toBe(value);
  });

  it.each([
    ['text', 'texts'],
    ['Texts', 'texts'],
    [' TEXTS ', 'texts'],
    ['book', 'texts'],
    ['books', 'texts'],
    ['movie', 'movies'],
    ['video', 'movies'],
    ['Videos', 'movies'],
    ['MOVIES', 'movies'],
    ['images', 'image'],
    ['collections', 'collection'],
    ['Etree', 'etree'],
  ])('resolves "%s" to "%s"', async (value, canonical) => {
    mockService.search.mockResolvedValue(EMPTY_PAGE);

    const result = await runToolContract(iaSearchItems, { query: 'x', mediatype: value });

    expect(result.isError).toBeFalsy();
    expect(forwardedMediatype()).toBe(canonical);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('treats a %s mediatype as omitted', async (_label, mediatype) => {
    mockService.search.mockResolvedValue(EMPTY_PAGE);

    const result = await runToolContract(iaSearchItems, { query: 'x', mediatype });

    expect(result.isError).toBeFalsy();
    expect(forwardedMediatype()).toBeUndefined();
  });

  it.each(['videogames', 'textss', 'audio books'])(
    'rejects "%s" as invalid_mediatype, listing all ten values, without calling the service',
    async (mediatype) => {
      const result = await runToolContract(iaSearchItems, { query: 'x', mediatype });

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_mediatype' },
      });
      const recoveryLine = contentText(result)
        .split('\n')
        .find((line) => line.startsWith('Recovery:'));
      expect(recoveryLine).toBeDefined();
      for (const value of CANONICAL_MEDIATYPES) {
        expect(error.data.recovery?.hint).toMatch(new RegExp(`\\b${value}\\b`));
        expect(recoveryLine).toMatch(new RegExp(`\\b${value}\\b`));
      }
      expect(contentText(result)).toContain(`"${mediatype}"`);
      expect(contentText(result)).toContain('(reason invalid_mediatype');
      expect(mockService.search).not.toHaveBeenCalled();
    },
  );

  it('declares invalid_mediatype as InvalidParams with a recovery naming every value', () => {
    const entry = iaSearchItems.errors?.find((e) => e.reason === 'invalid_mediatype');
    expect(entry?.code).toBe(JsonRpcErrorCode.InvalidParams);
    for (const value of CANONICAL_MEDIATYPES) expect(entry?.recovery).toContain(value);
  });

  it('describes every canonical value on the mediatype field', () => {
    const description = iaSearchItems.input.shape.mediatype.description ?? '';
    for (const value of CANONICAL_MEDIATYPES) {
      expect(description).toMatch(new RegExp(`\\b${value}\\b`));
    }
  });
});

describe('iaSearchItems empty-result notice (assembled result)', () => {
  const noticeOf = (result: ToolResult) => (result.structuredContent as { notice?: string }).notice;

  it('keeps the generic guidance when no mediatype is set', async () => {
    mockService.search.mockResolvedValue(EMPTY_PAGE);

    const result = await runToolContract(iaSearchItems, { query: 'zzznoresultszzzz' });

    const expected =
      'No items matched "zzznoresultszzzz". Try broader search terms, remove filters, ' +
      'or verify the query syntax (Solr field prefixes: title:, creator:, subject:).';
    expect(noticeOf(result)).toBe(expected);
    expect(contentText(result)).toContain(expected);
  });

  it('names the canonical mediatype applied on both surfaces', async () => {
    mockService.search.mockResolvedValue(EMPTY_PAGE);

    const result = await runToolContract(iaSearchItems, {
      query: 'zzznoresultszzzz',
      mediatype: ' Video ',
    });

    const notice = noticeOf(result);
    expect(notice).toContain('No items matched "zzznoresultszzzz"');
    expect(notice).toContain('mediatype "movies"');
    expect(notice).not.toContain('Video');
    expect(contentText(result)).toContain('mediatype "movies"');
  });

  it('says the page is past the end, not that nothing matched, when results exist', async () => {
    mockService.search.mockResolvedValue({ items: [], totalFound: 120, page: 5, rows: 50 });

    const result = await runToolContract(iaSearchItems, {
      query: 'tesla',
      mediatype: 'texts',
      page: 5,
    });

    const notice = noticeOf(result) ?? '';
    expect(notice).not.toContain('No items matched');
    expect(notice).toContain('Page 5 is past the last page');
    expect(notice).toContain('page 3');
    expect(contentText(result)).toContain('Page 5 is past the last page');
  });

  it('sets no notice when the page has results', async () => {
    mockService.search.mockResolvedValue({
      items: [{ identifier: 'a' }],
      totalFound: 1,
      page: 1,
      rows: 50,
    });

    const result = await runToolContract(iaSearchItems, { query: 'tesla', mediatype: 'Texts' });

    expect(result.isError).toBeFalsy();
    expect(noticeOf(result)).toBeUndefined();
  });
});

describe('iaSearchItems', () => {
  it('returns items and pagination metadata on a successful search', async () => {
    mockService.search.mockResolvedValue({
      items: [
        {
          identifier: 'pg1342',
          title: 'Pride and Prejudice',
          creator: 'Jane Austen',
          mediatype: 'texts',
          date: '1998',
          downloads: 123456,
        },
      ],
      totalFound: 1,
      page: 1,
      rows: 50,
    });

    const ctx = createMockContext();
    const input = iaSearchItems.input.parse({ query: 'pride and prejudice' });
    const result = await iaSearchItems.handler(input, ctx);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].identifier).toBe('pg1342');
    expect(result.items[0].title).toBe('Pride and Prejudice');
    expect(result.total_found).toBe(1);
    expect(result.page).toBe(1);
    expect(result.rows).toBe(50);
  });

  it('returns empty items array with zero total when no results', async () => {
    mockService.search.mockResolvedValue({
      items: [],
      totalFound: 0,
      page: 1,
      rows: 50,
    });

    const ctx = createMockContext();
    const input = iaSearchItems.input.parse({ query: 'zzznoresultszzzz' });
    const result = await iaSearchItems.handler(input, ctx);

    expect(result.items).toHaveLength(0);
    expect(result.total_found).toBe(0);
  });

  it('handles sparse item — optional fields absent', async () => {
    mockService.search.mockResolvedValue({
      items: [{ identifier: 'sparse-item' }],
      totalFound: 1,
      page: 1,
      rows: 50,
    });

    const ctx = createMockContext();
    const input = iaSearchItems.input.parse({ query: 'sparse' });
    const result = await iaSearchItems.handler(input, ctx);

    expect(result.items[0].identifier).toBe('sparse-item');
    expect(result.items[0].title).toBeUndefined();
    expect(result.items[0].creator).toBeUndefined();
    expect(result.items[0].downloads).toBeUndefined();
  });

  it('handles items with array creator and collection fields', async () => {
    mockService.search.mockResolvedValue({
      items: [
        {
          identifier: 'multi',
          creator: ['Author A', 'Author B'],
          collection: ['col1', 'col2'],
        },
      ],
      totalFound: 1,
      page: 1,
      rows: 50,
    });

    const ctx = createMockContext();
    const input = iaSearchItems.input.parse({ query: 'multi' });
    const result = await iaSearchItems.handler(input, ctx);

    expect(result.items[0].creator).toEqual(['Author A', 'Author B']);
    expect(result.items[0].collection).toEqual(['col1', 'col2']);
  });

  it('passes filters through to the service', async () => {
    mockService.search.mockResolvedValue({ items: [], totalFound: 0, page: 1, rows: 10 });

    const ctx = createMockContext();
    const input = iaSearchItems.input.parse({
      query: 'test',
      mediatype: 'texts',
      collection: 'gutenberg',
      creator: 'Dickens',
      date_from: '1850-01-01',
      date_to: '1890-12-31',
      language: 'eng',
      sort: 'date asc',
      rows: 10,
      page: 2,
    });
    await iaSearchItems.handler(input, ctx);

    expect(mockService.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'test',
        mediatype: 'texts',
        collection: 'gutenberg',
        creator: 'Dickens',
        dateFrom: '1850-01-01',
        dateTo: '1890-12-31',
        language: 'eng',
        sort: 'date asc',
        rows: 10,
        page: 2,
      }),
      expect.anything(),
    );
  });

  it('strips whitespace-only optional filters before forwarding', async () => {
    mockService.search.mockResolvedValue({ items: [], totalFound: 0, page: 1, rows: 50 });

    const ctx = createMockContext();
    const input = iaSearchItems.input.parse({
      query: 'test',
      mediatype: '   ',
      collection: '  ',
    });
    await iaSearchItems.handler(input, ctx);

    expect(mockService.search).toHaveBeenCalledWith(
      expect.objectContaining({ mediatype: undefined, collection: undefined }),
      expect.anything(),
    );
  });

  describe('format', () => {
    it('renders total results, identifier, title, and creator in text', () => {
      const output = {
        items: [
          {
            identifier: 'pg1342',
            title: 'Pride and Prejudice',
            creator: 'Jane Austen',
            mediatype: 'texts',
            date: '1998',
            downloads: 100,
            collection: 'gutenberg',
          },
        ],
        total_found: 1,
        page: 1,
        rows: 50,
      };
      const blocks = iaSearchItems.format!(output);
      expect(blocks.some((b) => b.type === 'text')).toBe(true);
      const text = blocks.map((b) => (b as { type: string; text: string }).text).join('');
      expect(text).toContain('pg1342');
      expect(text).toContain('Pride and Prejudice');
      expect(text).toContain('Jane Austen');
      expect(text).toContain('1');
    });

    it('renders items with array creator and collection', () => {
      const output = {
        items: [
          {
            identifier: 'multi',
            creator: ['A', 'B'],
            collection: ['c1', 'c2'],
          },
        ],
        total_found: 1,
        page: 1,
        rows: 50,
      };
      const blocks = iaSearchItems.format!(output);
      const text = blocks.map((b) => (b as { type: string; text: string }).text).join('');
      expect(text).toContain('A, B');
      expect(text).toContain('c1, c2');
    });
  });
});
