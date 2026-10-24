/**
 * @fileoverview Tool-contract integration coverage for ia_search_items — the tool runs
 * against the real ArchiveSearchService with only the Advanced Search HTTP boundary
 * stubbed, so input validation, mediatype resolution, the Solr query the service
 * builds, and the empty-result notice are exercised end to end on both surfaces.
 * @module tests/integration/ia-search-items-contract.int.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  type FetchMockResponder,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { iaSearchItems } from '@/mcp-server/tools/definitions/ia-search-items.tool.js';
import { initArchiveSearchService } from '@/services/archive-search/archive-search-service.js';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Unmatched requests throw — no test in this file reaches the network. */
const http = createFetchMock();

const isSearch = (r: Request) => r.url.startsWith('https://archive.org/advancedsearch.php?');

/** Answers every Advanced Search request with this page. */
const routeSearch = (numFound: number, docs: unknown[] = []) =>
  http.route({
    match: isSearch,
    respond: () => Response.json({ response: { numFound, start: 0, docs } }),
  });

/** Answers every Advanced Search request with `respond`. */
const routeSearchWith = (respond: FetchMockResponder) => http.route({ match: isSearch, respond });

/** Advanced Search error bodies exactly as archive.org sent them (HTTP 200, no `response` key). */
const UPSTREAM_ERRORS = {
  deepPaging:
    '[DEEP_PAGING] Requested results would exceed the deep paging limit for this service, 10000 results; scraping is supported through the Scraping API, see https://archive.org/help/aboutsearch.htm  You may request any number of results at one time if you do NOT specify any page. For best results, do NOT specify any sort.',
  unclosedGroup: 'a structure was opened but not closed (group open at position 7)',
  bareNot:
    'New and legacy rewrite both failed with errors: a prefix appears at an unexpected position; unknown error',
  unsupportedSort: '[UNSUPPORTED_SORT] Cannot sort with specified field (nosuchfield)',
  unescapedUrl: '[MALFORMED_QUERY] Invalid query (query contains an unescaped URL)',
  tooLong: '[UNSUPPORTED_VALUE] A requested parameter has an inappropriate value',
  backend: '[BACKEND_ERROR] Invalid or no response from Elasticsearch',
};

/** Upstream text as the service relays it: whitespace runs collapsed to one space. */
const relayed = (upstream: string) => upstream.replace(/\s+/g, ' ');

/** A responder that never answers until the request's signal aborts. */
const hang: FetchMockResponder = (request) =>
  new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason));
  });

/** Headers arrive with `head` as the first body bytes; the rest never comes until the request's signal aborts. */
const stall =
  (head: string): FetchMockResponder =>
  (request) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(head));
          request.signal.addEventListener('abort', () => controller.error(request.signal.reason));
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );

/** A refused connection, as the runtime's `fetch` rejects with it. */
const refused: FetchMockResponder = () =>
  Promise.reject(
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
        code: 'ECONNREFUSED',
      }),
    }),
  );

/** Headers and `head` arrive, then the connection drops, as undici rejects the body read. */
const dropped =
  (head: string): FetchMockResponder =>
  () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(head));
          queueMicrotask(() => controller.error(new TypeError('terminated')));
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );

const errorBody = (message: string) => () => Response.json({ error: message });

/** The `rows` and `page` of each Advanced Search request made. */
const sentPaging = () =>
  http.calls
    .filter((c) => isSearch(c.request))
    .map((c) => {
      const params = new URL(c.request.url).searchParams;
      return { rows: params.get('rows'), page: params.get('page') };
    });

/** The throw-site hint an Advanced Search outage carries in place of the declared query-text advice. */
const OUTAGE_HINT = 'Advanced Search is down or unreachable; call again in a few minutes.';

/** A declared reason's recovery text. */
const hint = (reason: string) => {
  const entry = iaSearchItems.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`contract declares no ${reason}`);
  return entry.recovery;
};

/** Runs the tool under fake timers so the real retry loop's backoff elapses instantly. */
const runWithRetries = async (input: Record<string, unknown>): Promise<ToolResult> => {
  vi.useFakeTimers();
  const pending = runToolContract(iaSearchItems, input);
  await vi.runAllTimersAsync();
  return pending;
};

/** The Solr `q` of each Advanced Search request made. */
const solrQueries = () =>
  http.calls
    .filter((c) => isSearch(c.request))
    .map((c) => new URL(c.request.url).searchParams.get('q'));

/** The `sort[]` values of each Advanced Search request made. */
const sentSorts = () =>
  http.calls
    .filter((c) => isSearch(c.request))
    .map((c) => new URL(c.request.url).searchParams.getAll('sort[]'));

const contentText = (result: ToolResult): string =>
  result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

const errorOf = (result: ToolResult) =>
  (result.structuredContent as { error: { code: number; data: { reason: string } } }).error;

beforeAll(() => {
  initArchiveSearchService(
    { mcpServerVersion: '0.0.0-test' } as AppConfig,
    createInMemoryStorage(),
  );
  http.install();
});

afterAll(() => {
  http.restore();
});

beforeEach(() => {
  http.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ia_search_items input validation', () => {
  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('rejects the %s query before any Advanced Search request', async (_label, query) => {
    routeSearch(0);

    const result = await runToolContract(iaSearchItems, { query });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(contentText(result)).not.toContain('empty_query');
    expect(http.calls).toHaveLength(0);
  });

  it('searches the trimmed query with the canonical mediatype', async () => {
    routeSearch(1, [{ identifier: 'tesla-coil', mediatype: 'texts' }]);

    const result = await runToolContract(iaSearchItems, { query: ' tesla ', mediatype: ' Texts ' });

    expect(result.isError).toBeFalsy();
    expect(solrQueries()).toEqual(['tesla AND mediatype:"texts"']);
  });

  it('rejects an unknown mediatype before any Advanced Search request', async () => {
    routeSearch(0);

    const result = await runToolContract(iaSearchItems, {
      query: 'tesla',
      mediatype: 'videogames',
    });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_mediatype' },
    });
    expect(contentText(result)).toMatch(/^Recovery: .*texts.*etree.*account/m);
    expect(http.calls).toHaveLength(0);
  });

  it('sends no mediatype clause for a blank mediatype', async () => {
    routeSearch(3, [{ identifier: 'a' }]);

    const result = await runToolContract(iaSearchItems, { query: 'tesla', mediatype: '  ' });

    expect(result.isError).toBeFalsy();
    expect(solrQueries()).toEqual(['tesla']);
  });

  it('searches a 2,047-character query, the longest Advanced Search accepts', async () => {
    routeSearch(0);
    const query = 'a'.repeat(2_047);

    const result = await runToolContract(iaSearchItems, { query });

    expect(result.isError).toBeFalsy();
    expect(solrQueries()).toEqual([query]);
  });

  it('rejects a 2,048-character query at the schema, naming the limit, with no request', async () => {
    routeSearch(0);

    const result = await runToolContract(iaSearchItems, { query: 'a'.repeat(2_048) });

    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(contentText(result)).toContain('2,047 characters');
    expect(http.calls).toHaveLength(0);
  });
});

describe('ia_search_items Gregorian date bounds', () => {
  it.each([
    [{ date_from: '1950', date_to: '1959' }, '1950-01-01 TO 1959-12-31'],
    [{ date_to: '2000-02' }, '* TO 2000-02-29'],
    [{ date_to: '1900-02' }, '* TO 1900-02-28'],
    [{ date_from: ' 2024-02 ' }, '2024-02-01 TO *'],
    [{ date_from: '0001', date_to: '9999' }, '0001-01-01 TO 9999-12-31'],
    [{ date_from: '0000-02-29' }, '0000-02-29 TO *'],
  ])('expands partial bounds %j', async (bounds, range) => {
    routeSearch(1, [{ identifier: 'date-match' }]);
    const result = await runToolContract(iaSearchItems, { query: 'tesla', ...bounds });
    expect(result.isError).toBeFalsy();
    expect(solrQueries()).toEqual([`tesla AND date:[${range}]`]);
    expect(result.structuredContent).toMatchObject({ items: [{ identifier: 'date-match' }] });
    expect(contentText(result)).toContain('date-match');
  });

  it.each([
    'yesterday',
    '2024-00',
    '2024-13',
    '2024-02-30',
    '1900-02-29',
    '2024-04-31',
    '2024-1',
    '2024-01-01T00:00:00Z',
  ])('rejects impossible or unsupported date %s before HTTP on both surfaces', async (value) => {
    http.route({
      match: () => true,
      respond: () => Response.json({ response: { numFound: 0, docs: [] } }),
    });
    for (const field of ['date_from', 'date_to']) {
      expect(iaSearchItems.input.safeParse({ query: 'tesla', [field]: value }).success).toBe(true);
      const result = await runToolContract(iaSearchItems, { query: 'tesla', [field]: value });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'invalid_date_range', field },
        },
      });
      expect(contentText(result)).toContain(field);
      expect(contentText(result)).toContain('YYYY-MM-DD');
      expect(contentText(result)).toContain('Recovery:');
    }
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    [{ date_from: ' 2024-02-29 ', date_to: '2023-01-01' }, 'date:[2024-02-29 TO 2023-01-01]'],
    [{ date_from: ' ', date_to: '' }, undefined],
    [{}, undefined],
  ])('preserves full dates, reversed ranges and absent bounds: %j', async (bounds, clause) => {
    routeSearch(0);
    const result = await runToolContract(iaSearchItems, { query: 'tesla', ...bounds });
    expect(result.isError).toBeFalsy();
    expect(solrQueries()).toEqual([clause ? `tesla AND ${clause}` : 'tesla']);
    expect(result.structuredContent).toMatchObject({ items: [], total_found: 0 });
    expect(contentText(result)).toContain('No items matched');
  });
});

describe('ia_search_items sort order sent upstream', () => {
  it.each([
    ['the default', {}, ['downloads desc', 'identifier asc']],
    ['date asc', { sort: 'date asc' }, ['date asc', 'identifier asc']],
    ['random', { sort: 'random' }, ['random']],
    ['random asc', { sort: ' random asc ' }, ['random asc']],
  ])('sends the sort[] values for %s', async (_label, sort, sorts) => {
    routeSearch(1, [{ identifier: 'a' }]);

    const result = await runToolContract(iaSearchItems, { query: 'tesla', ...sort });

    expect(result.isError).toBeFalsy();
    expect(sentSorts()).toEqual([sorts]);
  });

  it('describes the sortable orders without claiming a relevance sort', () => {
    expect(iaSearchItems.description).not.toMatch(/relevance/i);
    expect(iaSearchItems.input.shape.sort.description).toContain('has no relevance sort');
    expect(iaSearchItems.input.shape.sort.description).toContain('"random"');
  });
});

describe('ia_search_items empty-result notice', () => {
  it('names the canonical mediatype on both surfaces when nothing matched', async () => {
    routeSearch(0);

    const result = await runToolContract(iaSearchItems, {
      query: 'zzznoresultszzzz',
      mediatype: 'book',
    });

    expect(solrQueries()).toEqual(['zzznoresultszzzz AND mediatype:"texts"']);
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('No items matched "zzznoresultszzzz"');
    expect(notice).toContain('mediatype "texts"');
    expect(contentText(result)).toContain('mediatype "texts"');
    expect(contentText(result)).toContain('**0 total results**');
  });

  it('points at the last page when the requested page is past the end', async () => {
    routeSearch(120);

    const result = await runToolContract(iaSearchItems, { query: 'tesla', rows: 50, page: 5 });

    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain('Page 5 is past the last page of 120 results at 50 per page');
    expect(notice).toContain('page 3');
    expect(notice).not.toContain('No items matched');
    expect(contentText(result)).toContain('Page 5 is past the last page');
  });
});

describe('ia_search_items list-valued title and date', () => {
  /** Records as Advanced Search returned them on 2026-10-12. */
  const TUXCAST = {
    identifier: 'TuxCastDE-News-1-vom-23-45-6789',
    mediatype: 'movies',
    title: [...'TuxCastDENew#1vom23.456789'],
    date: [
      '0006-01-01T00:00:00Z',
      '0007-01-01T00:00:00Z',
      '0008-01-01T00:00:00Z',
      '0009-01-01T00:00:00Z',
      '0004-01-01T00:00:00Z',
      '0005-01-01T00:00:00Z',
      '0002-01-01T00:00:00Z',
      '0003-01-01T00:00:00Z',
    ],
  };
  const PIRACY = {
    identifier: 'ArchiveIt-Collection-3226',
    mediatype: 'collection',
    creator: "Seamen's Church Institute of NY & NJ",
    title: 'Piracy',
    date: ['2012-06-26T00:00:00Z', '2012-08-14T00:00:00Z'],
  };
  const PLAIN = { identifier: 'plain', title: 'Plain Title', date: '1998-01-01T00:00:00Z' };

  it('relays list and string values as received on both surfaces', async () => {
    routeSearch(3, [TUXCAST, PIRACY, PLAIN]);

    const result = await runToolContract(iaSearchItems, { query: 'news', sort: 'date asc' });

    expect(result.isError).toBeFalsy();
    const { items } = result.structuredContent as {
      items: { identifier: string; title?: unknown; date?: unknown }[];
    };
    expect(items.map(({ identifier, title, date }) => ({ identifier, title, date }))).toEqual([
      { identifier: TUXCAST.identifier, title: TUXCAST.title, date: TUXCAST.date },
      { identifier: PIRACY.identifier, title: PIRACY.title, date: PIRACY.date },
      { identifier: PLAIN.identifier, title: PLAIN.title, date: PLAIN.date },
    ]);
    expect(() => iaSearchItems.output.parse(result.structuredContent)).not.toThrow();

    const text = contentText(result);
    expect(text).toContain(`## ${TUXCAST.title.join(', ')}`);
    expect(text).toContain(`**Date:** ${TUXCAST.date.join(', ')}`);
    expect(text).toContain(`**Date:** ${PIRACY.date.join(', ')}`);
    expect(text).toContain('## Plain Title');
    expect(text).toContain('**Date:** 1998-01-01T00:00:00Z');
  });
});

describe('ia_search_items collection and creator lists', () => {
  type Item = {
    identifier: string;
    collection?: string | string[];
    creator?: string | string[];
    creator_count?: number;
  };
  const itemsOf = (result: ToolResult) => (result.structuredContent as { items: Item[] }).items;
  const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

  const favorites = (n: number) => Array.from({ length: n }, (_, i) => `fav-account${i}`);
  const authors = (n: number) => Array.from({ length: n }, (_, i) => `Author ${i + 1}`);

  /** `TheVoynichManuscript` on 2026-10-12: three real collections among 3,184 favorites lists. */
  const VOYNICH = {
    identifier: 'TheVoynichManuscript',
    title: 'The Voynich Manuscript',
    mediatype: 'texts',
    collection: [
      'folkscanomy_art',
      'folkscanomy',
      ...favorites(3_184),
      'BooksWithBeautifulIllustrationsAndGraphics',
    ],
  };

  it('drops fav- entries, keeping real collections in upstream order on both surfaces', async () => {
    routeSearch(1, [
      {
        identifier: 'mixed',
        collection: ['fav-a', 'americana', 'fav-b', 'fav-c', 'library_of_congress', 'fav-d'],
      },
    ]);

    const result = await runToolContract(iaSearchItems, { query: 'tesla' });

    expect(itemsOf(result)[0]?.collection).toEqual(['americana', 'library_of_congress']);
    expect(contentText(result)).toContain('**Collection:** americana, library_of_congress');
    expect(contentText(result)).not.toContain('fav-');
  });

  it('serves a heavily favorited record in under 1 KB per surface', async () => {
    routeSearch(1, [VOYNICH]);

    const result = await runToolContract(iaSearchItems, {
      query: 'tesla',
      mediatype: 'texts',
      rows: 1,
    });

    expect(itemsOf(result)[0]?.collection).toEqual([
      'folkscanomy_art',
      'folkscanomy',
      'BooksWithBeautifulIllustrationsAndGraphics',
    ]);
    expect(bytes(JSON.stringify(result.structuredContent))).toBeLessThan(1_024);
    expect(bytes(contentText(result))).toBeLessThan(1_024);
  });

  it.each([
    ['a list of only fav- entries', ['fav-a', 'fav-b']],
    ['a single fav- string', 'fav-a'],
  ])('omits collection for %s', async (_label, collection) => {
    routeSearch(1, [{ identifier: 'only-favorites', collection }]);

    const result = await runToolContract(iaSearchItems, { query: 'tesla' });

    expect(itemsOf(result)[0]).not.toHaveProperty('collection');
    expect(contentText(result)).not.toContain('**Collection:**');
  });

  it.each([
    [409, 10],
    [11, 10],
  ])(
    'keeps the first 10 of %i creators and reports creator_count on both surfaces',
    async (total, kept) => {
      routeSearch(1, [{ identifier: 'arxiv-1402.6728', creator: authors(total) }]);

      const result = await runToolContract(iaSearchItems, {
        query: 'identifier:arxiv-1402.6728',
      });

      const [item] = itemsOf(result);
      expect(item?.creator).toEqual(authors(kept));
      expect(item?.creator_count).toBe(total);
      expect(() => iaSearchItems.output.parse(result.structuredContent)).not.toThrow();
      const text = contentText(result);
      expect(text).toContain(`**Creator:** ${authors(kept).join(', ')}`);
      expect(text).toContain(`${kept} of ${total}`);
      expect(text).toContain('ia_get_item');
      expect(text).not.toContain(`Author ${kept + 1},`);
    },
  );

  it('returns records with no fav- entries and at most 10 creators unchanged', async () => {
    const docs = [
      { identifier: 'ten', creator: authors(10), collection: ['americana'] },
      { identifier: 'single', creator: 'Jane Austen', collection: 'gutenberg' },
      { identifier: 'bare' },
    ];
    routeSearch(3, docs);

    const result = await runToolContract(iaSearchItems, { query: 'tesla' });

    expect(itemsOf(result)).toEqual(docs);
    expect(contentText(result)).not.toContain(' of 10');
  });
});

describe('ia_search_items rows above the 200 cap', () => {
  type Paged = {
    items: { identifier: string }[];
    rows: number;
    truncated?: boolean;
    shown?: number;
    cap?: number;
    notice?: string;
  };
  const docs = (n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => ({ identifier: `item-${from + i}` }));
  const paged = (result: ToolResult) => result.structuredContent as Paged;

  it.each([
    ['omitted', {}],
    ['1', { page: 1 }],
  ])(
    'serves rows 500 at 200 with page %s, disclosing the cap and the next page',
    async (_label, page) => {
      routeSearch(75_700, docs(200));

      const result = await runToolContract(iaSearchItems, { query: 'tesla', rows: 500, ...page });

      expect(result.isError).toBeFalsy();
      expect(sentPaging()).toEqual([{ rows: '200', page: '1' }]);
      const out = paged(result);
      expect(out.items).toHaveLength(200);
      expect(out).toMatchObject({ rows: 200, truncated: true, shown: 200, cap: 200 });
      expect(out.notice).toContain(
        'results 1–200 of 75,700. Request rows: 200, page: 2 for results 201–400.',
      );
      const text = contentText(result);
      expect(text).toContain('rows: 200, page: 2');
      expect(text).toContain('200 per page');
    },
  );

  it('serves the 10,000 ceiling at 200', async () => {
    routeSearch(75_700, docs(200));

    const result = await runToolContract(iaSearchItems, { query: 'tesla', rows: 10_000 });

    expect(sentPaging()).toEqual([{ rows: '200', page: '1' }]);
    expect(paged(result)).toMatchObject({ rows: 200, truncated: true, cap: 200 });
  });

  it('sets no truncation or notice when the cap withheld nothing', async () => {
    routeSearch(150, docs(150));

    const result = await runToolContract(iaSearchItems, { query: 'tesla', rows: 500 });

    const out = paged(result);
    expect(out.items).toHaveLength(150);
    expect(out.rows).toBe(200);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('page: 2');
  });

  it('answers the continuation with the next 200 results', async () => {
    /** Serves the `rows`-sized block the request's `page` addresses, as Advanced Search does. */
    routeSearchWith((request) => {
      const params = new URL(request.url).searchParams;
      const rows = Number(params.get('rows'));
      const page = Number(params.get('page'));
      return Response.json({
        response: { numFound: 75_700, start: 0, docs: docs(rows, (page - 1) * rows + 1) },
      });
    });

    const result = await runToolContract(iaSearchItems, { query: 'tesla', rows: 200, page: 2 });

    expect(sentPaging()).toEqual([{ rows: '200', page: '2' }]);
    const out = paged(result);
    expect(out.items.map((i) => i.identifier)).toEqual(docs(200, 201).map((d) => d.identifier));
    expect(out.rows).toBe(200);
    expect(out).not.toHaveProperty('truncated');
  });

  it.each([2, 50])(
    'rejects rows 500 on page %i as rows_over_cap naming the 200 cap, with no request',
    async (page) => {
      routeSearch(75_700, docs(200));

      const result = await runToolContract(iaSearchItems, { query: 'tesla', rows: 500, page });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining('200'),
          data: { reason: 'rows_over_cap', recovery: { hint: hint('rows_over_cap') } },
        },
      });
      expect(contentText(result)).toContain(`Recovery: ${hint('rows_over_cap')}`);
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each([
    ['above the 10,000 ceiling', 10_001, 'rows: Too big: expected number to be <=10000'],
    ['zero', 0, 'rows: Too small: expected number to be >=1'],
    ['a non-integer', 1.5, 'rows: Invalid input: expected int'],
  ])('rejects rows %s at the schema, with no request', async (_label, rows, named) => {
    routeSearch(75_700, docs(200));

    const result = await runToolContract(iaSearchItems, { query: 'tesla', rows });

    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(contentText(result)).toContain(named);
    expect(http.calls).toHaveLength(0);
  });

  it.each([1, 50, 200])('sends rows %i as requested, with no truncation', async (rows) => {
    routeSearch(75_700, docs(rows));

    const result = await runToolContract(iaSearchItems, { query: 'tesla', rows });

    expect(sentPaging()).toEqual([{ rows: String(rows), page: '1' }]);
    expect(paged(result).rows).toBe(rows);
    expect(paged(result)).not.toHaveProperty('truncated');
  });
});

describe('ia_search_items 10,000-result paging limit', () => {
  it.each([
    [50, 200],
    [200, 50],
    [7, 1428],
  ])('searches rows %i, page %i (page × rows ≤ 10,000) as one request', async (rows, page) => {
    routeSearch(75_700, [{ identifier: 'a' }]);

    const result = await runToolContract(iaSearchItems, { query: 'tesla', rows, page });

    expect(result.isError).toBeFalsy();
    expect(sentPaging()).toEqual([{ rows: String(rows), page: String(page) }]);
  });

  it.each([
    [50, 201, 200],
    [7, 1429, 1428],
    [50, 999, 200],
    [200, 51, 50],
  ])(
    'rejects rows %i, page %i as page_limit_exceeded naming page %i, with no request',
    async (rows, page, lastPage) => {
      routeSearch(75_700, [{ identifier: 'a' }]);

      const result = await runToolContract(iaSearchItems, { query: 'tesla', rows, page });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining(
            `last reachable page at ${rows} per page is ${lastPage}`,
          ),
          data: { reason: 'page_limit_exceeded', recovery: { hint: hint('page_limit_exceeded') } },
        },
      });
      expect(contentText(result)).toContain(
        `last reachable page at ${rows} per page is ${lastPage}`,
      );
      expect(contentText(result)).toContain(`Page ${page} at ${rows} per page ends at result`);
      expect(contentText(result)).toContain(`Recovery: ${hint('page_limit_exceeded')}`);
      expect(http.calls).toHaveLength(0);
    },
  );

  it('states the limit as page × rows ≤ 10,000 on the page field', () => {
    expect(iaSearchItems.input.shape.page.description).toContain('page × rows ≤ 10,000');
  });
});

describe('ia_search_items Advanced Search error bodies', () => {
  it.each([
    ['an unclosed group', { query: 'title:(tesla' }, UPSTREAM_ERRORS.unclosedGroup],
    ['a bare NOT', { query: 'NOT' }, UPSTREAM_ERRORS.bareNot],
    [
      'an unsortable field',
      { query: 'tesla', sort: 'nosuchfield desc' },
      UPSTREAM_ERRORS.unsupportedSort,
    ],
    ['an unquoted URL', { query: 'http://example.com' }, UPSTREAM_ERRORS.unescapedUrl],
    [
      'a query its filters take past 2,047 characters',
      { query: 'a'.repeat(2_040), collection: 'gutenberg' },
      UPSTREAM_ERRORS.tooLong,
    ],
  ])(
    'answers %s as invalid_query after one request, relaying the upstream text',
    async (_label, input, upstream) => {
      routeSearchWith(errorBody(upstream));

      const result = await runWithRetries(input);

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining(upstream),
          data: { reason: 'invalid_query', recovery: { hint: hint('invalid_query') } },
        },
      });
      expect(contentText(result)).toContain(upstream.replaceAll('[', '\\[').replaceAll(']', '\\]'));
      expect(contentText(result)).toContain(`Recovery: ${hint('invalid_query')}`);
      expect(contentText(result)).not.toContain('No items matched');
      expect(http.calls).toHaveLength(1);
    },
  );

  it.each([
    ['[BACKEND_ERROR]', UPSTREAM_ERRORS.backend],
    ['an unrecognized tag', UPSTREAM_ERRORS.deepPaging],
  ])('answers %s as search_unavailable after one request', async (_label, upstream) => {
    routeSearchWith(errorBody(upstream));

    const result = await runWithRetries({ query: 'AND' });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringContaining(relayed(upstream)),
        data: {
          reason: 'search_unavailable',
          retryable: false,
          recovery: { hint: hint('search_unavailable') },
        },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${hint('search_unavailable')}`);
    expect(hint('search_unavailable')).toMatch(/bare operator/);
    expect(JSON.stringify(result.structuredContent)).not.toContain(OUTAGE_HINT);
    expect(contentText(result)).not.toContain(OUTAGE_HINT);
    expect(http.calls).toHaveLength(1);
  });

  it('relays an upstream error with its newlines and whitespace runs collapsed', async () => {
    routeSearchWith(errorBody('a token is\nat an unexpected\r\n\tposition   (7)'));

    const result = await runWithRetries({ query: 'tesla AND' });

    const { message } = errorOf(result) as unknown as { message: string };
    expect(message).toContain('a token is at an unexpected position (7)');
    expect(message).not.toMatch(/[\r\n\t]/);
  });

  it('relays at most 500 characters of an upstream error', async () => {
    const long = `a token is at an unexpected position ${'x'.repeat(2_000)}`;
    routeSearchWith(errorBody(long));

    const result = await runWithRetries({ query: 'tesla AND' });

    const { message } = errorOf(result) as unknown as { message: string };
    expect(message).toContain(long.slice(0, 500));
    expect(message).not.toContain(long.slice(0, 501));
    expect(errorOf(result).data.reason).toBe('invalid_query');
  });

  it('answers a non-string error value as search_unavailable after one request', async () => {
    routeSearchWith(() => Response.json({ error: { code: 7 } }));

    const result = await runWithRetries({ query: 'tesla' });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'search_unavailable', retryable: false },
      },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('names a bare operator and an empty field prefix as causes in the search_unavailable recovery', () => {
    expect(hint('search_unavailable')).toMatch(/bare operator/);
    expect(hint('search_unavailable')).toMatch(/empty field prefix/);
  });

  it('leaves outages out of the declared search_unavailable recovery, which their own hint covers', () => {
    expect(hint('search_unavailable')).not.toMatch(/timeout|network error|5xx|down/);
  });

  it('names the in-word characters that reach [BACKEND_ERROR] and the quoting that clears them', () => {
    const recovery = hint('search_unavailable');
    for (const cause of ['AND AND', 'AT&T', '100%', '1/2', 'title:"AT&T"']) {
      expect(recovery).toContain(cause);
    }
    expect(recovery).not.toMatch(/retry in a few seconds|retry in a minute/);
  });

  it('names an unquoted URL and the 2,047-character limit in the invalid_query recovery', () => {
    expect(hint('invalid_query')).toMatch(/URL in quotes/);
    expect(hint('invalid_query')).toContain('2,047 characters');
  });

  it.each([
    ['an HTML page', () => new Response('<!DOCTYPE html><html><body>Error</body></html>')],
    ['unparseable JSON', () => new Response('{"response": ')],
    ['a body without response', () => Response.json({ responseHeader: { status: 0 } })],
    ['an HTTP 503', () => new Response('Service Unavailable', { status: 503 })],
  ])(
    'surfaces %s as search_unavailable with the outage hint after retrying',
    async (_label, respond) => {
      routeSearchWith(respond);

      const result = await runWithRetries({ query: 'tesla' });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: {
            reason: 'search_unavailable',
            retryAttempts: 4,
            recovery: { hint: OUTAGE_HINT },
          },
        },
      });
      expect(contentText(result)).toContain(`Recovery: ${OUTAGE_HINT}`);
      expect(contentText(result)).not.toContain('bare operator');
      expect(contentText(result)).not.toContain('not retryable');
      expect(http.calls).toHaveLength(4);
    },
  );

  it('answers an HTTP 429 as search_unavailable after one request with a wait hint', async () => {
    routeSearchWith(
      () =>
        new Response('<html><body>429 Too Many Requests</body></html>', {
          status: 429,
          headers: { 'retry-after': '120' },
        }),
    );

    const result = await runWithRetries({ query: 'tesla' });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'search_unavailable',
          status: 429,
          recovery: { hint: expect.stringContaining('wait 120 seconds') },
        },
      },
    });
    expect(errorOf(result).data).not.toHaveProperty('retryable');
    expect(contentText(result)).toContain('wait 120 seconds');
    expect(contentText(result)).not.toContain('not retryable');
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    [
      'an HTTP-date',
      () => new Date(Date.now() + 3_600_000).toUTCString(),
      (v: string) => `wait until ${v}`,
    ],
    ['no', () => undefined, () => 'wait several minutes'],
    ['a fractional', () => '1.5', () => 'wait several minutes'],
    ['a negative', () => '-5', () => 'wait several minutes'],
    ['a past HTTP-date', () => 'Wed, 21 Oct 2015 07:28:00 GMT', () => 'wait several minutes'],
  ])('builds the 429 wait hint from %s Retry-After', async (_label, header, phrase) => {
    const retryAfter = header();
    routeSearchWith(
      () =>
        new Response('rate limited', {
          status: 429,
          ...(retryAfter !== undefined && { headers: { 'retry-after': retryAfter } }),
        }),
    );

    const result = await runWithRetries({ query: 'tesla' });

    expect(contentText(result)).toContain(
      `Advanced Search is rate-limiting requests; ${phrase(retryAfter ?? '')} before retrying.`,
    );
    expect(http.calls).toHaveLength(1);
  });

  it.each([400, 403, 404])(
    'answers an HTTP %i as search_unavailable after one request, without its body',
    async (status) => {
      routeSearchWith(() => new Response('UPSTREAM BODY', { status }));

      const result = await runWithRetries({ query: 'tesla' });

      const refusal = `Advanced Search refused this request with HTTP ${status}, so repeating it unchanged will not help`;
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringContaining(`HTTP ${status}`),
          data: {
            reason: 'search_unavailable',
            status,
            retryable: false,
            recovery: { hint: expect.stringContaining(refusal) },
          },
        },
      });
      expect(contentText(result)).toContain(refusal);
      expect(contentText(result)).not.toContain(OUTAGE_HINT);
      expect(JSON.stringify(result.structuredContent)).not.toContain('UPSTREAM BODY');
      expect(contentText(result)).not.toContain('UPSTREAM BODY');
      expect(http.calls).toHaveLength(1);
    },
  );

  it('recovers when a retried 503 is followed by a page', async () => {
    let attempt = 0;
    routeSearchWith(() =>
      ++attempt === 1
        ? new Response('Service Unavailable', { status: 503 })
        : Response.json({ response: { numFound: 1, start: 0, docs: [{ identifier: 'a' }] } }),
    );

    const result = await runWithRetries({ query: 'tesla' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total_found: 1,
      items: [{ identifier: 'a' }],
    });
    expect(http.calls).toHaveLength(2);
  });

  it('keeps the "No items matched" notice for a response with numFound 0', async () => {
    routeSearch(0);

    const result = await runToolContract(iaSearchItems, { query: 'zzznoresultszzzz' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total_found: 0, items: [] });
    expect((result.structuredContent as { notice?: string }).notice).toContain(
      'No items matched "zzznoresultszzzz"',
    );
    expect(http.calls).toHaveLength(1);
  });
});

describe('ia_search_items timeouts and network errors surface as search_unavailable', () => {
  /** IA_REQUEST_TIMEOUT_MS at its default. */
  const REQUEST_TIMEOUT_MS = 30_000;

  /** Runs the tool under fake timers to completion, reporting the fake time it took. */
  const runTimed = async (input: Record<string, unknown>) => {
    vi.useFakeTimers();
    const start = Date.now();
    const pending = runToolContract(iaSearchItems, input);
    await vi.runAllTimersAsync();
    const result = await pending;
    return { result, elapsedMs: Date.now() - start };
  };

  const expectUnavailable = (result: ToolResult) => {
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'search_unavailable', recovery: { hint: OUTAGE_HINT } },
      },
    });
    expect(errorOf(result).data).not.toHaveProperty('retryable');
    expect(contentText(result)).toContain(`Recovery: ${OUTAGE_HINT}`);
    expect(contentText(result)).not.toContain('bare operator');
    expect(contentText(result)).not.toContain('not retryable');
  };

  it.each([
    ['headers never arrive', hang],
    ['the body stalls', stall('{"response": {"numFound": 75700, "docs": [')],
  ])('answers after one request when %s, within one request timeout', async (_label, respond) => {
    routeSearchWith(respond);

    const { result, elapsedMs } = await runTimed({ query: 'tesla' });

    expectUnavailable(result);
    expect(errorOf(result)).toMatchObject({ message: expect.stringContaining('timed out') });
    expect(http.calls).toHaveLength(1);
    expect(elapsedMs).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
  });

  it.each([
    ['a refused connection', refused],
    ['a connection dropped mid-body', dropped('{"response": {"numFound": 75700, "docs": [')],
  ])('answers %s after four attempts', async (_label, respond) => {
    routeSearchWith(respond);

    const { result } = await runTimed({ query: 'tesla' });

    expectUnavailable(result);
    expect(errorOf(result)).toMatchObject({
      message: expect.stringContaining('network error'),
      data: { retryAttempts: 4 },
    });
    expect(http.calls).toHaveLength(4);
  });

  it('keeps a caller cancellation a cancellation after one request', async () => {
    routeSearchWith(hang);
    const controller = new AbortController();
    const pending = runToolContract(
      iaSearchItems,
      { query: 'tesla' },
      { context: { signal: controller.signal } },
    );

    await vi.waitFor(() => expect(http.calls).toHaveLength(1));
    controller.abort();
    const result = await pending;

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(
      (result.structuredContent as { error: { data?: { reason?: string } } }).error.data?.reason,
    ).toBeUndefined();
    expect(http.calls).toHaveLength(1);
  });

  it('states timeouts and network errors in the search_unavailable when text', () => {
    const entry = iaSearchItems.errors?.find((e) => e.reason === 'search_unavailable');
    expect(entry?.when).toMatch(/timed out/);
    expect(entry?.when).toMatch(/network error/);
  });
});
