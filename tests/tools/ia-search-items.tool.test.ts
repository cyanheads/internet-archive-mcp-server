/**
 * @fileoverview Tests for the ia_search_items tool.
 * @module tests/tools/ia-search-items.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iaSearchItems } from '@/mcp-server/tools/definitions/ia-search-items.tool.js';

vi.mock('@/services/archive-search/archive-search-service.js', () => ({
  getArchiveSearchService: vi.fn(),
}));

import { getArchiveSearchService } from '@/services/archive-search/archive-search-service.js';

const mockService = {
  search: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (getArchiveSearchService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
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
