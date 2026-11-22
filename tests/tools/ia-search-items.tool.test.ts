/**
 * @fileoverview Tests for the ia_search_items tool.
 * @module tests/tools/ia-search-items.tool.test
 */

import { JsonRpcErrorCode, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iaSearchItems } from '@/mcp-server/tools/definitions/ia-search-items.tool.js';
import type { CallDeadline } from '@/services/call-deadline.js';

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
      expect.objectContaining({ budgetSeconds: 55 }),
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

  it('names every filter applied, in order, on both surfaces', async () => {
    mockService.search.mockResolvedValue(EMPTY_PAGE);

    const result = await runToolContract(iaSearchItems, {
      query: 'zzz',
      mediatype: 'book',
      collection: ' gutenberg ',
      creator: 'Qzxv Wrrbl',
      language: 'eng',
      date_from: '1850',
      date_to: '1890-12',
    });

    expect(noticeOf(result)).toBe(
      'No items matched "zzz" with mediatype "texts", collection "gutenberg", creator "Qzxv Wrrbl", language "eng", date_from "1850", date_to "1890-12". Try broader search terms, remove filters, or verify the query syntax (Solr field prefixes: title:, creator:, subject:).',
    );
    expect(contentText(result)).toContain(
      'with mediatype "texts", collection "gutenberg", creator "Qzxv Wrrbl", language "eng", date_from "1850", date_to "1890-12".',
    );
  });

  it.each([
    ['collection', 'gutenberg'],
    ['creator', 'Qzxv Wrrbl'],
    ['language', 'eng'],
    ['date_from', '1850'],
    ['date_to', '1890'],
  ])('names %s when it is the only filter', async (field, value) => {
    mockService.search.mockResolvedValue(EMPTY_PAGE);

    const result = await runToolContract(iaSearchItems, { query: 'zzz', [field]: value });

    expect(noticeOf(result)).toContain(`No items matched "zzz" with ${field} "${value}". Try`);
  });

  it('leaves a blank filter out of the notice', async () => {
    mockService.search.mockResolvedValue(EMPTY_PAGE);

    const result = await runToolContract(iaSearchItems, {
      query: 'zzz',
      creator: '   ',
      language: '',
    });

    expect(noticeOf(result)).toContain('No items matched "zzz". Try');
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
      expect.objectContaining({ budgetSeconds: 55 }),
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
      expect.objectContaining({ budgetSeconds: 55 }),
    );
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
        'fetch GET https://archive.org/advancedsearch.php?q=tesla was aborted.',
      );
      /**
       * The call outlives its deadline and the caller leaves; the service checks the deadline
       * before its next request, which then fails as the cancellation it is.
       */
      mockService.search.mockImplementation(
        (_params: unknown, _ctx: unknown, deadline: CallDeadline) => {
          vi.advanceTimersByTime(56_000);
          caller.abort();
          deadline.assertTimeLeft();
          return Promise.reject(cancelled);
        },
      );
      const ctx = createMockContext({ signal: caller.signal });

      await expect(
        iaSearchItems.handler(iaSearchItems.input.parse({ query: 'tesla' }), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
        message: cancelled.message,
      });
    });
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

    it('renders each list of two or more values as one item per value between blank lines', () => {
      const output = {
        items: [
          {
            identifier: 'multi',
            creator: ['A', 'B'],
            collection: ['c1', 'c2'],
          },
          { identifier: 'next' },
        ],
        total_found: 2,
        page: 1,
        rows: 50,
      };
      const [block] = iaSearchItems.format!(output) as [{ text: string }];
      expect(block.text).toBe(
        '**2 total results** — Page 1 (2 shown, 50 per page)\n\n## multi\n**Identifier:** multi\n**Creator:**\n\n- A\n- B\n\n**Collection:**\n\n- c1\n- c2\n\n## next\n**Identifier:** next\n',
      );
    });

    it('lists list-valued title and date under the identifier heading, and names a cut creator list on its label line', () => {
      const output = {
        items: [
          {
            identifier: 'listy',
            title: ['Part One', 'Part Two'],
            date: ['2012-06-26T00:00:00Z', '2012-08-14T00:00:00Z'],
            creator: ['A', 'B'],
            creator_count: 409,
          },
        ],
        total_found: 1,
        page: 1,
        rows: 50,
      };
      const [block] = iaSearchItems.format!(output) as [{ text: string }];
      expect(block.text).toBe(
        '**1 total results** — Page 1 (1 shown, 50 per page)\n\n## listy\n**Title:**\n\n- Part One\n- Part Two\n\n**Identifier:** listy\n**Creator:** (2 of 409; ia_get_item lists all)\n\n- A\n- B\n\n**Date:**\n\n- 2012-06-26T00:00:00Z\n- 2012-08-14T00:00:00Z\n',
      );
    });

    it('renders a string or one-value list inline after its label, and a one-value title as the heading', () => {
      const output = {
        items: [
          {
            identifier: '00hamigoog',
            title: ['Afganistan'],
            creator: 'Berezovskīĭ, V.',
            date: ['1908'],
            downloads: 12,
            collection: ['americana'],
          },
        ],
        total_found: 1,
        page: 1,
        rows: 50,
      };
      const [block] = iaSearchItems.format!(output) as [{ text: string }];
      expect(block.text).toBe(
        '**1 total results** — Page 1 (1 shown, 50 per page)\n\n## Afganistan\n**Identifier:** 00hamigoog\n**Creator:** Berezovskīĭ, V.\n**Date:** 1908\n**Downloads:** 12\n**Collection:** americana\n',
      );
    });

    it('renders publicdate after the date, inline as a string and one item per value as a list', () => {
      const output = {
        items: [
          {
            identifier: 'prideprejudice00aust',
            date: '1894-01-01T00:00:00Z',
            publicdate: '2007-07-26T11:49:20Z',
            downloads: 5,
          },
          {
            identifier: 'two-public-dates',
            publicdate: ['2012-08-02T21:50:12Z', '2012-08-02T23:04:20Z'],
          },
        ],
        total_found: 2,
        page: 1,
        rows: 50,
      };
      expect(() => iaSearchItems.output.parse(output)).not.toThrow();
      const [block] = iaSearchItems.format!(output) as [{ text: string }];
      expect(block.text).toBe(
        '**2 total results** — Page 1 (2 shown, 50 per page)\n\n## prideprejudice00aust\n**Identifier:** prideprejudice00aust\n**Date:** 1894-01-01T00:00:00Z\n**Public Date:** 2007-07-26T11:49:20Z\n**Downloads:** 5\n\n## two-public-dates\n**Identifier:** two-public-dates\n**Public Date:**\n\n- 2012-08-02T21:50:12Z\n- 2012-08-02T23:04:20Z\n',
      );
    });
  });
});
