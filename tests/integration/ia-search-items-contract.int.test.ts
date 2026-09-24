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
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

/** The Solr `q` of each Advanced Search request made. */
const solrQueries = () =>
  http.calls
    .filter((c) => isSearch(c.request))
    .map((c) => new URL(c.request.url).searchParams.get('q'));

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
    expect(notice).toContain('Page 5 is past the last page');
    expect(notice).toContain('page 3');
    expect(notice).not.toContain('No items matched');
    expect(contentText(result)).toContain('Page 5 is past the last page');
  });
});
