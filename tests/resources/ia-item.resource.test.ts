/**
 * @fileoverview Tests for the ia://item/{identifier} resource.
 * @module tests/resources/ia-item.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iaItemResource } from '@/mcp-server/resources/definitions/ia-item.resource.js';

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

describe('iaItemResource', () => {
  it('returns metadata snapshot for a found item', async () => {
    mockService.getItem.mockResolvedValue({
      metadata: {
        identifier: 'pg1342',
        title: 'Pride and Prejudice',
        creator: 'Jane Austen',
        mediatype: 'texts',
        date: '1813',
        description: 'Classic novel.',
        subject: ['fiction', 'romance'],
        collection: ['gutenberg'],
        licenseurl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        language: 'English',
      },
      files: [
        { name: 'pg1342.txt', downloadUrl: 'https://archive.org/download/pg1342/pg1342.txt' },
        { name: 'pg1342.pdf', downloadUrl: 'https://archive.org/download/pg1342/pg1342.pdf' },
      ],
    });

    const ctx = createMockContext({ errors: iaItemResource.errors });
    const params = iaItemResource.params.parse({ identifier: 'pg1342' });
    const result = (await iaItemResource.handler(params, ctx)) as Record<string, unknown>;

    expect(result.identifier).toBe('pg1342');
    expect(result.title).toBe('Pride and Prejudice');
    expect(result.creator).toBe('Jane Austen');
    expect(result.mediatype).toBe('texts');
    expect(result.file_count).toBe(2);
    // Resource should not include the file manifest itself, only file_count
    expect(result.files).toBeUndefined();
  });

  it('returns only identifier and file_count=0 for sparse metadata ({})', async () => {
    mockService.getItem.mockResolvedValue({
      metadata: { identifier: 'sparse-item' },
      files: [],
    });

    const ctx = createMockContext({ errors: iaItemResource.errors });
    const params = iaItemResource.params.parse({ identifier: 'sparse-item' });
    const result = (await iaItemResource.handler(params, ctx)) as Record<string, unknown>;

    expect(result.identifier).toBe('sparse-item');
    expect(result.title).toBeUndefined();
    expect(result.file_count).toBe(0);
  });

  it('throws item_not_found when metadata API returns {} (empty-body = not found)', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.getItem.mockRejectedValue(
      notFound('Item "bad-id" not found in the Internet Archive.', {
        reason: 'item_not_found',
        identifier: 'bad-id',
      }),
    );

    const ctx = createMockContext({ errors: iaItemResource.errors });
    const params = iaItemResource.params.parse({ identifier: 'bad-id' });

    await expect(iaItemResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'item_not_found' },
    });
  });

  describe('list', () => {
    it('returns at least one resource entry with uri and name', async () => {
      const listing = await iaItemResource.list!();
      expect(listing.resources).toBeInstanceOf(Array);
      expect(listing.resources.length).toBeGreaterThan(0);
      for (const r of listing.resources) {
        expect(r).toHaveProperty('uri');
        expect(r).toHaveProperty('name');
      }
    });

    it('lists resources with the ia:// URI scheme', async () => {
      const listing = await iaItemResource.list!();
      expect(listing.resources.every((r) => r.uri.startsWith('ia://'))).toBe(true);
    });
  });
});
