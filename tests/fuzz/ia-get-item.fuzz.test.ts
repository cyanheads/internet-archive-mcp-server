/**
 * @fileoverview Property-based fuzz coverage for the ia_get_item tool — adversarial
 * inputs, plus paging/format-filter invariants over a multi-format manifest.
 * @module tests/fuzz/ia-get-item.fuzz.test
 */

import fc from 'fast-check';
import { expect, it, vi } from 'vitest';

vi.mock('@/services/archive-metadata/archive-metadata-service.js', () => ({
  getArchiveMetadataService: vi.fn(),
}));

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import { getArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

const FORMATS = ['JPEG Thumb', 'DjVuTXT', 'Text PDF', 'VBR MP3', 'Metadata'];

/** 175 files spread unevenly across five formats, two of them with no format at all. */
const manifest = Array.from({ length: 175 }, (_, i) => {
  const name = `file_${String(i).padStart(3, '0')}`;
  const format = i % 88 === 87 ? undefined : FORMATS[(i * i) % FORMATS.length];
  return {
    name,
    downloadUrl: `https://archive.org/download/fixture/${name}`,
    ...(format ? { format } : {}),
  };
});

const mockService = {
  getItem: vi.fn(async (identifier: string) => ({
    metadata: { identifier, title: 'Fuzz Fixture' },
    files: manifest,
  })),
};

(getArchiveMetadataService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

const structuredNames = (r: ToolResult): string[] =>
  (r.structuredContent as { files: { name: string }[] }).files.map((f) => f.name);

const renderedNames = (r: ToolResult): string[] =>
  r.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .flatMap((b) => [...b.text.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1] as string));

/** Format filter values: none, exact, upper-cased, padded lower-case, and a miss. */
const formatArb = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom(...FORMATS),
  fc.constantFrom(...FORMATS).map((f) => f.toUpperCase()),
  fc.constantFrom(...FORMATS).map((f) => ` ${f.toLowerCase()} `),
  fc.constant('Nonexistent Format'),
);

const expectedMatches = (format: string | undefined) => {
  const wanted = format?.trim().toLowerCase();
  return wanted ? manifest.filter((f) => f.format?.toLowerCase() === wanted) : manifest;
};

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

it('returns exactly the requested slice of the filtered manifest on both surfaces', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 500 }),
      fc.integer({ min: 0, max: 220 }),
      formatArb,
      async (max_files, file_offset, format) => {
        const result = await runToolContract(iaGetItem, {
          identifier: 'fixture',
          max_files,
          file_offset,
          ...(format === undefined ? {} : { format }),
        });
        const matched = expectedMatches(format);
        const expected = matched.slice(file_offset, file_offset + max_files).map((f) => f.name);
        const sc = result.structuredContent as Record<string, unknown>;

        expect(result.isError).toBeFalsy();
        expect(structuredNames(result)).toEqual(expected);
        expect(renderedNames(result)).toEqual(expected);
        expect(sc.file_count).toBe(manifest.length);
        expect(sc.truncated === true).toBe(file_offset + expected.length < matched.length);
        expect(sc.totalCount).toBe(format === undefined ? undefined : matched.length);
      },
    ),
    { numRuns: 150, seed: 20_260_924 },
  );
});

it('walks every page by the advertised next offset and reassembles the filtered manifest', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 80 }), formatArb, async (max_files, format) => {
      const collected: string[] = [];
      let offset = 0;
      for (let pages = 0; pages < 200; pages++) {
        const result = await runToolContract(iaGetItem, {
          identifier: 'fixture',
          max_files,
          file_offset: offset,
          ...(format === undefined ? {} : { format }),
        });
        collected.push(...structuredNames(result));
        const sc = result.structuredContent as { truncated?: boolean; notice?: string };
        if (!sc.truncated) break;
        const next = /file_offset: (\d+)/.exec(sc.notice ?? '')?.[1];
        expect(next).toBeDefined();
        offset = Number(next);
      }

      expect(collected).toEqual(expectedMatches(format).map((f) => f.name));
    }),
    { numRuns: 40, seed: 20_260_925 },
  );
});
