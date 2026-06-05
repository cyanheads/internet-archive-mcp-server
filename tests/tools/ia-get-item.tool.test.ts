/**
 * @fileoverview Tests for the ia_get_item tool.
 * @module tests/tools/ia-get-item.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';

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
});
