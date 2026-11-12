/**
 * @fileoverview Unit tests for the item-reference reader: which bare identifiers and
 * archive.org URL forms name an item, the file a download, stream, or storage-node URL names,
 * what is a Wayback capture or unrecognized, the `invalid_identifier` errors, and linear time.
 * @module tests/services/item-reference.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import {
  parseItemReference,
  requireItemReference,
} from '@/services/archive-metadata/item-reference.js';
import { cpuMsPerCall } from '../helpers/cpu-time.js';

const STRABO = 'Strabo08Geography17AndIndex';
const VOLUME_2 = 'Strabo 02 Geography 3-5_djvu.txt';
const THUMB = 'CrackedUpNoCC.thumbs/Cracked Up (No Closed Captions)_000001.jpg';

describe('parseItemReference', () => {
  it.each([
    ['a bare identifier', 'prideprejudice00aust'],
    ['an account identifier', '@cyanheads'],
    ['a dotted identifier', 'gov.uscourts.mieb.653252'],
  ])('passes %s through unchanged', (_label, value) => {
    expect(parseItemReference(value)).toEqual({ kind: 'item', identifier: value });
  });

  it.each([
    ['https://archive.org/details/prideprejudice00aust', 'details'],
    ['http://archive.org/details/prideprejudice00aust', 'details'],
    ['archive.org/details/prideprejudice00aust/page/n5/mode/2up', 'details'],
    ['www.archive.org/embed/prideprejudice00aust', 'embed'],
    ['HTTPS://WWW.ARCHIVE.ORG/details/prideprejudice00aust?view=theater#page/n5', 'details'],
    ['https://archive.org/metadata/prideprejudice00aust/files', 'metadata'],
    ['https://archive.org/download/prideprejudice00aust', 'download'],
    ['https://archive.org/download/prideprejudice00aust/', 'download'],
    ['https://archive.org/stream/prideprejudice00aust#page/n5/mode/2up', 'stream'],
  ])('reads %s as the item it names, with no file', (value, route) => {
    expect(parseItemReference(value)).toEqual({
      kind: 'item',
      identifier: 'prideprejudice00aust',
      route,
    });
  });

  it.each([
    [
      'a stream URL',
      'https://archive.org/stream/prideprejudice00aust/prideprejudice00aust_djvu.txt',
      'prideprejudice00aust',
      'stream',
      'prideprejudice00aust_djvu.txt',
    ],
    [
      'a percent-encoded download URL',
      `https://archive.org/download/${STRABO}/Strabo%2002%20Geography%203-5_djvu.txt`,
      STRABO,
      'download',
      VOLUME_2,
    ],
    [
      'a download URL pasted with raw spaces',
      `https://archive.org/download/${STRABO}/${VOLUME_2}`,
      STRABO,
      'download',
      VOLUME_2,
    ],
    [
      'the storage-node URL a download redirects to',
      `https://dn710807.ca.archive.org/0/items/${STRABO}/Strabo%2002%20Geography%203-5_djvu.txt`,
      STRABO,
      'storage',
      VOLUME_2,
    ],
    [
      'a storage-node URL with a two-digit node number',
      'https://ia800300.us.archive.org/12/items/prideprejudice00aust/prideprejudice00aust_djvu.txt?cnt=0',
      'prideprejudice00aust',
      'storage',
      'prideprejudice00aust_djvu.txt',
    ],
    [
      'a subdirectory file spanning segments',
      'https://archive.org/download/CrackedUpNoCC/CrackedUpNoCC.thumbs/Cracked%20Up%20(No%20Closed%20Captions)_000001.jpg',
      'CrackedUpNoCC',
      'download',
      THUMB,
    ],
    [
      'a subdirectory file with an encoded slash',
      'https://archive.org/download/CrackedUpNoCC/CrackedUpNoCC.thumbs%2FCracked%20Up%20(No%20Closed%20Captions)_000001.jpg',
      'CrackedUpNoCC',
      'download',
      THUMB,
    ],
    [
      'a non-ASCII file name',
      'https://archive.org/download/an-item/%D0%93%D0%BB%D0%B0%D0%B2%D0%B0.txt',
      'an-item',
      'download',
      'Глава.txt',
    ],
    [
      'a file name with a % that starts no escape',
      'https://archive.org/download/an-item/100%.txt',
      'an-item',
      'download',
      '100%.txt',
    ],
  ])('reads %s as its item and file', (_label, value, identifier, route, file) => {
    expect(parseItemReference(value)).toEqual({ kind: 'item', identifier, route, file });
  });

  it.each([
    'https://web.archive.org/web/2020/https://example.com/',
    'web.archive.org/web/20200101000000*/example.com',
    'http://web.archive.org/web/20200101000000id_/http://example.com/a?b=c',
  ])('reads %s as a Wayback capture', (value) => {
    expect(parseItemReference(value)).toEqual({ kind: 'wayback' });
  });

  it.each([
    ['https://example.com/foo', 'example.com'],
    ['https://archive.org/search?query=pride', 'archive.org'],
    ['https://archive.org/details/', 'archive.org'],
    ['https://archive.org/', 'archive.org'],
    ['https://archive.org/DETAILS/prideprejudice00aust', 'archive.org'],
    ['https://scholar.archive.org/details/prideprejudice00aust', 'scholar.archive.org'],
    ['https://ia800300.us.archive.org/fulltext/prideprejudice00aust', 'ia800300.us.archive.org'],
    ['https://ia800300.us.archive.org/12/items/', 'ia800300.us.archive.org'],
    ['https://web.archive.org/details/prideprejudice00aust', 'web.archive.org'],
    ['https://archive.org.example.com/details/prideprejudice00aust', 'archive.org.example.com'],
    ['https://user:secret@example.com/x?token=abc', 'example.com'],
  ])('leaves %s unrecognized, naming its host', (value, host) => {
    expect(parseItemReference(value)).toEqual({ kind: 'unrecognized', host });
  });

  it.each([
    [
      'https://example.com/0/items/prideprejudice00aust/prideprejudice00aust_djvu.txt',
      'example.com',
    ],
    ['https://evilarchive.org/0/items/prideprejudice00aust', 'evilarchive.org'],
    ['https://ia800300.us.archive.org/a1/items/prideprejudice00aust', 'ia800300.us.archive.org'],
    ['https://ia800300.us.archive.org/12/files/prideprejudice00aust', 'ia800300.us.archive.org'],
  ])('leaves %s, not a storage-node item path, unrecognized', (value, host) => {
    expect(parseItemReference(value)).toEqual({ kind: 'unrecognized', host });
  });

  it.each([
    [
      'https://archive.org/details/%40cyanheads',
      { kind: 'item', identifier: '@cyanheads', route: 'details' },
    ],
    [
      'https://archive.org/download/an-item/50%25%20off/100%.txt',
      { kind: 'item', identifier: 'an-item', route: 'download', file: '50% off/100%.txt' },
    ],
  ])('percent-decodes the identifier and each file segment of %s on its own', (value, expected) => {
    expect(parseItemReference(value)).toEqual(expected);
  });

  it.each([
    ['a colon value', 'foo:bar'],
    ['an ARK', 'ark:/13960/t9j38p11x'],
    ['a relative path', 'a/b'],
    ['an identifier with a trailing slash', 'prideprejudice00aust/'],
    ['an ftp URL', 'ftp://archive.org/details/prideprejudice00aust'],
    ['a mailto URI', 'mailto:someone@example.com'],
    ['a scheme-less URL on another host', 'example.com/details/prideprejudice00aust'],
  ])('leaves %s unrecognized, with no host', (_label, value) => {
    expect(parseItemReference(value)).toEqual({ kind: 'unrecognized' });
  });
});

describe('requireItemReference', () => {
  const ctx = () => createMockContext({ errors: iaGetItem.errors });
  const declared = iaGetItem.errors?.find((e) => e.reason === 'invalid_identifier')?.recovery;

  it('returns the item a URL names', () => {
    expect(requireItemReference(`archive.org/download/${STRABO}/a.txt`, ctx())).toEqual({
      kind: 'item',
      identifier: STRABO,
      route: 'download',
      file: 'a.txt',
    });
  });

  it.each([
    [
      'a URL on another host',
      'https://example.com/foo',
      'identifier is a URL on example.com that names no Internet Archive item.',
    ],
    [
      'a value with no host',
      'foo:bar',
      'identifier is neither an Internet Archive item identifier, which holds no "/" or ":", nor an archive.org item URL.',
    ],
  ])('throws invalid_identifier for %s with the caller’s recovery', (_label, value, message) => {
    expect(() => requireItemReference(value, ctx())).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.InvalidParams,
        message,
        data: expect.objectContaining({
          reason: 'invalid_identifier',
          recovery: { hint: declared },
        }),
      }),
    );
  });

  it('points a Wayback capture URL to ia_get_snapshot and the inputs it takes', () => {
    expect(() =>
      requireItemReference('https://web.archive.org/web/2020/https://example.com/', ctx()),
    ).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.InvalidParams,
        message:
          'identifier is a Wayback Machine capture URL, not an Internet Archive item identifier or item URL.',
        data: expect.objectContaining({
          reason: 'invalid_identifier',
          recovery: {
            hint: expect.stringMatching(/ia_get_snapshot.*as url.*as timestamp/),
          },
        }),
      }),
    );
  });

  it('never echoes credentials or query values from the value', () => {
    let thrown: unknown;
    try {
      requireItemReference('https://user:secret@example.com/x?token=abc', ctx());
    } catch (err) {
      thrown = err;
    }
    const text = JSON.stringify({
      message: (thrown as Error).message,
      data: (thrown as { data: unknown }).data,
    });
    expect(text).toContain('example.com');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('abc');
  });
});

describe('parseItemReference in linear time', () => {
  const fill = (unit: string, n: number): string =>
    unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const download = 'https://archive.org/download/an-item/';

  /** Worst cases: long bare values, paths of many segments, escapes, and long hosts and node numbers. */
  const WORST_CASES: [name: string, build: (n: number) => string][] = [
    ['a long bare identifier', (n) => fill('a', n)],
    ['a download file of many segments', (n) => download + fill('a/', n - download.length)],
    ['a download file of escapes', (n) => download + fill('%20', n - download.length)],
    ['a download file of broken escapes', (n) => download + fill('%E0%A4', n - download.length)],
    ['a download file of lone % signs', (n) => download + fill('%', n - download.length)],
    ['runs of slashes', (n) => fill('/', n)],
    ['runs of colons', (n) => fill(':', n)],
    ['a scheme-less details URL', (n) => `archive.org/details/${fill('x', n - 20)}`],
    ['a long host', (n) => `https://${fill('a.', n - 16)}org/details/x`],
    ['a long query', (n) => `https://archive.org/details/x?${fill('a=1&', n - 30)}`],
    ['a long Wayback path', (n) => `https://web.archive.org/web/2020/${fill('a/', n - 33)}`],
    [
      'a long storage-node number',
      (n) => `https://ia1.us.archive.org/${fill('1', n - 40)}/items/x/f`,
    ],
    [
      'one long line ending in a break',
      (n) => `${download}${fill('§1 x', n - download.length - 2)}\ny`,
    ],
    ['breaks throughout', (n) => `${download}${fill('  \r\n', n - download.length)}`],
    ['a long digit run', (n) => fill('1', n)],
  ];

  /** Smallest input; each larger size doubles it, up to 64× at 320k. */
  const BASE = 5_000;
  const LARGEST = 320_000;

  /** CPU ceiling per call: 1 µs per character, about 25× the slowest shape measured (13 ms at 320k). */
  const MAX_CPU_MS_PER_CHAR = 0.001;

  it.each(WORST_CASES)(
    'reads %s in linear time',
    async (_name, build) => {
      const base = build(BASE);
      for (let n = BASE * 2; n <= LARGEST; n *= 2) {
        const large = build(n);
        let growth = Number.POSITIVE_INFINITY;
        for (let round = 0; round < 3; round++) {
          const tBase = await cpuMsPerCall(() => parseItemReference(base));
          const tLarge = await cpuMsPerCall(() => parseItemReference(large));
          expect(tLarge, `${tLarge.toFixed(3)} ms CPU at ${n} characters`).toBeLessThan(
            n * MAX_CPU_MS_PER_CHAR,
          );
          growth = Math.min(growth, tLarge / tBase);
        }
        // Linear work grows ×(n / BASE); the bound leaves it 4× headroom, 256 at the full span.
        expect(growth, `×${growth.toFixed(1)} from ${BASE} to ${n} characters`).toBeLessThan(
          4 * (n / BASE),
        );
      }
    },
    0,
  );
});
