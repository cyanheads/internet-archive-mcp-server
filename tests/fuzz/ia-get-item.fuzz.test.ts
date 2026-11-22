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

/** 1,150 files — past the 500-file cap, so an over-cap max_files withholds some. */
const largeManifest = Array.from({ length: 1_150 }, (_, i) => {
  const name = `big_${String(i).padStart(4, '0')}`;
  return { name, downloadUrl: `https://archive.org/download/large/${name}`, format: 'JPEG Thumb' };
});

/** Files per call; a larger max_files is served at this cap. */
const CAP = 500;

const mockService = {
  getItem: vi.fn(async (identifier: string) => ({
    metadata: { identifier, title: 'Fuzz Fixture' },
    files: identifier === 'large' ? largeManifest : manifest,
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

/**
 * Inline Markdown as a CommonMark parse reads it back, for the constructs an escaped value
 * holds: a backslash escape (`\*` is `*`), a hard line break (a backslash ending a line),
 * and a numeric character reference (`&#32;`, `&#x20;`), an invalid code point as U+FFFD.
 */
const readInline = (markdown: string): string =>
  markdown.replace(
    /\\([!-/:-@[-`{-~\n])|&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));/g,
    (_match, escaped?: string, decimal?: string, hex?: string) => {
      if (escaped !== undefined) return escaped;
      const point = decimal === undefined ? Number.parseInt(hex ?? '', 16) : Number(decimal);
      const valid = point !== 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff);
      return String.fromCodePoint(valid ? point : 0xfffd);
    },
  );

/**
 * Each file's details as content[] reads back: the nested `**Title:**`, `**Track:**`, and
 * `**Length:**` items under its `- **name**` line, in order, as `[key, value]` pairs, each
 * value its item's text, continuation lines included, read by `readInline`.
 */
const renderedDetails = (r: ToolResult): [string, string][][] => {
  const files: [string, string][][] = [];
  let item: { key: string; lines: string[] } | undefined;
  const close = () => {
    if (item) files.at(-1)?.push([item.key, readInline(item.lines.join('\n'))]);
    item = undefined;
  };
  const text = r.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  for (const line of text.split('\n')) {
    const detail = /^ {2}- \*\*(Title|Track|Length):\*\* (.*)$/s.exec(line);
    if (line.startsWith('- **')) {
      close();
      files.push([]);
    } else if (detail) {
      close();
      item = { key: (detail[1] as string).toLowerCase(), lines: [detail[2] as string] };
    } else if (item) {
      item.lines.push(line);
    }
  }
  close();
  return files;
};

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
      fc.oneof(fc.integer({ min: 1, max: CAP }), fc.integer({ min: CAP + 1, max: 300_000 })),
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
        const expected = matched
          .slice(file_offset, file_offset + Math.min(max_files, CAP))
          .map((f) => f.name);
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

it('keeps each file on its own line whatever its title, track, and length hold, on both surfaces', async () => {
  const text = fc.oneof(
    fc.string({ unit: 'binary', minLength: 1, maxLength: 40 }),
    fc.constantFrom(
      'a, b',
      'x\n- **forged.mp3**: y',
      '\r\n# h',
      '  - **Title:** z',
      '1. a\n\n2. b',
    ),
  );
  const details = fc.record({ title: text, track: text, length: text }, { requiredKeys: [] });
  await fc.assert(
    fc.asyncProperty(fc.array(details, { minLength: 1, maxLength: 8 }), async (entries) => {
      const files = entries.map((d, i) => ({
        name: `track_${i}.mp3`,
        downloadUrl: `https://archive.org/download/audio/track_${i}.mp3`,
        format: 'VBR MP3',
        ...d,
      }));
      mockService.getItem.mockResolvedValueOnce({ metadata: { identifier: 'audio' }, files });

      const result = await runToolContract(iaGetItem, { identifier: 'audio' });

      const names = files.map((f) => f.name);
      expect(result.isError).toBeFalsy();
      expect(structuredNames(result)).toEqual(names);
      expect(renderedNames(result)).toEqual(names);
      const sc = (result.structuredContent as { files: Record<string, unknown>[] }).files;
      expect(sc.map(({ title, track, length }) => ({ title, track, length }))).toEqual(
        entries.map(({ title, track, length }) => ({ title, track, length })),
      );
      // Each detail reads back from content[] in render order; CommonMark reads CR and CRLF as LF.
      expect(renderedDetails(result)).toEqual(
        entries.map((d) =>
          (['title', 'track', 'length'] as const).flatMap((key) => {
            const value = d[key];
            return value === undefined ? [] : [[key, value.replace(/\r\n?/g, '\n')]];
          }),
        ),
      );
    }),
    { numRuns: 150, seed: 20_261_122 },
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

it('walks a manifest past the cap by the advertised next offset under any max_files', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(fc.integer({ min: 1, max: CAP }), fc.integer({ min: CAP + 1, max: 300_000 })),
      fc.integer({ min: 0, max: 1_200 }),
      async (max_files, start) => {
        const collected: string[] = [];
        let offset = start;
        for (let pages = 0; pages < 1_200; pages++) {
          const result = await runToolContract(iaGetItem, {
            identifier: 'large',
            max_files,
            file_offset: offset,
          });
          const page = structuredNames(result);
          const sc = result.structuredContent as {
            truncated?: boolean;
            cap?: number;
            shown?: number;
            notice?: string;
          };
          expect(page.length).toBeLessThanOrEqual(CAP);
          collected.push(...page);
          if (!sc.truncated) break;
          expect(sc.cap).toBe(Math.min(max_files, CAP));
          expect(sc.shown).toBe(page.length);
          offset = Number(/file_offset: (\d+)/.exec(sc.notice ?? '')?.[1]);
        }

        expect(collected).toEqual(largeManifest.slice(start).map((f) => f.name));
      },
    ),
    { numRuns: 40, seed: 20_261_012 },
  );
});
