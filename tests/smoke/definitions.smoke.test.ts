/**
 * @fileoverview Smoke coverage for every definition shipped by this server.
 * @module tests/smoke/definitions.smoke.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';
import { getArchiveSearchService } from '@/services/archive-search/archive-search-service.js';
import { getWaybackService } from '@/services/wayback/wayback-service.js';

vi.mock('@/services/wayback/wayback-service.js', () => ({
  getWaybackService: vi.fn(),
}));
vi.mock('@/services/archive-search/archive-search-service.js', () => ({
  getArchiveSearchService: vi.fn(),
}));
vi.mock('@/services/archive-metadata/archive-metadata-service.js', () => ({
  getArchiveMetadataService: vi.fn(),
}));

import { iaItemResource } from '@/mcp-server/resources/definitions/ia-item.resource.js';
import { iaFindSnapshots } from '@/mcp-server/tools/definitions/ia-find-snapshots.tool.js';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import { iaGetSnapshot } from '@/mcp-server/tools/definitions/ia-get-snapshot.tool.js';
import { iaGetText } from '@/mcp-server/tools/definitions/ia-get-text.tool.js';
import { iaSearchItems } from '@/mcp-server/tools/definitions/ia-search-items.tool.js';

const mockWayback = {
  findClosest: vi.fn(),
  buildReplayUrl: vi.fn(),
  fetchContent: vi.fn(),
};
const mockSearch = {
  search: vi.fn(),
};
const mockMetadata = {
  getItem: vi.fn(),
  getTextContent: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (getWaybackService as ReturnType<typeof vi.fn>).mockReturnValue(mockWayback);
  (getArchiveSearchService as ReturnType<typeof vi.fn>).mockReturnValue(mockSearch);
  (getArchiveMetadataService as ReturnType<typeof vi.fn>).mockReturnValue(mockMetadata);
});

describe('definition smoke test', () => {
  it('executes ia_find_snapshots in closest mode', async () => {
    mockWayback.findClosest.mockResolvedValue({
      timestamp: '20200101000000',
      snapshotUrl: 'https://web.archive.org/web/20200101000000/https://example.com',
      status: '200',
    });

    const ctx = createMockContext({ errors: iaFindSnapshots.errors });
    const result = await iaFindSnapshots.handler(
      iaFindSnapshots.input.parse({
        url: 'https://example.com',
        mode: 'closest',
        timestamp: '20200101',
      }),
      ctx,
    );

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.timestamp).toBe('20200101000000');
  });

  it('executes ia_get_snapshot via the exact-timestamp direct path', async () => {
    const replayUrl = 'https://web.archive.org/web/20200101120000/https://example.com';
    mockWayback.buildReplayUrl.mockReturnValue(replayUrl);
    mockWayback.fetchContent.mockResolvedValue({ text: 'archived page text', replayUrl });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const result = await iaGetSnapshot.handler(
      iaGetSnapshot.input.parse({ url: 'https://example.com', timestamp: '20200101120000' }),
      ctx,
    );

    expect(result.text).toBe('archived page text');
    expect(result.replay_url).toBe(replayUrl);
    expect(result.resolved_timestamp).toBe('20200101120000');
  });

  it('executes ia_search_items', async () => {
    mockSearch.search.mockResolvedValue({
      items: [{ identifier: 'pg1342', title: 'Pride and Prejudice', mediatype: 'texts' }],
      totalFound: 1,
      page: 1,
      rows: 50,
    });

    const ctx = createMockContext();
    const result = await iaSearchItems.handler(
      iaSearchItems.input.parse({ query: 'pride and prejudice' }),
      ctx,
    );

    expect(result.total_found).toBe(1);
    expect(result.items[0]?.identifier).toBe('pg1342');
  });

  it('executes ia_get_item', async () => {
    mockMetadata.getItem.mockResolvedValue({
      metadata: { identifier: 'pg1342', title: 'Pride and Prejudice', mediatype: 'texts' },
      files: [
        {
          name: 'pg1342_djvu.xml',
          format: 'DjVuTXT',
          downloadUrl: 'https://archive.org/download/pg1342/pg1342_djvu.xml',
        },
        {
          name: 'pg1342.txt',
          format: 'Plain Text',
          downloadUrl: 'https://archive.org/download/pg1342/pg1342.txt',
        },
      ],
    });

    const ctx = createMockContext({ errors: iaGetItem.errors });
    const result = await iaGetItem.handler(iaGetItem.input.parse({ identifier: 'pg1342' }), ctx);

    expect(result.identifier).toBe('pg1342');
    expect(result.file_count).toBe(2);
  });

  it('executes ia_get_text', async () => {
    mockMetadata.getTextContent.mockResolvedValue({
      text: 'It is a truth universally acknowledged',
      totalChars: 680_000,
      charOffset: 0,
      maxChars: 50_000,
      sourceFile: 'pg1342.txt',
    });

    const ctx = createMockContext({ errors: iaGetText.errors });
    const result = await iaGetText.handler(iaGetText.input.parse({ identifier: 'pg1342' }), ctx);

    expect(result.has_more).toBe(true);
    expect(result.source_file).toBe('pg1342.txt');
  });

  it('executes the ia://item/{identifier} resource', async () => {
    mockMetadata.getItem.mockResolvedValue({
      metadata: { identifier: 'pg1342', title: 'Pride and Prejudice', mediatype: 'texts' },
      files: [
        {
          name: 'pg1342.txt',
          format: 'Plain Text',
          downloadUrl: 'https://archive.org/download/pg1342/pg1342.txt',
        },
      ],
    });

    const ctx = createMockContext({ errors: iaItemResource.errors });
    const result = await iaItemResource.handler(
      iaItemResource.params!.parse({ identifier: 'pg1342' }),
      ctx,
    );

    expect(result.identifier).toBe('pg1342');
    expect(result.file_count).toBe(1);
  });
});
