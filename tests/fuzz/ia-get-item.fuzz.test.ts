/**
 * @fileoverview Property-based fuzz coverage for the ia_get_item tool.
 * @module tests/fuzz/ia-get-item.fuzz.test
 */

import { expect, it, vi } from 'vitest';

vi.mock('@/services/archive-metadata/archive-metadata-service.js', () => ({
  getArchiveMetadataService: vi.fn(),
}));

import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import { getArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

const mockService = {
  getItem: vi.fn(async (identifier: string) => ({
    metadata: { identifier, title: 'Fuzz Fixture' },
    files: [
      {
        name: 'file.txt',
        format: 'Plain Text',
        downloadUrl: `https://archive.org/download/${identifier}/file.txt`,
      },
    ],
  })),
};

(getArchiveMetadataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);

it('keeps ia_get_item safe across generated and adversarial inputs', async () => {
  const report = await fuzzTool(iaGetItem, {
    numRuns: 50,
    numAdversarial: 30,
    seed: 20_260_821,
  });

  expect(report.crashes).toHaveLength(0);
  expect(report.leaks).toHaveLength(0);
  expect(report.prototypePollution).toBe(false);
});
