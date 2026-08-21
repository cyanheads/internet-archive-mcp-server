/**
 * @fileoverview Tool-contract integration coverage for ia_get_item.
 * @module tests/integration/ia-get-item-contract.int.test
 */

import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/archive-metadata/archive-metadata-service.js', () => ({
  getArchiveMetadataService: vi.fn(),
}));

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import { getArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

const mockService = {
  getItem: vi.fn(async (identifier: string) => {
    if (identifier === 'missing-item-xyz') {
      throw notFound(`Item "${identifier}" not found in the Internet Archive.`, {
        reason: 'item_not_found',
        identifier,
      });
    }
    return {
      metadata: { identifier, title: 'Pride and Prejudice', mediatype: 'texts' },
      files: [
        {
          name: 'pg1342.txt',
          format: 'Plain Text',
          size: '700000',
          downloadUrl: `https://archive.org/download/${identifier}/pg1342.txt`,
        },
      ],
    };
  }),
};

beforeEach(() => {
  (getArchiveMetadataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

describe('ia_get_item contract', () => {
  it('mock resolves a found item and rejects an unknown one', async () => {
    await expect(mockService.getItem('pg1342')).resolves.toMatchObject({
      metadata: { identifier: 'pg1342' },
    });
    await expect(mockService.getItem('missing-item-xyz')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'item_not_found' },
    });
  });
});

toolContractSuite(iaGetItem, {
  success: [
    {
      name: 'validates, invokes, and formats a successful call',
      input: { identifier: 'pg1342' },
      expected: { identifier: 'pg1342', file_count: 1 },
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
