/**
 * @fileoverview Tool-contract integration coverage for ia_get_item — the tool runs
 * against the real ArchiveMetadataService with only the upstream HTTP boundary
 * stubbed, so metadata mapping, paging, and the service-thrown error envelope are
 * exercised end to end.
 * @module tests/integration/ia-get-item-contract.int.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import { initArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

const METADATA = 'https://archive.org/metadata';

/** 297 files: one DjVuTXT at index 134, the rest JPEG thumbnails. */
const bigFiles = Array.from({ length: 297 }, (_, i) =>
  i === 134
    ? { name: 'big_djvu.txt', format: 'DjVuTXT', size: '812345' }
    : { name: `thumb_${String(i).padStart(3, '0')}.jpg`, format: 'JPEG Thumb', size: '4096' },
);

/** Unmatched requests throw — no test in this file reaches the network. */
const http = createFetchMock([
  { match: `${METADATA}/missing-item-xyz`, respond: Response.json({}) },
  {
    match: `${METADATA}/protestant-review_1938-01_15_1`,
    respond: Response.json({
      metadata: {
        identifier: 'protestant-review_1938-01_15_1',
        title: 'Protestant review 1938-01',
        mediatype: 'texts',
        language: ['German', 'English', 'French'],
      },
      files: [{ name: 'review_djvu.txt', format: 'DjVuTXT' }],
    }),
  },
  {
    match: `${METADATA}/big`,
    respond: Response.json({ metadata: { title: 'Big scanned item' }, files: bigFiles }),
  },
]);

beforeAll(() => {
  initArchiveMetadataService(
    { mcpServerVersion: '0.0.0-test' } as AppConfig,
    createInMemoryStorage(),
  );
  http.install();
});

afterAll(() => {
  http.restore();
});

const contentText = (result: Awaited<ReturnType<typeof runToolContract>>): string =>
  result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

toolContractSuite(iaGetItem, {
  success: [
    {
      name: 'returns an array-valued language through output validation',
      input: { identifier: 'protestant-review_1938-01_15_1' },
      expected: {
        identifier: 'protestant-review_1938-01_15_1',
        language: ['German', 'English', 'French'],
        file_count: 1,
      },
      assert: (result) => {
        expect(contentText(result)).toContain('**Language:** German, English, French');
      },
    },
    {
      name: 'pages a large manifest and discloses the cap in the enrichment trailer',
      input: { identifier: 'big' },
      expected: { file_count: 297 },
      assert: (result) => {
        const sc = result.structuredContent as { files: unknown[]; truncated?: boolean };
        expect(sc.files).toHaveLength(50);
        expect(sc.truncated).toBe(true);
        expect(contentText(result)).toContain('file_offset: 50');
      },
    },
    {
      name: 'filters to one format across the whole manifest',
      input: { identifier: 'big', format: 'djvutxt' },
      expected: {
        file_count: 297,
        files: [
          {
            name: 'big_djvu.txt',
            format: 'DjVuTXT',
            size: '812345',
            download_url: 'https://archive.org/download/big/big_djvu.txt',
          },
        ],
      },
      assert: (result) => {
        expect((result.structuredContent as { totalCount?: number }).totalCount).toBe(1);
      },
    },
  ],
  errors: [
    {
      name: 'returns the declared dual-surface error envelope for an unknown identifier',
      input: { identifier: 'missing-item-xyz' },
      code: JsonRpcErrorCode.NotFound,
      reason: 'item_not_found',
    },
  ],
});

describe('ia_get_item service-thrown error envelope', () => {
  it('carries the declared recovery hint on both surfaces', async () => {
    const hint = iaGetItem.errors?.find((e) => e.reason === 'item_not_found')?.recovery;
    const result = await runToolContract(iaGetItem, { identifier: 'missing-item-xyz' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'item_not_found', recovery: { hint } },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${hint}`);
  });
});
