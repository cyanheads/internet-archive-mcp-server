/**
 * @fileoverview Tests for ArchiveMetadataService — the download-path error contract
 * (restricted-item 401/403 → `download_forbidden`), the recovery hint every
 * service-thrown reason forwards from the calling definition's contract, metadata
 * field mapping, text-file selection across the full manifest, the streamed page
 * read (whole-text equality, early stop, cancellation), and `find` (the page at a
 * phrase's first match, misses, searches resumed by continuation, `find_incomplete`).
 * @module tests/services/archive-metadata-service.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: Parameters<typeof fetchWithTimeout>) => fetchWithTimeout(...args),
    withRetry: <T>(fn: (attempt: { signal: AbortSignal }) => Promise<T>): Promise<T> =>
      fn({ signal: new AbortController().signal }),
  };
});

import { iaItemResource } from '@/mcp-server/resources/definitions/ia-item.resource.js';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import { iaGetText } from '@/mcp-server/tools/definitions/ia-get-text.tool.js';
import {
  ArchiveMetadataService,
  type TextSelection,
} from '@/services/archive-metadata/archive-metadata-service.js';
import { startCallDeadline } from '@/services/call-deadline.js';
import { expectLinearDoubling } from '../helpers/cpu-time.js';

/** A call deadline at the default request timeout, started now. */
const deadline = () => startCallDeadline(new AbortController().signal);

/** Metadata API response for an item with one readable text file. */
const metadataResponse = {
  text: async () =>
    JSON.stringify({
      metadata: { title: 'A Book' },
      files: [{ name: 'a-book_djvu.txt', format: 'Text' }],
    }),
} as Response;

/** Mirror of fetchWithTimeout's status-mapped error for a non-2xx download response. */
const statusError = (code: JsonRpcErrorCode, status: number): McpError =>
  new McpError(code, `Upstream returned HTTP ${status}.`, { status });

const buildService = (): ArchiveMetadataService =>
  new ArchiveMetadataService({ mcpServerVersion: '0.0.0-test' } as AppConfig, {} as StorageService);

describe('ArchiveMetadataService.getTextContent download contract', () => {
  beforeEach(() => {
    fetchWithTimeout.mockReset();
    // First call = metadata lookup succeeds; the download call is configured per-test.
    fetchWithTimeout.mockResolvedValueOnce(metadataResponse);
  });

  it('declares expectedStatuses [401, 403] on the download fetch', async () => {
    fetchWithTimeout.mockRejectedValueOnce(statusError(JsonRpcErrorCode.Forbidden, 403));

    const svc = buildService();
    const ctx = createMockContext({ errors: iaGetText.errors });
    await svc.getTextContent('restricted-item', 100, 0, ctx, deadline()).catch(() => undefined);

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      expect.stringContaining('https://archive.org/download/restricted-item'),
      expect.any(Number),
      expect.anything(),
      expect.objectContaining({ expectedStatuses: [401, 403] }),
    );
  });

  it('remaps HTTP 403 to download_forbidden with the declared recovery hint', async () => {
    fetchWithTimeout.mockRejectedValueOnce(statusError(JsonRpcErrorCode.Forbidden, 403));

    const svc = buildService();
    const ctx = createMockContext({ errors: iaGetText.errors });

    await expect(
      svc.getTextContent('restricted-item', 100, 0, ctx, deadline()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: {
        reason: 'download_forbidden',
        identifier: 'restricted-item',
        file: 'a-book_djvu.txt',
        recovery: {
          hint: expect.stringContaining('restricted collection'),
        },
      },
    });
  });

  it('remaps HTTP 401 (login-required download) to download_forbidden as well', async () => {
    fetchWithTimeout.mockRejectedValueOnce(statusError(JsonRpcErrorCode.Unauthorized, 401));

    const svc = buildService();
    const ctx = createMockContext({ errors: iaGetText.errors });

    await expect(svc.getTextContent('login-item', 100, 0, ctx, deadline())).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: {
        reason: 'download_forbidden',
        identifier: 'login-item',
        recovery: {
          hint: expect.stringContaining('restricted collection'),
        },
      },
    });
  });

  it('passes unrelated McpErrors through without remapping', async () => {
    const upstream = notFound('Item vanished.', { identifier: 'gone-item' });
    fetchWithTimeout.mockRejectedValueOnce(upstream);

    const svc = buildService();
    const ctx = createMockContext({ errors: iaGetText.errors });

    await expect(svc.getTextContent('gone-item', 100, 0, ctx, deadline())).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBe(upstream);
        return true;
      },
    );
  });
});

/** A Metadata API body as the service reads it (`response.text()`). */
const jsonBody = (body: unknown): Response =>
  ({ text: async () => JSON.stringify(body) }) as Response;

/** Reject any fetch a test did not stage, so an unexpected upstream call fails loudly. */
const rejectUnstagedFetches = (): void => {
  fetchWithTimeout.mockReset();
  fetchWithTimeout.mockImplementation((url: string) =>
    Promise.reject(new Error(`unmocked fetch: ${url}`)),
  );
};

describe('ArchiveMetadataService.getItem field mapping', () => {
  beforeEach(rejectUnstagedFetches);

  it('passes an array-valued language through unchanged', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({
        metadata: { title: 'Protestant review', language: ['German', 'English', 'French'] },
        files: [],
      }),
    );

    const item = await buildService().getItem('multi-lang', createMockContext(), deadline());

    expect(item.metadata.language).toEqual(['German', 'English', 'French']);
  });

  it('keeps a single language as a plain string', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({ metadata: { title: 'Pride and prejudice', language: 'eng' }, files: [] }),
    );

    const item = await buildService().getItem('one-lang', createMockContext(), deadline());

    expect(item.metadata.language).toBe('eng');
  });

  it('passes a list-valued title and date through unchanged', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({
        metadata: { title: ['Afganistan ', 'Афганистанъ '], date: ['6', '7'] },
        files: [],
      }),
    );

    const item = await buildService().getItem('00hamigoog', createMockContext(), deadline());

    expect(item.metadata.title).toEqual(['Afganistan ', 'Афганистанъ ']);
    expect(item.metadata.date).toEqual(['6', '7']);
  });

  it('keeps a single title and date as plain strings', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({ metadata: { title: 'Pride and prejudice', date: '1894' }, files: [] }),
    );

    const item = await buildService().getItem(
      'prideprejudice00aust',
      createMockContext(),
      deadline(),
    );

    expect(item.metadata.title).toBe('Pride and prejudice');
    expect(item.metadata.date).toBe('1894');
  });

  it('converts an HTML description to plain-text lines', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({
        metadata: {
          description:
            'ELMO SUPER 612R<div>ELMO SUPER 1018R</div><div>See <a href="http://example.com/m">the &amp; manual</a></div><div><br /></div>',
        },
        files: [],
      }),
    );

    const item = await buildService().getItem(
      'elmo-612-r-1018-r-users-manual-j',
      createMockContext(),
      deadline(),
    );

    expect(item.metadata.description).toBe(
      'ELMO SUPER 612R\nELMO SUPER 1018R\nSee the & manual (http://example.com/m)',
    );
  });

  it('converts each value of a list-valued description', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({
        metadata: {
          description: ['<p>One</p><p>two</p>', 'Plain\n\ntext  ', 'a&nbsp;&amp;&nbsp;b'],
        },
        files: [],
      }),
    );

    const item = await buildService().getItem('list-desc', createMockContext(), deadline());

    expect(item.metadata.description).toEqual(['One\ntwo', 'Plain\n\ntext', 'a & b']);
  });

  it('omits a description that holds no text', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({ metadata: { title: 'x', description: '<div><br /></div>' }, files: [] }),
    );

    const item = await buildService().getItem('empty-desc', createMockContext(), deadline());

    expect(item.metadata).not.toHaveProperty('description');
  });

  it('drops list values that hold no text, keeping the rest as a list', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({
        metadata: { description: ['<p></p>', '<p>Kept</p>', '', '<div><br /></div>'] },
        files: [],
      }),
    );

    const item = await buildService().getItem('sparse-desc', createMockContext(), deadline());

    expect(item.metadata.description).toEqual(['Kept']);
  });

  it('omits a list-valued description none of whose values holds text', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({ metadata: { title: 'x', description: ['<p></p>', '  '] }, files: [] }),
    );

    const item = await buildService().getItem('blank-list-desc', createMockContext(), deadline());

    expect(item.metadata).not.toHaveProperty('description');
  });

  it('leaves the title as received, markup and references included', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({ metadata: { title: 'A <b>bold</b> &amp; title' }, files: [] }),
    );

    const item = await buildService().getItem('markup-title', createMockContext(), deadline());

    expect(item.metadata.title).toBe('A <b>bold</b> &amp; title');
  });

  it('maps a record whose every field is a string in the fixed output order, whatever order the API sends', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({
        metadata: {
          'access-restricted-item': 'true',
          imagecount: '7',
          openlibrary_work: 'OL1W',
          openlibrary_edition: 'OL1M',
          lccn: 'l',
          'oclc-id': 'o',
          isbn: 'i',
          volume: 'v',
          publisher: 'p',
          language: 'eng',
          rights: 'r',
          licenseurl: 'https://example.org/l',
          collection: 'c',
          subject: 's',
          date: '1900',
          mediatype: 'texts',
          description: 'd',
          creator: 'a',
          title: 't',
        },
        files: [],
      }),
    );

    const item = await buildService().getItem('all-strings', createMockContext(), deadline());

    expect(Object.entries(item.metadata)).toEqual([
      ['identifier', 'all-strings'],
      ['title', 't'],
      ['creator', 'a'],
      ['description', 'd'],
      ['mediatype', 'texts'],
      ['date', '1900'],
      ['subject', 's'],
      ['collection', 'c'],
      ['licenseurl', 'https://example.org/l'],
      ['rights', 'r'],
      ['language', 'eng'],
      ['publisher', 'p'],
      ['volume', 'v'],
      ['isbn', 'i'],
      ['oclc_id', 'o'],
      ['lccn', 'l'],
      ['openlibrary_edition', 'OL1M'],
      ['openlibrary_work', 'OL1W'],
      ['image_count', 7],
      ['access_restricted', true],
    ]);
  });
});

describe('ArchiveMetadataService.getItem catalog and access fields', () => {
  beforeEach(rejectUnstagedFetches);

  /** getItem over one Metadata API body. */
  const itemFor = async (body: unknown) => {
    fetchWithTimeout.mockResolvedValueOnce(jsonBody(body));
    return buildService().getItem('an-item', createMockContext(), deadline());
  };

  it('maps publisher, Open Library IDs, and the image count of a texts item', async () => {
    const item = await itemFor({
      metadata: {
        mediatype: 'texts',
        publisher: 'London : George Allen',
        openlibrary_edition: 'OL7173379M',
        openlibrary_work: 'OL66554W',
        imagecount: '518',
      },
      files: [],
    });

    expect(item.metadata).toEqual({
      identifier: 'an-item',
      mediatype: 'texts',
      publisher: 'London : George Allen',
      openlibrary_edition: 'OL7173379M',
      openlibrary_work: 'OL66554W',
      image_count: 518,
    });
  });

  it('relays list-valued publisher, isbn, oclc-id, and lccn as received, and maps volume', async () => {
    const isbn = ['9780313328770', '0313328773', '031332879X'];
    const item = await itemFor({
      metadata: {
        publisher: ['S.-Peterburg : Izdal V. Berezovskīĭ', 'С.-Петербургъ : Издалъ В. Березовскій'],
        isbn,
        'oclc-id': ['1392922', '166588021'],
        lccn: ['cn 87032552', '11030899'],
        volume: '2',
      },
      files: [],
    });

    expect(item.metadata).toMatchObject({
      publisher: ['S.-Peterburg : Izdal V. Berezovskīĭ', 'С.-Петербургъ : Издалъ В. Березовскій'],
      isbn,
      oclc_id: ['1392922', '166588021'],
      lccn: ['cn 87032552', '11030899'],
      volume: '2',
    });
  });

  it('keeps single isbn, oclc-id, and lccn values as plain strings', async () => {
    const item = await itemFor({
      metadata: { isbn: '0313328773', 'oclc-id': '85792390', lccn: '35008545' },
      files: [],
    });

    expect(item.metadata).toMatchObject({
      isbn: '0313328773',
      oclc_id: '85792390',
      lccn: '35008545',
    });
  });

  it('reads access-restricted-item "true" as access_restricted and marks each private file', async () => {
    const item = await itemFor({
      metadata: { mediatype: 'texts', 'access-restricted-item': 'true' },
      files: [
        { name: 'blackreconstruc00dubo_djvu.txt', format: 'DjVuTXT', private: 'true' },
        { name: 'blackreconstruc00dubo_meta.xml', format: 'Metadata' },
      ],
    });

    expect(item.metadata.access_restricted).toBe(true);
    expect(item.files).toEqual([
      expect.objectContaining({ name: 'blackreconstruc00dubo_djvu.txt', private: true }),
      expect.not.objectContaining({ private: expect.anything() }),
    ]);
  });

  it.each([
    ['"false"', 'false'],
    ['"1"', '1'],
    ['an empty string', ''],
  ])('omits access_restricted when access-restricted-item is %s', async (_label, value) => {
    const item = await itemFor({ metadata: { 'access-restricted-item': value }, files: [] });

    expect(item.metadata).not.toHaveProperty('access_restricted');
  });

  it.each([
    ['the JSON boolean true', true],
    ['"TRUE"', 'TRUE'],
  ])('reads access_restricted only from the string "true", not %s', async (_label, value) => {
    const item = await itemFor({ metadata: { 'access-restricted-item': value }, files: [] });

    expect(item.metadata).not.toHaveProperty('access_restricted');
  });

  it('marks no file private unless the manifest says "true"', async () => {
    const item = await itemFor({
      metadata: {},
      files: [
        { name: 'a.txt', private: 'false' },
        { name: 'b.txt', private: '' },
        { name: 'c.txt' },
      ],
    });

    expect(item.files.map((f) => Object.hasOwn(f, 'private'))).toEqual([false, false, false]);
  });

  it.each([
    ['web', 'web', '1255'],
    ['movies', 'movies', '10801'],
    ['no mediatype', undefined, '42'],
  ])(
    'omits image_count for %s, where imagecount counts something else',
    async (_l, mediatype, imagecount) => {
      const item = await itemFor({ metadata: { mediatype, imagecount }, files: [] });

      expect(item.metadata).not.toHaveProperty('image_count');
    },
  );

  it.each(['518.5', '-3', '12 pages', ' 518', '', '1e3', '99999999999999999999'])(
    'omits a texts image count of %j, which is not a whole number',
    async (imagecount) => {
      const item = await itemFor({ metadata: { mediatype: 'texts', imagecount }, files: [] });

      expect(item.metadata).not.toHaveProperty('image_count');
    },
  );

  it('keeps an image count of 0', async () => {
    const item = await itemFor({ metadata: { mediatype: 'texts', imagecount: '0' }, files: [] });

    expect(item.metadata.image_count).toBe(0);
  });

  it('omits every catalog and access field the record lacks', async () => {
    const item = await itemFor({ metadata: { title: 'Sparse' }, files: [{ name: 'a.pdf' }] });

    expect(item.metadata).toEqual({ identifier: 'an-item', title: 'Sparse' });
    expect(item.files[0]).not.toHaveProperty('private');
  });
});

describe('ArchiveMetadataService.getItem string-or-list parse', () => {
  beforeEach(rejectUnstagedFetches);

  /** getItem over one Metadata API `metadata` object, with no files. */
  const metadataFor = async (metadata: Record<string, unknown>) => {
    fetchWithTimeout.mockResolvedValueOnce(jsonBody({ metadata, files: [] }));
    return (await buildService().getItem('an-item', createMockContext(), deadline())).metadata;
  };

  /** Every Metadata API key relayed as a string or a list, and the output name it maps to. */
  const RELAYED_KEYS = {
    title: 'title',
    creator: 'creator',
    description: 'description',
    mediatype: 'mediatype',
    date: 'date',
    publicdate: 'publicdate',
    addeddate: 'addeddate',
    subject: 'subject',
    collection: 'collection',
    licenseurl: 'licenseurl',
    rights: 'rights',
    language: 'language',
    publisher: 'publisher',
    volume: 'volume',
    isbn: 'isbn',
    'oclc-id': 'oclc_id',
    lccn: 'lccn',
    openlibrary_edition: 'openlibrary_edition',
    openlibrary_work: 'openlibrary_work',
    runtime: 'runtime',
  } as const;

  it('relays list-valued rights, licenseurl, volume, mediatype, and Open Library IDs as received', async () => {
    const metadata = await metadataFor({
      rights: ['Accessible without restriction.', 'Archived under fair use.'],
      licenseurl: [
        'https://opensource.org/licenses/MIT',
        'http://creativecommons.org/licenses/by-nc-sa/3.0',
      ],
      volume: ['1931', '18'],
      mediatype: ['texts', 'texts'],
      openlibrary_edition: ['OL1M', 'OL2M'],
      openlibrary_work: ['OL1W', 'OL2W'],
    });

    expect(metadata).toEqual({
      identifier: 'an-item',
      mediatype: ['texts', 'texts'],
      licenseurl: [
        'https://opensource.org/licenses/MIT',
        'http://creativecommons.org/licenses/by-nc-sa/3.0',
      ],
      rights: ['Accessible without restriction.', 'Archived under fair use.'],
      volume: ['1931', '18'],
      openlibrary_edition: ['OL1M', 'OL2M'],
      openlibrary_work: ['OL1W', 'OL2W'],
    });
  });

  it.each([
    ['a number', 1931],
    ['zero', 0],
    ['an object', { value: 'CC0' }],
    ['a boolean', true],
    ['null', null],
    ['a list holding a number', ['1931', 18]],
    ['a list holding an object', [{ value: 'CC0' }]],
    ['a list holding null', [null]],
    ['an empty string', ''],
  ])('leaves out a value that is %s', async (_label, value) => {
    const metadata = await metadataFor({ title: 'Kept', rights: value });

    expect(metadata).toEqual({ identifier: 'an-item', title: 'Kept' });
  });

  it.each(Object.entries(RELAYED_KEYS))(
    'reads %s through the parse, leaving a number out as %s',
    async (key, name) => {
      const kept = await metadataFor({ [key]: ['one', 'two'] });
      const dropped = await metadataFor({ [key]: 42 });

      expect(kept).toHaveProperty(name, ['one', 'two']);
      expect(dropped).toEqual({ identifier: 'an-item' });
    },
  );

  it('maps publicdate and addeddate as stored, right after date', async () => {
    const metadata = await metadataFor({
      addeddate: '2007-07-26 11:49:10',
      publicdate: '2007-07-26 11:49:20',
      title: 'Pride and prejudice',
      date: '1894',
      language: 'eng',
    });

    expect(Object.entries(metadata)).toEqual([
      ['identifier', 'an-item'],
      ['title', 'Pride and prejudice'],
      ['date', '1894'],
      ['publicdate', '2007-07-26 11:49:20'],
      ['addeddate', '2007-07-26 11:49:10'],
      ['language', 'eng'],
    ]);
  });

  it('returns the upload dates of an item with no publication date, a bare addeddate as stored', async () => {
    const metadata = await metadataFor({
      title: 'A Christmas Carol',
      publicdate: '2014-10-24 16:15:43',
      addeddate: '2006-12-06',
    });

    expect(metadata).toEqual({
      identifier: 'an-item',
      title: 'A Christmas Carol',
      publicdate: '2014-10-24 16:15:43',
      addeddate: '2006-12-06',
    });
  });

  it('omits publicdate and addeddate when the record lacks them', async () => {
    const metadata = await metadataFor({ title: 'openmind_ep431', date: '2020' });

    expect(metadata).toEqual({ identifier: 'an-item', title: 'openmind_ep431', date: '2020' });
  });

  it('maps runtime as catalogued, after the Open Library IDs and before the image count', async () => {
    const metadata = await metadataFor({
      imagecount: '12',
      runtime: '13:06:44',
      openlibrary_work: 'OL1W',
      mediatype: 'texts',
      title: 'Pride and Prejudice',
    });

    expect(Object.entries(metadata)).toEqual([
      ['identifier', 'an-item'],
      ['title', 'Pride and Prejudice'],
      ['mediatype', 'texts'],
      ['openlibrary_work', 'OL1W'],
      ['runtime', '13:06:44'],
      ['image_count', 12],
    ]);
  });

  it.each([
    ['20:33', '20:33'],
    ['27 min 13 sec', '27 min 13 sec'],
    [
      ['00:03:09', '00:02:58'],
      ['00:03:09', '00:02:58'],
    ],
  ])('relays a runtime of %j as catalogued', async (runtime, expected) => {
    expect(await metadataFor({ runtime })).toEqual({ identifier: 'an-item', runtime: expected });
  });

  it('converts each value of a description list only after it parses as one', async () => {
    const metadata = await metadataFor({ description: ['<p>One</p>', 2] });

    expect(metadata).not.toHaveProperty('description');
  });

  it.each([
    ['["texts"]', ['texts'], ['texts']],
    ['["texts", "texts"]', ['texts', 'texts'], ['texts', 'texts']],
  ])(
    'returns image_count for a mediatype of %s, every value texts',
    async (_label, mediatype, expected) => {
      const metadata = await metadataFor({ mediatype, imagecount: '540' });

      expect(metadata).toMatchObject({ mediatype: expected, image_count: 540 });
    },
  );

  it.each([
    ['["texts", "movies"]', ['texts', 'movies']],
    ['["movies"]', ['movies']],
    ['[]', []],
    ['["texts", 5], which is left out', ['texts', 5]],
  ])('omits image_count for a mediatype of %s', async (_label, mediatype) => {
    const metadata = await metadataFor({ mediatype, imagecount: '540' });

    expect(metadata).not.toHaveProperty('image_count');
  });

  it('maps any JSON in every relayed key to output the ia_get_item schema accepts and format() renders', async () => {
    const keys = Object.keys(RELAYED_KEYS);
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.constantFrom(...keys), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 6 }),
        async (metadata) => {
          const mapped = await metadataFor({ ...metadata, imagecount: '3' });
          const output = iaGetItem.output.parse({ ...mapped, file_count: 0, files: [] });
          const [block] = iaGetItem.format!(output) as [{ text: string }];
          expect(block.text).toContain('\n**Identifier:** an-item\n');
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('ArchiveMetadataService.getItem file manifest', () => {
  beforeEach(rejectUnstagedFetches);

  const GD = 'gd77-05-08.sbd.hicks.4982.sbeok.shnf';
  const download = (identifier: string, name: string) =>
    `https://archive.org/download/${identifier}/${name}`;

  /** getItem over one Metadata API `files` value. */
  const filesFor = async (files: unknown, identifier = 'an-item') => {
    fetchWithTimeout.mockResolvedValueOnce(jsonBody({ metadata: { identifier }, files }));
    return (await buildService().getItem(identifier, createMockContext(), deadline())).files;
  };

  /** Entries of the Grateful Dead item as the Metadata API returns them (2026-11-22). */
  const GD_ENTRIES = [
    {
      name: 'gd1977-05-08-d1.md5',
      source: 'original',
      format: 'Checksums',
      creator: 'Grateful Dead',
      md5: 'a16d46922e8ee70763380ae60a8061ba',
      album: '1977-05-08 - Barton Hall, Cornell University',
      title: 'gd77-05-08.sbd.hicks.4982.sbeok.shnf_shn.zip',
      track: '0',
      size: '549',
    },
    {
      name: 'gd77-05-08eaton-d1t01.mp3',
      source: 'derivative',
      creator: 'Grateful Dead',
      title: 'Minglewood Blues',
      track: '1',
      album: '1977-05-08 - Barton Hall, Cornell University',
      bitrate: '185',
      length: '06:21',
      format: 'VBR MP3',
      original: 'gd77-05-08eaton-d1t01.shn',
      size: '8838656',
      md5: '96d1fc48cae5e3bdd62c383d5b458a43',
      height: '0',
      width: '0',
    },
    {
      name: 'gd77-05-08eaton-d1t01.ogg',
      source: 'derivative',
      format: 'Ogg Vorbis',
      original: 'gd77-05-08eaton-d1t01.shn',
      size: '4267995',
      md5: 'a0de3951d73f67c0e3fb6d7384592ac1',
      length: '381.1',
    },
    {
      name: 'gd77-05-08eaton-d1t01.png',
      source: 'derivative',
      format: 'PNG',
      size: '9430',
      md5: 'd105252abdee7b86d91d5d55631c8811',
    },
    {
      name: 'gd77-05-08eaton-d1t01.shn',
      source: 'original',
      format: 'Shorten',
      md5: 'b9916ce980d1385adbaf219311685d3b',
      track: '1',
      title: 'Minglewood Blues',
      size: '41028317',
      length: '232.58',
      private: 'true',
    },
  ];

  it('relays each file’s title, track, and length as catalogued, and leaves every other key out', async () => {
    const files = await filesFor(GD_ENTRIES, GD);

    expect(files).toEqual([
      {
        name: 'gd1977-05-08-d1.md5',
        downloadUrl: download(GD, 'gd1977-05-08-d1.md5'),
        format: 'Checksums',
        size: '549',
        md5: 'a16d46922e8ee70763380ae60a8061ba',
        title: 'gd77-05-08.sbd.hicks.4982.sbeok.shnf_shn.zip',
        track: '0',
      },
      {
        name: 'gd77-05-08eaton-d1t01.mp3',
        downloadUrl: download(GD, 'gd77-05-08eaton-d1t01.mp3'),
        format: 'VBR MP3',
        size: '8838656',
        md5: '96d1fc48cae5e3bdd62c383d5b458a43',
        title: 'Minglewood Blues',
        track: '1',
        length: '06:21',
      },
      {
        name: 'gd77-05-08eaton-d1t01.ogg',
        downloadUrl: download(GD, 'gd77-05-08eaton-d1t01.ogg'),
        format: 'Ogg Vorbis',
        size: '4267995',
        md5: 'a0de3951d73f67c0e3fb6d7384592ac1',
        length: '381.1',
      },
      {
        name: 'gd77-05-08eaton-d1t01.png',
        downloadUrl: download(GD, 'gd77-05-08eaton-d1t01.png'),
        format: 'PNG',
        size: '9430',
        md5: 'd105252abdee7b86d91d5d55631c8811',
      },
      {
        name: 'gd77-05-08eaton-d1t01.shn',
        downloadUrl: download(GD, 'gd77-05-08eaton-d1t01.shn'),
        format: 'Shorten',
        size: '41028317',
        md5: 'b9916ce980d1385adbaf219311685d3b',
        title: 'Minglewood Blues',
        track: '1',
        length: '232.58',
        private: true,
      },
    ]);
  });

  it('relays a LibriVox chapter’s title, track of total, and length in seconds', async () => {
    const [file] = await filesFor(
      [
        {
          name: 'prideandprejudice_01-03_austen.mp3',
          source: 'original',
          size: '18129230',
          format: 'VBR MP3',
          title: 'Chapters 1-3',
          track: '1/37',
          md5: 'e6cff6db8fc50a802a28a07772e94888',
          length: '1133.07',
          'external-identifier': 'urn:acoustid:30feb3fb-cf8e-411d-bc10-8615d85e692a',
        },
      ],
      'pride_and_prejudice_librivox',
    );

    expect(file).toMatchObject({ title: 'Chapters 1-3', track: '1/37', length: '1133.07' });
  });

  it.each(['format', 'size', 'md5', 'title', 'track', 'length'])(
    'leaves out a %s that is not a non-empty string, keeping the file and the call',
    async (key) => {
      const values: unknown[] = [5, 0, true, { v: 'x' }, ['VBR MP3'], [], null, ''];
      const files = await filesFor(values.map((value, i) => ({ name: `f${i}.mp3`, [key]: value })));

      expect(files).toEqual(
        values.map((_, i) => ({
          name: `f${i}.mp3`,
          downloadUrl: download('an-item', `f${i}.mp3`),
        })),
      );
    },
  );

  it.each([
    ['with no name', { format: 'DjVuTXT' }],
    ['with a null name', { name: null, format: 'Text' }],
    ['with a number name', { name: 5, format: 'JPEG' }],
    ['with a list name', { name: ['a.txt'], format: 'Text' }],
    ['with an empty name', { name: '', format: 'Text' }],
    ['that is null', null],
    ['that is a string', 'a.txt'],
    ['that is a number', 7],
    ['that is a list', [{ name: 'a.txt' }]],
  ])('leaves out a manifest entry %s, keeping the files around it', async (_label, entry) => {
    const files = await filesFor([{ name: 'a.txt', format: 'Text' }, entry, { name: 'b.txt' }]);

    expect(files).toEqual([
      { name: 'a.txt', downloadUrl: download('an-item', 'a.txt'), format: 'Text' },
      { name: 'b.txt', downloadUrl: download('an-item', 'b.txt') },
    ]);
  });

  it.each([
    ['an object', { name: 'a.txt' }],
    ['a string', 'a.txt'],
    ['a number', 3],
    ['true', true],
    ['null', null],
  ])('reads a files value that is %s as no files', async (_label, files) => {
    expect(await filesFor(files)).toEqual([]);
  });

  it('keeps the ia_get_text default pick working when another file’s format is not a string', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({
        metadata: {},
        files: [
          { name: 'scan_0001.jpg', format: 5 },
          { name: 'notes.txt', format: ['Text'] },
          { name: 'book_djvu.txt', format: 'DjVuTXT' },
        ],
      }),
    );
    fetchWithTimeout.mockResolvedValueOnce(new Response('book text'));

    const page = await buildService().getTextContent(
      'an-item',
      100,
      0,
      createMockContext({ errors: iaGetText.errors }),
      deadline(),
    );

    expect(page).toMatchObject({
      sourceFile: 'book_djvu.txt',
      text: 'book text',
      textFiles: { count: 2, formats: ['DjVuTXT'], unformatted: 1 },
    });
  });

  it('maps any JSON in every manifest key to files of non-empty strings the ia_get_item schema accepts and format() renders', async () => {
    const keys = ['name', 'format', 'size', 'md5', 'title', 'track', 'length', 'private', 'source'];
    const entry = fc.oneof(
      fc.dictionary(fc.constantFrom(...keys), fc.jsonValue({ maxDepth: 1 }), { maxKeys: 9 }),
      fc.record({ name: fc.string({ minLength: 1 }) }),
      fc.jsonValue({ maxDepth: 1 }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(entry, { maxLength: 8 }), async (entries) => {
        const files = await filesFor(entries);
        for (const { downloadUrl, private: hidden, ...fields } of files) {
          expect(downloadUrl).toMatch(/^https:\/\/archive\.org\/download\/an-item\/./);
          expect(hidden === undefined || hidden === true).toBe(true);
          for (const value of Object.values(fields)) {
            expect(typeof value === 'string' && value !== '').toBe(true);
          }
        }
        const output = iaGetItem.output.parse({
          identifier: 'an-item',
          file_count: files.length,
          files: files.map(({ downloadUrl, ...f }) => ({ ...f, download_url: downloadUrl })),
        });
        const [block] = iaGetItem.format!(output) as [{ text: string }];
        expect(block.text).toContain(`**Files (${files.length}):**`);
      }),
      { numRuns: 300 },
    );
  });
});

describe('ArchiveMetadataService.getTextContent text-file selection', () => {
  beforeEach(rejectUnstagedFetches);

  it('finds a DjVuTXT file positioned far past the first 50 manifest entries', async () => {
    const files = Array.from({ length: 120 }, (_, i) => ({
      name: `page_${String(i).padStart(3, '0')}.jpg`,
      format: 'JPEG Thumb',
    }));
    files[100] = { name: 'big-item_djvu.txt', format: 'DjVuTXT' };
    fetchWithTimeout.mockResolvedValueOnce(jsonBody({ metadata: { title: 'Big' }, files }));
    fetchWithTimeout.mockResolvedValueOnce(new Response('Full OCR text.'));

    const result = await buildService().getTextContent(
      'big-item',
      100,
      0,
      createMockContext(),
      deadline(),
    );

    expect(result.sourceFile).toBe('big-item_djvu.txt');
    expect(result.text).toBe('Full OCR text.');
    expect(fetchWithTimeout).toHaveBeenLastCalledWith(
      'https://archive.org/download/big-item/big-item_djvu.txt',
      expect.any(Number),
      expect.anything(),
      expect.anything(),
    );
  });

  /** The file the default pick downloads from a manifest of `files`. */
  const defaultPick = async (files: { name: string; format?: string }[]) => {
    fetchWithTimeout.mockResolvedValueOnce(jsonBody({ metadata: {}, files }));
    fetchWithTimeout.mockResolvedValueOnce(new Response('text'));
    return (await buildService().getTextContent('an-item', 10, 0, createMockContext(), deadline()))
      .sourceFile;
  };

  const caption = { name: 'film.cc5.txt', format: 'Closed Caption Text' };
  const plain = { name: 'plain.txt', format: 'Plain Text' };
  const text = { name: 'info.txt', format: 'Text' };
  const djvu = { name: 'book_djvu.txt', format: 'DjVuTXT' };

  it.each([
    ['DjVuTXT over Text, Plain Text, and other .txt files', [caption, plain, text, djvu], djvu],
    ['Text over Plain Text and other .txt files', [caption, plain, text], text],
    ['Plain Text over other .txt files', [caption, plain], plain],
    [
      'another .txt file when no text format is listed',
      [{ name: 'a.jpg', format: 'JPEG' }, caption],
      caption,
    ],
    [
      'a format in any case',
      [plain, { name: 'lower_djvu.txt', format: 'djvutxt' }],
      { name: 'lower_djvu.txt' },
    ],
    [
      'the first of several files of one format, in manifest order',
      [djvu, { name: 'vol2_djvu.txt', format: 'DjVuTXT' }],
      djvu,
    ],
  ])('picks %s by default', async (_label, files, expected) => {
    expect(await defaultPick(files)).toBe(expected.name);
  });

  it.each([
    [
      'a Text file whose name has no .txt extension',
      [caption, { name: 'transcript.text', format: 'Text' }],
      'transcript.text',
    ],
    [
      'the first of several other .txt files, in manifest order',
      [caption, { name: 'film.cc6.txt', format: 'Closed Caption Text' }],
      'film.cc5.txt',
    ],
  ])('picks %s by default', async (_label, files, expected) => {
    expect(await defaultPick(files)).toBe(expected);
  });

  it('answers an item whose only .txt files are Metadata sidecars as no_text_file, with no download', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({
        metadata: {},
        files: [
          { name: 'case.pdf', format: 'Text PDF' },
          { name: 'case.11.0.pdf_meta.txt', format: 'Metadata', size: '834' },
          { name: 'case.12.0.pdf_meta.txt', format: 'metadata', size: '702' },
        ],
      }),
    );

    await expect(
      buildService().getTextContent(
        'court-case',
        10,
        0,
        createMockContext({ errors: iaGetText.errors }),
        deadline(),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'no_text_file' } });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  /** A multi-volume item: text volumes among page images, OCR search text, and an upload sidecar. */
  const volumeManifest = [
    { name: 'scan_0001.jpg', format: 'JPEG' },
    { name: 'Vol 01_djvu.txt', format: 'DjVuTXT' },
    { name: 'Vol 01_hocr_searchtext.txt.gz', format: 'OCR Search Text' },
    { name: 'Vol 02_djvu.txt', format: 'DjVuTXT' },
    { name: 'Vol 02.pdf_meta.txt', format: 'Metadata' },
    { name: 'about.txt', format: 'Text' },
    { name: 'notes.txt' },
    { name: 'LICENSE' },
  ];

  /** Read `file` from the multi-volume item, or its default pick when `file` is omitted. */
  const readVolume = async (file?: string) => {
    fetchWithTimeout.mockResolvedValueOnce(jsonBody({ metadata: {}, files: volumeManifest }));
    fetchWithTimeout.mockResolvedValueOnce(new Response('volume text'));
    return buildService().getTextContent(
      'strabo',
      100,
      0,
      createMockContext({ errors: iaGetText.errors }),
      deadline(),
      { file },
    );
  };

  it('reads the file named by file, downloading only that file, with no textFiles summary', async () => {
    const result = await readVolume('Vol 02_djvu.txt');

    expect(result.sourceFile).toBe('Vol 02_djvu.txt');
    expect(result.text).toBe('volume text');
    expect(result).not.toHaveProperty('textFiles');
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(fetchWithTimeout).toHaveBeenLastCalledWith(
      'https://archive.org/download/strabo/Vol%2002_djvu.txt',
      expect.any(Number),
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    ['a .txt file whose format is not a text format', 'notes.txt'],
    ['a Text file', 'about.txt'],
  ])('reads %s named by file', async (_label, file) => {
    expect((await readVolume(file)).sourceFile).toBe(file);
  });

  it.each([
    [
      'a name missing from the manifest',
      'missing_djvu.txt',
      'Item "strabo" lists no file named "missing_djvu.txt".',
    ],
    ['an inherited property name', '__proto__', 'lists no file named "__proto__"'],
    ['another inherited property name', 'constructor', 'lists no file named "constructor"'],
    ['a name differing only in case', 'vol 02_djvu.txt', 'lists no file named "vol 02_djvu.txt"'],
    [
      'a compressed OCR search-text file',
      'Vol 01_hocr_searchtext.txt.gz',
      'has format "OCR Search Text", which is not readable text',
    ],
    [
      'a Metadata sidecar',
      'Vol 02.pdf_meta.txt',
      'has format "Metadata", which is not readable text',
    ],
    ['an image', 'scan_0001.jpg', 'has format "JPEG"'],
    ['a file with no format and no .txt name', 'LICENSE', 'lists no format and is not a .txt file'],
  ])('rejects %s as invalid_file before any download', async (_label, file, message) => {
    await expect(readVolume(file)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      message: expect.stringContaining(message),
      data: {
        reason: 'invalid_file',
        identifier: 'strabo',
        file,
        recovery: { hint: declaredRecovery(iaGetText.errors, 'invalid_file') },
      },
    });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('summarizes every readable file the default pick chose among, leaving out sidecars and search text', async () => {
    const result = await readVolume();

    expect(result.sourceFile).toBe('Vol 01_djvu.txt');
    expect(result.textFiles).toEqual({ count: 4, formats: ['DjVuTXT', 'Text'], unformatted: 1 });
  });

  it.each([
    ['one readable file among sidecars', [djvu, { name: 'x_meta.txt', format: 'Metadata' }]],
    ['one readable file alone', [djvu]],
  ])('reports no textFiles summary for %s', async (_label, files) => {
    fetchWithTimeout.mockResolvedValueOnce(jsonBody({ metadata: {}, files }));
    fetchWithTimeout.mockResolvedValueOnce(new Response('text'));

    const result = await buildService().getTextContent(
      'an-item',
      10,
      0,
      createMockContext(),
      deadline(),
    );

    expect(result).not.toHaveProperty('textFiles');
  });
});

/** Seeded PRNG (mulberry32) so a sweep is reproducible run to run. */
const seededRandom = (seed: number): (() => number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Pull and cancel counts observed on a streamed download body. */
interface BodyStats {
  cancelled: boolean;
  pulls: number;
}

/**
 * A download response whose body is served one chunk per pull (no read-ahead), recording
 * how many chunks were pulled and whether the body was cancelled. `chunkAt` returns
 * `undefined` past the last chunk.
 */
const streamedDownload = (
  chunkAt: (index: number) => Uint8Array | undefined,
): { response: Response; stats: BodyStats } => {
  const stats: BodyStats = { cancelled: false, pulls: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunkAt(stats.pulls++);
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(body), stats };
};

/** Split `bytes` into chunks of seeded sizes between 1 and `maxSize` bytes. */
const splitBytes = (bytes: Uint8Array, maxSize: number, random: () => number): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    const size = 1 + Math.floor(random() * maxSize);
    chunks.push(bytes.subarray(at, at + size));
    at += size;
  }
  return chunks;
};

/** Byte offsets where one chunk ends and the next begins. */
const chunkBoundaries = (chunks: readonly Uint8Array[]): number[] => {
  const boundaries: number[] = [];
  let at = 0;
  for (const chunk of chunks.slice(0, -1)) {
    at += chunk.byteLength;
    boundaries.push(at);
  }
  return boundaries;
};

const isContinuationByte = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80;

/**
 * Mixed-script fixture: ASCII, Cyrillic (2-byte UTF-8), CJK and Devanagari (3-byte),
 * astral emoji and musical symbols (4-byte UTF-8, surrogate pairs in UTF-16), and a
 * combining accent.
 */
const mixedScriptText = (random: () => number, pieces: number): string => {
  const vocabulary = ['The ', 'Глава ', '第一章 ', '📜', '🦉 ', 'naïve ', 'é ', '\n', 'ऄ', '𝄞'];
  return Array.from(
    { length: pieces },
    () => vocabulary[Math.floor(random() * vocabulary.length)],
  ).join('');
};

/** A manifest naming one DjVuTXT file, with `size` when given. */
const textManifest = (size?: string): Response =>
  jsonBody({
    metadata: { title: 'A Volume' },
    files: [{ name: 'volume_djvu.txt', format: 'DjVuTXT', ...(size !== undefined && { size }) }],
  });

describe('ArchiveMetadataService.getTextContent streamed page read', () => {
  beforeEach(rejectUnstagedFetches);

  it('characterizes replacement followed by a reconsumed ASCII byte at a page boundary', async () => {
    fetchWithTimeout.mockResolvedValueOnce(textManifest());
    fetchWithTimeout.mockResolvedValueOnce(
      new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0xe2, 0x41, 0x42])),
    );
    const result = await buildService().getTextContent(
      'a-volume',
      1,
      1,
      createMockContext(),
      deadline(),
    );
    expect(result.text).toBe('A');
    expect(result.hasMore).toBe(true);
  });

  it('offers an opaque continuation when a stable representation has another page', async () => {
    fetchWithTimeout.mockResolvedValueOnce(textManifest('6'));
    fetchWithTimeout.mockResolvedValueOnce(
      new Response('abcdef', { headers: { etag: '"stable"' } }),
    );
    const result = await buildService().getTextContent(
      'a-volume',
      2,
      0,
      createMockContext(),
      deadline(),
    );
    expect(result).toHaveProperty('nextContinuation', expect.any(String));
  });

  /** Stage the manifest and one streamed download, then read one page. */
  const readPage = async (
    chunks: readonly Uint8Array[] | ((index: number) => Uint8Array | undefined),
    maxChars: number,
    charOffset: number,
    size?: string,
  ) => {
    const { response, stats } = streamedDownload(
      typeof chunks === 'function' ? chunks : (i) => chunks[i],
    );
    fetchWithTimeout.mockResolvedValueOnce(textManifest(size));
    fetchWithTimeout.mockResolvedValueOnce(response);
    const result = await buildService().getTextContent(
      'a-volume',
      maxChars,
      charOffset,
      createMockContext({ errors: iaGetText.errors }),
      deadline(),
    );
    return { result, stats };
  };

  const random = seededRandom(33);
  const fixtureText = mixedScriptText(random, 700);
  const fixtureBytes = new TextEncoder().encode(fixtureText);
  const fixtureChunks = splitBytes(fixtureBytes, 7, random);
  /** What the whole-text read returned: the decoded file, sliced. */
  const whole = new TextDecoder().decode(fixtureBytes);
  const wholePage = (charOffset: number, maxChars: number) => ({
    text: whole.slice(charOffset, charOffset + maxChars),
    hasMore: charOffset + maxChars < whole.length,
  });

  /** Seeded (char_offset, max_chars) pairs plus the fixed edge cases. */
  const sweep: [charOffset: number, maxChars: number][] = [
    [0, whole.length],
    [0, whole.length - 1],
    [whole.length - 40, 40],
    [whole.length - 40, 39],
    [whole.length - 1, 1],
    [whole.length, 1],
    [whole.length + 25, 10],
    ...Array.from({ length: 300 }, (): [number, number] => [
      Math.floor(random() * (whole.length + 20)),
      1 + Math.floor(random() * (random() < 0.9 ? 300 : whole.length)),
    ]),
  ];

  it('builds a fixture whose chunk boundaries split multi-byte and astral sequences', () => {
    const splits = chunkBoundaries(fixtureChunks).filter((b) =>
      isContinuationByte(fixtureBytes[b]),
    );
    const leadByteOf = (b: number): number => {
      let at = b;
      while (isContinuationByte(fixtureBytes[at])) at--;
      return fixtureBytes[at] as number;
    };

    expect(fixtureChunks.length).toBeGreaterThan(100);
    expect(splits.length).toBeGreaterThan(10);
    expect(splits.some((b) => leadByteOf(b) >= 0xf0)).toBe(true);
    expect(whole).toContain('\u{1F4DC}');
  });

  it('serves the same text and has_more as slicing the whole decoded file, across a seeded sweep', {
    timeout: 30_000,
  }, async () => {
    for (const [charOffset, maxChars] of sweep) {
      const { result } = await readPage(fixtureChunks, maxChars, charOffset);
      expect(
        { text: result.text, hasMore: result.hasMore },
        `char_offset ${charOffset}, max_chars ${maxChars}`,
      ).toEqual(wholePage(charOffset, maxChars));
    }
  });

  it('strips a leading byte-order mark split across chunks, as the whole-text read did', async () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Глава 📜 one')]);
    const chunks = splitBytes(withBom, 2, seededRandom(7));

    const { result } = await readPage(chunks, 7, 0);

    expect(result.text).toBe(new TextDecoder().decode(withBom).slice(0, 7));
    expect(result.text.startsWith('Глава')).toBe(true);
    expect(result.hasMore).toBe(true);
  });

  it('decodes malformed, truncated, and mid-file byte-order-mark bytes as the whole-text read did, across chunk splits', async () => {
    const encode = (s: string) => [...new TextEncoder().encode(s)];
    const bytes = new Uint8Array([
      ...encode('Глава '),
      ...[0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xff, 0xfe],
      ...encode('📜 mid'),
      ...[0xef, 0xbb, 0xbf, 0x80],
      ...encode('𝄞 end'),
      ...[0xf0, 0x9f, 0x98],
    ]);
    const expected = await new Response(bytes).text();

    for (const maxSize of [1, 2, 3, 5]) {
      const { result } = await readPage(
        splitBytes(bytes, maxSize, seededRandom(maxSize)),
        1_000,
        0,
      );
      expect(result.text, `chunks of up to ${maxSize} bytes`).toBe(expected);
    }
  });

  it('keeps a mid-file U+FEFF when the first chunk ends inside a character', async () => {
    const bytes = new Uint8Array([0xd0, 0x93, 0xef, 0xbb, 0xbf, 0x61]);

    const { result } = await readPage([bytes.subarray(0, 1), bytes.subarray(1)], 10, 0);

    expect(result.text).toBe(await new Response(bytes).text());
    expect(result.text).toBe('Г\u{feff}a');
  });

  it('serves a page ending exactly at end of file with has_more false after reading to the end', async () => {
    const { result, stats } = await readPage(fixtureChunks, 40, whole.length - 40);

    expect(stats.pulls).toBe(fixtureChunks.length + 1);
    expect(stats.cancelled).toBe(false);
    expect(result.text).toBe(whole.slice(-40));
    expect(result.hasMore).toBe(false);
  });

  it('serves empty text and has_more false for an offset past the end', async () => {
    const { result } = await readPage(fixtureChunks, 100, whole.length + 1_000);

    expect(result.text).toBe('');
    expect(result.hasMore).toBe(false);
  });

  it('serves empty text and has_more false for an empty file', async () => {
    const { result, stats } = await readPage([], 100, 0);

    expect(result.text).toBe('');
    expect(result.hasMore).toBe(false);
    expect(stats.pulls).toBe(1);
  });

  /** 20 MB of synthetic ASCII, generated per pull: chunk i is 1 KiB of one letter. */
  const CHUNK = 1_024;
  const CHUNK_COUNT = 20_000;
  const letterChunk = (i: number): Uint8Array | undefined =>
    i < CHUNK_COUNT ? new Uint8Array(CHUNK).fill(97 + (i % 26)) : undefined;
  const letterText = (from: number, length: number): string =>
    Array.from({ length }, (_, k) =>
      String.fromCharCode(97 + (Math.floor((from + k) / CHUNK) % 26)),
    ).join('');

  it('stops a page near the start of a large body after the first chunks and cancels the rest', async () => {
    const { result, stats } = await readPage(letterChunk, 2_000, 0);

    expect(stats.pulls).toBe(2);
    expect(stats.cancelled).toBe(true);
    expect(result.text).toBe(letterText(0, 2_000));
    expect(result.hasMore).toBe(true);
  });

  it('stops a mid-body page at the chunk holding the character after the window', async () => {
    const charOffset = 1_000_000;
    const { result, stats } = await readPage(letterChunk, 1_000, charOffset);

    // The character after the window (index 1,001,000) sits in chunk 977 (0-based).
    expect(stats.pulls).toBe(978);
    expect(stats.cancelled).toBe(true);
    expect(result.text).toBe(letterText(charOffset, 1_000));
    expect(result.hasMore).toBe(true);
  });

  it('cancels when the window ends exactly at a chunk boundary and more follows', async () => {
    const { result, stats } = await readPage(letterChunk, CHUNK, 0);

    expect(stats.pulls).toBe(2);
    expect(stats.cancelled).toBe(true);
    expect(result.text).toBe(letterText(0, CHUNK));
    expect(result.hasMore).toBe(true);
  });

  it('propagates an error raised while the body is still streaming', async () => {
    const stalled = new McpError(JsonRpcErrorCode.Timeout, 'Body read timed out.');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial page'));
        controller.error(stalled);
      },
    });
    fetchWithTimeout.mockResolvedValueOnce(textManifest());
    fetchWithTimeout.mockResolvedValueOnce(new Response(body));

    await expect(
      buildService().getTextContent('a-volume', 100, 0, createMockContext(), deadline()),
    ).rejects.toBe(stalled);
  });

  it('carries the manifest size as sourceFileBytes', async () => {
    const { result } = await readPage(fixtureChunks, 10, 0, '9915421');

    expect(result.sourceFileBytes).toBe(9_915_421);
  });

  it('omits sourceFileBytes when the manifest lists no size', async () => {
    const { result } = await readPage(fixtureChunks, 10, 0);

    expect(result).not.toHaveProperty('sourceFileBytes');
  });
});

/** The declared recovery string for `reason` on a definition's error contract. */
const declaredRecovery = (
  errors: readonly { reason: string; recovery: string }[] | undefined,
  reason: string,
): string => {
  const entry = errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`contract declares no ${reason}`);
  return entry.recovery;
};

describe('ArchiveMetadataService continuation checkpoints', () => {
  beforeEach(rejectUnstagedFetches);

  /** Real tenant-scoped state is shared by successive calls; downloads emulate conditional Range. */
  const source = (bytes: Uint8Array) => {
    const starts: number[] = [];
    const reads: number[] = [];
    fetchWithTimeout.mockImplementation(
      async (url: string, _timeout: number, _ctx: unknown, options: RequestInit) => {
        if (url.includes('/metadata/')) return textManifest(String(bytes.length));
        const headers = new Headers(options.headers);
        const range = headers.get('range');
        const start = range ? Number(range.slice(6, -1)) : 0;
        starts.push(start);
        const { response, stats } = streamedDownload((n) =>
          bytes.subarray(start + n, start + n + 1).length
            ? bytes.subarray(start + n, start + n + 1)
            : undefined,
        );
        reads.push(0);
        const index = reads.length - 1;
        const reader = response.body!.getReader();
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              const result = await reader.read();
              reads[index] = stats.pulls;
              if (result.done) controller.close();
              else controller.enqueue(result.value);
            },
            cancel: () => reader.cancel(),
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          status: range ? 206 : 200,
          headers: {
            etag: '"stable"',
            'content-length': String(bytes.length - start),
            ...(range && { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` }),
          },
        });
      },
    );
    return { starts, reads };
  };

  it('walks successive pages across surrogate, malformed, BOM and truncated units with bounded overlap', async () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('A📜Б\ufeff'),
      0xe2,
      0x41,
      0xed,
      0xa0,
      0x80,
      0xf0,
      0x9f,
    ]);
    const expected = new TextDecoder().decode(bytes);
    const { starts, reads } = source(bytes);
    const ctx = createMockContext({ errors: iaGetText.errors });
    const svc = buildService();
    let token: string | undefined;
    let offset = 0;
    for (let n = 0; n < expected.length; n++) {
      const page = await svc.getTextContent('a-volume', 1, 0, ctx, deadline(), {
        continuation: token,
      });
      expect(page.text, `page ${n}`).toBe(expected.slice(offset, offset + 1));
      expect(page.charOffset).toBe(offset);
      expect(page.hasMore).toBe(offset + 1 < expected.length);
      token = page.nextContinuation;
      offset++;
    }
    expect(token).toBeUndefined();
    expect(starts.slice(1).every((start) => start > 0)).toBe(true);
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(bytes.length * 4);
    const records = await ctx.state.list('ia-text/');
    expect(records.items.length).toBe(expected.length - 1);
    for (const record of records.items) {
      expect(record.value).not.toHaveProperty('text');
      expect(record.value).not.toHaveProperty('document');
    }
  });

  it('matches whole-file UTF-8 decoding over randomized malformed bytes and changing page sizes', async () => {
    const random = seededRandom(37);
    for (let fixture = 0; fixture < 30; fixture++) {
      const bytes = new Uint8Array(Array.from({ length: 100 }, () => Math.floor(random() * 256)));
      source(bytes);
      const expected = new TextDecoder().decode(bytes);
      const ctx = createMockContext();
      const svc = buildService();
      let token: string | undefined;
      let offset = 0;
      do {
        const count = 1 + Math.floor(random() * 7);
        const page = await svc.getTextContent('a-volume', count, 0, ctx, deadline(), {
          continuation: token,
        });
        expect(page.text).toBe(expected.slice(offset, offset + count));
        expect(page.hasMore).toBe(offset + count < expected.length);
        offset += count;
        token = page.nextContinuation;
      } while (token);
      expect(offset).toBeGreaterThanOrEqual(expected.length);
    }
  });

  it('expires serialized real-state records and rejects another tenant or item before downloading', async () => {
    vi.useFakeTimers();
    try {
      source(new TextEncoder().encode('abcdef'));
      const svc = buildService();
      const ctx = createMockContext({ tenantId: 'tenant-a' });
      const other = createMockContext({ tenantId: 'tenant-b' });
      const shared = createInMemoryStorage();
      for (const tenant of [ctx, other]) {
        tenant.state.get = async <T>(key: string, schema?: z.ZodType<T>): Promise<T | null> => {
          const value = await shared.get<T>(key, tenant);
          return value === null ? null : schema ? schema.parse(value) : value;
        };
        tenant.state.set = (key, value, options) => shared.set(key, value, tenant, options);
      }
      const first = await svc.getTextContent('a-volume', 2, 0, ctx, deadline());
      const token = first.nextContinuation!;
      const before = fetchWithTimeout.mock.calls.length;
      const resume = { continuation: token };
      await expect(
        svc.getTextContent('a-volume', 2, 0, other, deadline(), resume),
      ).rejects.toMatchObject({
        data: { reason: 'invalid_continuation' },
      });
      await expect(
        svc.getTextContent('other-item', 2, 0, ctx, deadline(), resume),
      ).rejects.toMatchObject({
        data: { reason: 'invalid_continuation' },
      });
      await vi.advanceTimersByTimeAsync(3_600_001);
      await expect(ctx.state.get(`ia-text/${token}`)).resolves.toBeNull();
      await expect(
        svc.getTextContent('a-volume', 2, 0, ctx, deadline(), resume),
      ).rejects.toMatchObject({
        data: { reason: 'invalid_continuation' },
      });
      expect(fetchWithTimeout.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Storage unavailable'), true],
    [new TypeError('programmer bug'), false],
    [new McpError(JsonRpcErrorCode.ValidationError, 'Bad stored schema'), false],
    [new DOMException('Cancelled', 'AbortError'), false],
  ])('degrades storage writes only on operational errors (%s)', async (error, degrades) => {
    source(new TextEncoder().encode('abcdef'));
    const ctx = createMockContext();
    vi.spyOn(ctx.state, 'set').mockRejectedValue(error);
    const pending = buildService().getTextContent('a-volume', 2, 0, ctx, deadline());
    if (degrades)
      await expect(pending).resolves.toMatchObject({
        text: 'ab',
        continuationNotice: expect.stringContaining('char_offset 2'),
      });
    else await expect(pending).rejects.toBe(error);
  });

  it('preserves the page when the real in-memory provider reaches its capacity', async () => {
    source(new TextEncoder().encode('abcdef'));
    const ctx = createMockContext();
    const storage = createInMemoryStorage({ maxEntries: 1 });
    await storage.set('occupied', true, ctx);
    // Delegate only this write to a real full provider; its quota is the behavior under test.
    vi.spyOn(ctx.state, 'set').mockImplementation((key, value, options) =>
      storage.set(key, value, ctx, options),
    );
    const page = await buildService().getTextContent('a-volume', 2, 0, ctx, deadline());
    expect(page.text).toBe('ab');
    expect(page.nextContinuation).toBeUndefined();
    expect(page.continuationNotice).toContain('char_offset 2');
  });

  it.each([
    [[], 'text file removed'],
    [[{ name: 'renamed.txt', format: 'Text', size: '6' }], 'selected file changed'],
    [
      [{ name: 'volume_djvu.txt', format: 'DjVuTXT', size: '6', md5: 'changed' }],
      'checksum changed',
    ],
  ])('rejects a changed manifest (%s) before a ranged download', async (files) => {
    source(new TextEncoder().encode('abcdef'));
    const ctx = createMockContext();
    const svc = buildService();
    const first = await svc.getTextContent('a-volume', 2, 0, ctx, deadline());
    fetchWithTimeout.mockResolvedValueOnce(jsonBody({ metadata: {}, files }));
    const before = fetchWithTimeout.mock.calls.length;
    await expect(
      svc.getTextContent('a-volume', 2, 0, ctx, deadline(), {
        continuation: first.nextContinuation,
      }),
    ).rejects.toMatchObject({ data: { reason: 'invalid_continuation', char_offset: 2 } });
    expect(fetchWithTimeout.mock.calls.length).toBe(before + 1);
  });

  /**
   * DjVuTXT volumes served by name with conditional Range, under a manifest listing `listed`
   * (every volume when omitted) in order. Returns the file name of each download, in order.
   */
  const volumes = (texts: Record<string, string>, listed = () => Object.keys(texts)) => {
    const bytes = new Map(Object.entries(texts).map(([n, t]) => [n, new TextEncoder().encode(t)]));
    const downloads: string[] = [];
    fetchWithTimeout.mockImplementation(
      async (url: string, _timeout: number, _ctx: unknown, options: RequestInit) => {
        if (url.includes('/metadata/')) {
          const files = listed().map((name) => ({
            name,
            format: 'DjVuTXT',
            size: String(bytes.get(name)?.length),
          }));
          return jsonBody({ metadata: {}, files });
        }
        const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
        downloads.push(name);
        const body = bytes.get(name) as Uint8Array;
        const range = new Headers(options.headers).get('range');
        const start = range ? Number(range.slice(6, -1)) : 0;
        return new Response(body.subarray(start), {
          status: range ? 206 : 200,
          headers: {
            etag: '"stable"',
            'content-length': String(body.length - start),
            ...(range && { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` }),
          },
        });
      },
    );
    return downloads;
  };

  it('continues a named non-default file page after page with file omitted', async () => {
    const downloads = volumes({
      'Vol 01_djvu.txt': 'first volume',
      'Vol 02_djvu.txt': 'Глава 📜 two',
    });
    const ctx = createMockContext();
    const svc = buildService();
    let page = await svc.getTextContent('strabo', 3, 0, ctx, deadline(), {
      file: 'Vol 02_djvu.txt',
    });
    const pages = [page];
    while (page.nextContinuation) {
      page = await svc.getTextContent('strabo', 3, 0, ctx, deadline(), {
        continuation: page.nextContinuation,
      });
      pages.push(page);
    }

    expect(pages.map((p) => p.text).join('')).toBe('Глава 📜 two');
    expect(pages).toHaveLength(4);
    expect(pages.map((p) => p.charOffset)).toEqual([0, 3, 6, 9]);
    expect(pages.every((p) => p.sourceFile === 'Vol 02_djvu.txt')).toBe(true);
    expect(pages.some((p) => 'textFiles' in p)).toBe(false);
    expect(downloads).toEqual(pages.map(() => 'Vol 02_djvu.txt'));
  });

  it('continues the default pick without a textFiles summary after its first page', async () => {
    volumes({ 'Vol 01_djvu.txt': 'first volume', 'Vol 02_djvu.txt': 'second volume' });
    const ctx = createMockContext();
    const svc = buildService();
    const first = await svc.getTextContent('strabo', 5, 0, ctx, deadline());
    const second = await svc.getTextContent('strabo', 5, 0, ctx, deadline(), {
      continuation: first.nextContinuation,
    });

    expect(first).toMatchObject({ sourceFile: 'Vol 01_djvu.txt', textFiles: { count: 2 } });
    expect(second).toMatchObject({ sourceFile: 'Vol 01_djvu.txt', text: ' volu' });
    expect(second).not.toHaveProperty('textFiles');
  });

  it('accepts a file naming the file its continuation reads', async () => {
    volumes({ 'Vol 01_djvu.txt': 'first volume', 'Vol 02_djvu.txt': 'second volume' });
    const ctx = createMockContext();
    const svc = buildService();
    const file = 'Vol 02_djvu.txt';
    const first = await svc.getTextContent('strabo', 6, 0, ctx, deadline(), { file });
    const second = await svc.getTextContent('strabo', 6, 0, ctx, deadline(), {
      continuation: first.nextContinuation,
      file,
    });

    expect(second).toMatchObject({ text: ' volum', charOffset: 6, sourceFile: file });
  });

  it('rejects a file other than the continuation reads as invalid_continuation, before any request', async () => {
    volumes({ 'Vol 01_djvu.txt': 'first volume', 'Vol 02_djvu.txt': 'second volume' });
    const ctx = createMockContext({ errors: iaGetText.errors });
    const svc = buildService();
    const first = await svc.getTextContent('strabo', 6, 0, ctx, deadline(), {
      file: 'Vol 02_djvu.txt',
    });
    const before = fetchWithTimeout.mock.calls.length;

    await expect(
      svc.getTextContent('strabo', 6, 0, ctx, deadline(), {
        continuation: first.nextContinuation,
        file: 'Vol 01_djvu.txt',
      }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'The continuation reads "Vol 02_djvu.txt", but this call names "Vol 01_djvu.txt".',
      data: {
        reason: 'invalid_continuation',
        char_offset: 0,
        file: 'Vol 02_djvu.txt',
        recovery: { hint: expect.stringContaining('read "Vol 01_djvu.txt"') },
      },
    });
    expect(fetchWithTimeout.mock.calls.length).toBe(before);
  });

  it('keeps reading the continuation file after the manifest lists another DjVuTXT file before it', async () => {
    let listed = ['Vol 02_djvu.txt'];
    const downloads = volumes(
      { 'Vol 01_djvu.txt': 'first volume', 'Vol 02_djvu.txt': 'second volume' },
      () => listed,
    );
    const ctx = createMockContext();
    const svc = buildService();
    const first = await svc.getTextContent('strabo', 6, 0, ctx, deadline());
    listed = ['Vol 01_djvu.txt', 'Vol 02_djvu.txt'];
    const second = await svc.getTextContent('strabo', 6, 0, ctx, deadline(), {
      continuation: first.nextContinuation,
    });

    expect(first.sourceFile).toBe('Vol 02_djvu.txt');
    expect(second).toMatchObject({ text: ' volum', sourceFile: 'Vol 02_djvu.txt' });
    expect(downloads).toEqual(['Vol 02_djvu.txt', 'Vol 02_djvu.txt']);
  });
});

const encoder = new TextEncoder();

/** `n` UTF-16 units of 2- and 3-byte UTF-8 filler holding no Latin letter, so no phrase matches in it. */
const filler = (n: number): string => {
  const unit = 'Глава 第一章 — ж\n';
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
};

/** UTF-8 byte offset of UTF-16 offset `at` in `text`; between two surrogates, of the pair's start. */
const byteAt = (text: string, at: number): number => {
  const unit = text.charCodeAt(at);
  return encoder.encode(text.slice(0, unit >= 0xdc00 && unit <= 0xdfff ? at - 1 : at)).length;
};

/**
 * The first offset at or after `from` where the `iu` regex engine matches `find`, each
 * White_Space run of it read as `\p{White_Space}+`: an oracle independent of the matcher.
 */
const firstMatch = (text: string, find: string, from = 0): number | undefined => {
  const pattern = find
    .split(/\p{White_Space}+/u)
    .filter(Boolean)
    .map((word) => word.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'))
    .join('\\p{White_Space}+');
  const regex = new RegExp(pattern, 'giu');
  regex.lastIndex = from;
  return regex.exec(text)?.index;
};

const splitEvery = (bytes: Uint8Array, size: number): Uint8Array[] =>
  Array.from({ length: Math.ceil(bytes.length / size) }, (_, k) =>
    bytes.subarray(k * size, (k + 1) * size),
  );

/** One download a test served: its Range start byte, the chunks pulled, and whether it was cancelled. */
interface Download {
  cancelled: boolean;
  pulls: number;
  start: number;
}

/** What a pull does instead of serving the next chunk: never answer, end the body, or error it. */
type PullAction = 'stall' | 'close' | { error: unknown } | undefined;

interface SourceOptions {
  /** The chunks of download `n`'s body (from its Range start); 1 KiB each when omitted. */
  chunks?: (body: Uint8Array, n: number) => Uint8Array[];
  /** The ETag header; `null` sends none. */
  etag?: string | null;
  /** The manifest's files; one DjVuTXT file `volume_djvu.txt` of the text's size when omitted. */
  files?: { format: string; name: string; size: string }[];
  /** Consulted on pull `pull` (0-based) of download `n` (0-based), before it serves a chunk. */
  onPull?: (n: number, pull: number) => PullAction;
}

/** Serve `text` as every download, honoring conditional Range, one chunk per pull. */
const findSource = (text: string, options: SourceOptions = {}): Download[] => {
  const bytes = encoder.encode(text);
  const etag = options.etag === undefined ? '"stable"' : options.etag;
  const downloads: Download[] = [];
  fetchWithTimeout.mockImplementation(
    async (url: string, _timeout: number, _ctx: unknown, init: RequestInit) => {
      if (url.includes('/metadata/')) {
        return jsonBody({
          metadata: { title: 'A Volume' },
          files: options.files ?? [
            { name: 'volume_djvu.txt', format: 'DjVuTXT', size: String(bytes.length) },
          ],
        });
      }
      const range = new Headers(init.headers).get('range');
      const start = range ? Number(range.slice(6, -1)) : 0;
      const body = bytes.subarray(start);
      const download: Download = { start, pulls: 0, cancelled: false };
      const n = downloads.push(download) - 1;
      const chunks = options.chunks ? options.chunks(body, n) : splitEvery(body, 1_024);
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const pull = download.pulls++;
            const action = options.onPull?.(n, pull);
            if (action === 'stall') return new Promise<void>(() => {});
            if (action === 'close') return controller.close();
            if (action) return controller.error(action.error);
            const chunk = chunks[pull];
            if (chunk === undefined) controller.close();
            else controller.enqueue(chunk);
          },
          cancel() {
            download.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, {
        status: range ? 206 : 200,
        headers: {
          ...(etag !== null && { etag }),
          'content-length': String(body.length),
          ...(range && { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` }),
        },
      });
    },
  );
  return downloads;
};

/** One `getTextContent` call on `a-volume`; pass the same `ctx` to calls that share continuations. */
const readText = (
  maxChars: number,
  charOffset: number,
  selection: TextSelection,
  ctx = createMockContext({ errors: iaGetText.errors }),
) => buildService().getTextContent('a-volume', maxChars, charOffset, ctx, deadline(), selection);

/** The message `find_incomplete` carries when the search ruled text out up to `resume`. */
const searchStopped = (file: string, start: number, resume: number): string =>
  `The search of "${file}" stopped before the download's request timeout or the call deadline could cut it off. No match begins from char_offset ${start} up to char_offset ${resume}, where the search resumes.`;

/** The `find_incomplete` hint when the search advanced to `resume` but no cursor was stored, `because`. */
const offsetResume = (resume: number, because: string): string =>
  `Call again with the same find and char_offset ${resume}. That call reads the file from its first byte, so it searches past char_offset ${resume} only if the download runs faster than this one did; no continuation is available because ${because}.`;

/** The message of a search that could not get past its start, `start`, before the stop. */
const searchStalled = (file: string, start: number): string =>
  `The download of "${file}" was too slow to search past char_offset ${start} before its request timeout or the call deadline would have cut it off.`;

describe('ArchiveMetadataService.getTextContent find: hits and misses', () => {
  beforeEach(rejectUnstagedFetches);

  /** Excerpts of prideprejudice00aust_djvu.txt at their offsets in that file, between non-ASCII filler. */
  const prideText = [
    filler(15_912),
    'Mr.  Darcy',
    filler(25_000 - 15_912 - 10),
    'P  ember  ley',
    filler(29_475 - 25_000 - 13),
    'PEMBERLEY',
    filler(2_000),
    'Pem- \nberley',
    filler(500),
  ].join('');
  const prideBytes = encoder.encode(prideText).length;

  it.each([
    ['Mr. Darcy', 15_912],
    ['PEMBERLEY', 29_475],
    ['pemberley', 29_475],
  ])(
    'serves the page at the first match of %j (%i) as the page read there without find',
    async (find, at) => {
      expect(firstMatch(prideText, find)).toBe(at);
      findSource(prideText, { chunks: (body) => splitBytes(body, 700, seededRandom(at)) });
      const ctx = createMockContext({ errors: iaGetText.errors });

      const hit = await readText(400, 0, { find }, ctx);
      const plain = await readText(400, at, {}, ctx);

      expect(hit.matchOffset).toBe(at);
      expect({ ...hit, matchOffset: undefined, nextContinuation: undefined }).toEqual({
        ...plain,
        nextContinuation: undefined,
      });
      expect(hit).toMatchObject({
        charOffset: at,
        text: prideText.slice(at, at + 400),
        hasMore: true,
        sourceFile: 'volume_djvu.txt',
        sourceFileBytes: prideBytes,
        nextContinuation: expect.any(String),
      });
      const next = await readText(400, 0, { continuation: hit.nextContinuation }, ctx);
      expect(next).toMatchObject({
        charOffset: at + 400,
        text: prideText.slice(at + 400, at + 800),
      });
    },
  );

  it('matches neither "P  ember  ley" nor "Pem- \\nberley": a search past the last whole match misses', async () => {
    expect(firstMatch(prideText, 'Pemberley', 29_476)).toBeUndefined();
    findSource(prideText);

    const miss = await readText(400, 29_476, { find: 'Pemberley' });

    expect(miss).toEqual({
      text: '',
      hasMore: false,
      charOffset: 29_476,
      maxChars: 400,
      sourceFile: 'volume_djvu.txt',
      sourceFileBytes: prideBytes,
    });
  });

  it.each([9, 100])(
    'serves a match on the last characters of the file with has_more false (max_chars %i)',
    async (maxChars) => {
      const text = `${filler(3_000)}PEMBERLEY`;
      findSource(text);

      const hit = await readText(maxChars, 0, { find: 'Pemberley' });

      expect(hit).toEqual({
        text: 'PEMBERLEY',
        hasMore: false,
        charOffset: 3_000,
        matchOffset: 3_000,
        maxChars,
        sourceFile: 'volume_djvu.txt',
        sourceFileBytes: encoder.encode(text).length,
      });
    },
  );

  it('answers a miss on a default pick among two files with an empty page at the search start and its textFiles', async () => {
    const text = `${filler(400)}Pemberley`;
    const size = String(encoder.encode(text).length);
    findSource(text, {
      files: [
        { name: 'Vol 01_djvu.txt', format: 'DjVuTXT', size },
        { name: 'Vol 02_djvu.txt', format: 'DjVuTXT', size },
      ],
    });

    const plain = await readText(50, 120, {});
    const miss = await readText(50, 120, { find: 'Darcy' });

    expect(plain.textFiles).toMatchObject({ count: 2 });
    expect(miss).toEqual({
      text: '',
      hasMore: false,
      charOffset: 120,
      maxChars: 50,
      sourceFile: 'Vol 01_djvu.txt',
      sourceFileBytes: Number(size),
      textFiles: plain.textFiles,
    });
  });

  it.each(['', ' ', ' \n\t　  '])(
    'reads a find of only White_Space (%j) as no find',
    async (find) => {
      findSource(`${filler(400)}Pemberley`);
      const ctx = createMockContext({ errors: iaGetText.errors });

      const plain = await readText(50, 120, {}, ctx);
      const blank = await readText(50, 120, { find }, ctx);

      expect(blank).not.toHaveProperty('matchOffset');
      expect(blank.nextContinuation).toEqual(expect.any(String));
      expect({ ...blank, nextContinuation: undefined }).toEqual({
        ...plain,
        nextContinuation: undefined,
      });
    },
  );

  it('counts UTF-16 units to a match after İ, ß, ﬁ, and astral characters', async () => {
    const text = 'İstanbul Straße ﬁnal 🦉 𝄞 İ ß ﬁ x PEMBERLEY end';
    const at = text.indexOf('PEMBERLEY');
    findSource(text, { chunks: (body) => splitEvery(body, 5) });

    const hit = await readText(12, 0, { find: 'pemberley' });

    expect(hit).toMatchObject({ matchOffset: at, charOffset: at, text: text.slice(at, at + 12) });
  });

  it('finds the same match and page wherever the body splits, inside the match or a multi-byte character before it', async () => {
    const text = 'Глава 🦉 ж Mr. \n Darcy, and more text';
    const at = text.indexOf('Mr.');
    const expected = { matchOffset: at, text: text.slice(at, at + 15) };
    const bytes = encoder.encode(text);
    const first = byteAt(text, text.indexOf('🦉'));
    const last = byteAt(text, text.indexOf(','));
    for (let split = first; split <= last; split++) {
      findSource(text, {
        chunks: (body) => [bytes.subarray(0, split), body.subarray(split)],
      });
      const hit = await readText(15, 0, { find: 'MR. DARCY' });
      expect({ matchOffset: hit.matchOffset, text: hit.text }, `split at byte ${split}`).toEqual(
        expected,
      );
    }
    findSource(text, { chunks: (body) => splitEvery(body, 1) });
    const hit = await readText(15, 0, { find: 'MR. DARCY' });
    expect({ matchOffset: hit.matchOffset, text: hit.text }, 'one byte per chunk').toEqual(
      expected,
    );
  });

  it('stops the download at the chunk holding the character after the page, as the read without find does', async () => {
    const at = 600 * 1_024;
    const text = `${'x'.repeat(at)}Pemberley${'y'.repeat(600 * 1_024)}`;
    const downloads = findSource(text);

    const hit = await readText(2_000, 0, { find: 'Pemberley' });
    await readText(2_000, at, {});

    // The character after the page, at offset `at` + 2,000, is in 1 KiB chunk 601 (0-based).
    const pulls = Math.floor((at + 2_000) / 1_024) + 1;
    expect(hit).toMatchObject({ matchOffset: at, text: text.slice(at, at + 2_000) });
    expect(downloads).toEqual([
      { start: 0, pulls, cancelled: true },
      { start: 0, pulls, cancelled: true },
    ]);
  });
});

describe('ArchiveMetadataService.getTextContent find with a continuation', () => {
  beforeEach(rejectUnstagedFetches);

  const variants = [
    'Mr. Darcy',
    'MR.  DARCY',
    'mr.\ndarcy',
    'Mr.　Darcy',
    'Mr. \r\n Darcy',
    'Mr.Darcy',
    'Mr. Darcey',
  ];
  const random = seededRandom(70);
  const walkText = Array.from(
    { length: 80 },
    () =>
      filler(Math.floor(random() * 40)) +
      variants[Math.floor(random() * variants.length)] +
      (random() < 0.3 ? '🦉' : ''),
  ).join('');

  it.each([5, 12, 30, 200])(
    'walks every match a search from each page end reaches, by ranged reads from there (max_chars %i)',
    async (maxChars) => {
      const downloads = findSource(walkText, {
        chunks: (body) => splitBytes(body, 48, seededRandom(maxChars)),
      });
      const ctx = createMockContext({ errors: iaGetText.errors });
      const find = 'mr. darcy';
      const expected: number[] = [];
      for (
        let at = firstMatch(walkText, find);
        at !== undefined;
        at = firstMatch(walkText, find, at + maxChars)
      )
        expected.push(at);

      const found: number[] = [];
      let page = await readText(maxChars, 0, { find }, ctx);
      while (page.matchOffset !== undefined) {
        found.push(page.matchOffset);
        expect(page.text).toBe(walkText.slice(page.matchOffset, page.matchOffset + maxChars));
        if (!page.nextContinuation) break;
        page = await readText(maxChars, 0, { find, continuation: page.nextContinuation }, ctx);
      }

      expect(expected.length).toBeGreaterThan(10);
      expect(found).toEqual(expected);
      expect(downloads.map((d) => d.start)).toEqual([
        0,
        ...found.slice(0, downloads.length - 1).map((at) => byteAt(walkText, at + maxChars)),
      ]);
    },
  );

  it.each([
    [5, 'at the start of the run'],
    [6, 'after U+3000'],
    [7, 'after U+3000 and a space'],
    [8, 'after the whole run'],
  ])('continues after a hit whose page of %i ends inside its match, %s', async (maxChars) => {
    const text = `${filler(30)}alpha　 \nbeta${filler(30)}alpha beta${filler(30)}`;
    const downloads = findSource(text, {
      chunks: (body) => splitBytes(body, 3, seededRandom(maxChars)),
    });
    const ctx = createMockContext({ errors: iaGetText.errors });
    const next = 30 + maxChars;

    const hit = await readText(maxChars, 0, { find: 'alpha beta' }, ctx);
    const page = await readText(maxChars, 0, { continuation: hit.nextContinuation }, ctx);
    const second = await readText(
      maxChars,
      0,
      { find: 'alpha beta', continuation: hit.nextContinuation },
      ctx,
    );

    expect(hit).toMatchObject({ matchOffset: 30, text: text.slice(30, next), hasMore: true });
    expect(page).toMatchObject({ charOffset: next, text: text.slice(next, next + maxChars) });
    expect(second.matchOffset).toBe(firstMatch(text, 'alpha beta', next));
    expect(downloads.map((d) => d.start)).toEqual([0, byteAt(text, next), byteAt(text, next)]);
  });

  it.each([
    ['U+00A0', 0xa0],
    ['U+0085', 0x85],
  ])(
    'continues after a hit whose page ends inside its run of two-byte White_Space (%s)',
    async (_label, codePoint) => {
      const space = String.fromCodePoint(codePoint);
      const text = `xx a${space.repeat(5)}b tail text`;
      const downloads = findSource(text);
      const ctx = createMockContext({ errors: iaGetText.errors });

      const hit = await readText(3, 0, { find: 'a b' }, ctx);
      const page = await readText(5, 0, { continuation: hit.nextContinuation }, ctx);

      expect(hit).toMatchObject({ matchOffset: 3, charOffset: 3, text: `a${space.repeat(2)}` });
      expect(page).toMatchObject({ charOffset: 6, text: `${space.repeat(3)}b ` });
      // The checkpoint counts two bytes for each of the two held run characters: byte 8.
      expect(downloads.map((d) => d.start)).toEqual([0, 8]);
    },
  );

  it('continues after a hit whose page ends between the surrogates of an astral character in its match', async () => {
    const text = `${filler(20)}ab📜cd${filler(20)}AB📜CD${filler(10)}`;
    const downloads = findSource(text, { chunks: (body) => splitEvery(body, 2) });
    const ctx = createMockContext({ errors: iaGetText.errors });

    const hit = await readText(3, 0, { find: 'ab📜cd' }, ctx);
    const page = await readText(3, 0, { continuation: hit.nextContinuation }, ctx);
    const second = await readText(
      3,
      0,
      { find: 'ab📜cd', continuation: hit.nextContinuation },
      ctx,
    );

    expect(hit).toMatchObject({ matchOffset: 20, text: 'ab\ud83d', hasMore: true });
    expect(page).toMatchObject({ charOffset: 23, text: '\udcdccd' });
    expect(second.matchOffset).toBe(firstMatch(text, 'ab📜cd', 23));
    expect(downloads.map((d) => d.start)).toEqual([0, byteAt(text, 23), byteAt(text, 23)]);
  });
});

describe('ArchiveMetadataService.getTextContent find_incomplete', () => {
  beforeEach(() => {
    rejectUnstagedFetches();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Read with `find`, download 0 stalling once it has delivered `stallAfter` bytes and every
   * later download serving the whole text; then run the clock to 28.99 s and to 29 s.
   */
  const stalledRead = async (
    text: string,
    stallAfter: number,
    charOffset: number,
    {
      ctx = createMockContext({ errors: iaGetText.errors }),
      etag,
    }: { ctx?: ReturnType<typeof createMockContext>; etag?: string | null } = {},
  ) => {
    const prefixChunks = Math.ceil(stallAfter / 512);
    let reachStall!: () => void;
    const stalled = new Promise<void>((resolve) => {
      reachStall = resolve;
    });
    const downloads = findSource(text, {
      etag,
      chunks: (body, n) => splitEvery(n === 0 ? body.subarray(0, stallAfter) : body, 512),
      onPull: (n, pull) => {
        if (n !== 0 || pull < prefixChunks) return;
        reachStall();
        return 'stall';
      },
    });
    const settled = vi.fn();
    const pending = readText(400, charOffset, { find: 'Pemberley' }, ctx);
    pending.then(settled, settled);
    await stalled;
    await vi.advanceTimersByTimeAsync(28_990);
    const settledEarly = settled.mock.calls.length > 0;
    await vi.advanceTimersByTimeAsync(10);
    const error = (await pending.catch((err: unknown) => err)) as McpError;
    return { ctx, downloads, error, settledEarly };
  };

  it.each([
    ['the live candidate is the first match', `${filler(5_000)}Pemberley${filler(1_000)}`],
    [
      'the live candidate fails and a later one matches',
      `${filler(5_000)}Pemberton${filler(3_000)}Pemberley${filler(1_000)}`,
    ],
  ])(
    'stops a stalled body at 29 s at the live partial match and resumes to the uninterrupted first match (%s)',
    async (_, text) => {
      const { ctx, downloads, error, settledEarly } = await stalledRead(
        text,
        byteAt(text, 5_006),
        0,
      );

      expect(settledEarly).toBe(false);
      expect(error).toBeInstanceOf(McpError);
      const token = error.data?.next_continuation as string;
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: searchStopped('volume_djvu.txt', 0, 5_000),
        data: {
          reason: 'find_incomplete',
          char_offset: 5_000,
          next_continuation: expect.any(String),
          recovery: { hint: `Call again with the same find and continuation ${token}.` },
        },
      });
      expect(error.data).not.toHaveProperty('retryable');
      expect(downloads[0]?.cancelled).toBe(true);

      const resumed = await readText(400, 0, { find: 'Pemberley', continuation: token }, ctx);
      const byOffset = await readText(400, 5_000, { find: 'Pemberley' }, ctx);
      const whole = await readText(400, 0, { find: 'Pemberley' }, ctx);

      const at = firstMatch(text, 'Pemberley') as number;
      expect(whole).toMatchObject({ matchOffset: at, text: text.slice(at, at + 400) });
      for (const page of [resumed, byOffset]) {
        expect({ ...page, nextContinuation: undefined }).toEqual({
          ...whole,
          nextContinuation: undefined,
        });
      }
      expect(downloads.map((d) => d.start)).toEqual([0, byteAt(text, 5_000), 0, 0]);
    },
  );

  it('stops at the chunk whose read finds the clock past the stop, with no timer firing', async () => {
    const text = `${'x'.repeat(40 * 1_024)}Pemberley`;
    const downloads = findSource(text, {
      onPull: () => {
        vi.setSystemTime(Date.now() + 1_000);
      },
    });

    const error = (await readText(400, 0, { find: 'Pemberley' }).catch(
      (err: unknown) => err,
    )) as McpError;

    // Pull k moves the clock to k s; the stop is at 29 s, after the 29th 1 KiB chunk.
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: searchStopped('volume_djvu.txt', 0, 29 * 1_024),
      data: { reason: 'find_incomplete', char_offset: 29 * 1_024 },
    });
    expect(downloads).toEqual([{ start: 0, pulls: 29, cancelled: true }]);
  });

  it('carries no next_continuation when the download has no ETag', async () => {
    const text = `${filler(5_000)}Pemberley`;
    const { error, settledEarly } = await stalledRead(text, byteAt(text, 5_006), 0, {
      etag: null,
    });

    expect(settledEarly).toBe(false);
    expect(error.data).not.toHaveProperty('next_continuation');
    expect(error.data).toMatchObject({
      reason: 'find_incomplete',
      char_offset: 5_000,
      recovery: {
        hint: offsetResume(5_000, 'the download lacks a stable identity validator or byte length'),
      },
    });
  });

  it('carries no next_continuation when cursor storage is unavailable', async () => {
    const text = `${filler(5_000)}Pemberley`;
    const ctx = createMockContext({ errors: iaGetText.errors });
    vi.spyOn(ctx.state, 'set').mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Storage unavailable'),
    );
    const { error } = await stalledRead(text, byteAt(text, 5_006), 0, { ctx });

    expect(error.data).not.toHaveProperty('next_continuation');
    expect(error.data).toMatchObject({
      char_offset: 5_000,
      recovery: { hint: offsetResume(5_000, 'cursor storage could not be reached') },
    });
  });

  /** `archive_unavailable` with the declared hint and no other field: no offset, cursor, or resume recipe. */
  const expectStalled = (error: McpError, start: number) => {
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: searchStalled('volume_djvu.txt', start),
      data: {
        reason: 'archive_unavailable',
        recovery: { hint: declaredRecovery(iaGetText.errors, 'archive_unavailable') },
      },
    });
    expect(Object.keys(error.data ?? {}).sort()).toEqual(['reason', 'recovery']);
  };

  it('fails as archive_unavailable, naming the offset, when an offset read stalls before reaching it', async () => {
    const text = `${filler(12_000)}Pemberley`;
    const { downloads, error, settledEarly } = await stalledRead(text, byteAt(text, 2_000), 10_000);

    expect(settledEarly).toBe(false);
    expectStalled(error, 10_000);
    expect(downloads).toHaveLength(1);
  });

  it('fails as archive_unavailable, storing no cursor, when a read from char_offset 0 stalls before any text', async () => {
    const ctx = createMockContext({ errors: iaGetText.errors });
    const set = vi.spyOn(ctx.state, 'set');
    const { downloads, error } = await stalledRead(`${filler(5_000)}Pemberley`, 0, 0, { ctx });

    // A cursor at byte 0 would name a ranged read of the very bytes this read waited on.
    expectStalled(error, 0);
    expect(set).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(1);
  });

  it("fails as archive_unavailable, storing no cursor, when a continuation's ranged read stalls before any text", async () => {
    const text = `${filler(5_000)}Pemberley${filler(1_000)}`;
    const downloads = findSource(text, { onPull: (n) => (n === 1 ? 'stall' : undefined) });
    const ctx = createMockContext({ errors: iaGetText.errors });
    const hit = await readText(400, 0, { find: 'Pemberley' }, ctx);
    const set = vi.spyOn(ctx.state, 'set');

    const pending = readText(
      400,
      0,
      { find: 'Pemberley', continuation: hit.nextContinuation },
      ctx,
    ).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(29_000);

    expectStalled((await pending) as McpError, 5_400);
    expect(set).not.toHaveBeenCalled();
    expect(downloads.map((d) => d.start)).toEqual([0, byteAt(text, 5_400)]);
  });

  it('names only the continuation when an offset read stops at its char_offset: the cursor skips the bytes before it', async () => {
    const text = `${filler(10_000)}Pemberley${filler(500)}`;
    const { ctx, downloads, error } = await stalledRead(text, byteAt(text, 10_006), 10_000);

    const token = error.data?.next_continuation as string;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message:
        'The search of "volume_djvu.txt" stopped before the download\'s request timeout or the call deadline could cut it off, before ruling out a match at char_offset 10000.',
      data: {
        reason: 'find_incomplete',
        char_offset: 10_000,
        next_continuation: expect.any(String),
        recovery: { hint: `Call again with the same find and continuation ${token}.` },
      },
    });
    const resumed = await readText(400, 0, { find: 'Pemberley', continuation: token }, ctx);
    expect(resumed).toMatchObject({ matchOffset: 10_000, text: text.slice(10_000, 10_400) });
    expect(downloads.map((d) => d.start)).toEqual([0, byteAt(text, 10_000)]);
  });
});

describe('ArchiveMetadataService.getTextContent find: held text', () => {
  beforeEach(rejectUnstagedFetches);

  it('fails as resumable find_incomplete at the match when whitespace outran the held text before it', async () => {
    const text = `a${' '.repeat(20)}a${' '.repeat(20)}a b`;
    expect(firstMatch(text, 'a a b')).toBe(21);
    const downloads = findSource(text);
    const ctx = createMockContext({ errors: iaGetText.errors });

    const error = (await readText(1, 0, { find: 'a a b' }, ctx).catch(
      (err: unknown) => err,
    )) as McpError;

    const token = error.data?.next_continuation as string;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message:
        'The first match of find in "volume_djvu.txt" begins at char_offset 21, but this call could not return the page there: a whitespace run longer than the text one call holds came before the match.',
      data: {
        reason: 'find_incomplete',
        char_offset: 21,
        next_continuation: expect.any(String),
        recovery: { hint: `Call again with the same find and continuation ${token}.` },
      },
    });
    const byOffset = await readText(1, 21, { find: 'a a b' }, ctx);
    const resumed = await readText(1, 0, { find: 'a a b', continuation: token }, ctx);
    for (const page of [byOffset, resumed]) {
      expect(page).toMatchObject({ matchOffset: 21, charOffset: 21, text: 'a', hasMore: true });
    }
    expect(downloads.map((d) => d.start)).toEqual([0, 0, 21]);
  });

  it('names char_offset at the match with no cursor, and that call serves the page a plain read there does', async () => {
    const text = `a${' '.repeat(20)}a${' '.repeat(20)}a b`;
    const downloads = findSource(text, { etag: null });
    const ctx = createMockContext({ errors: iaGetText.errors });

    const error = (await readText(1, 0, { find: 'a a b' }, ctx).catch(
      (err: unknown) => err,
    )) as McpError;
    const recovered = await readText(1, 21, { find: 'a a b' }, ctx);
    const plain = await readText(1, 21, {}, ctx);

    expect(error.data).toEqual({
      reason: 'find_incomplete',
      char_offset: 21,
      recovery: { hint: 'Call again with the same find and char_offset 21.' },
    });
    // The search starts at the match itself, so no candidate before it can let its text go.
    expect(recovered).toEqual({ ...plain, matchOffset: 21 });
    expect(downloads.map((d) => d.start)).toEqual([0, 0, 0]);
  });

  it('serves the page directly when the whitespace before the match fits the held text', async () => {
    const text = `a${' '.repeat(3)}a${' '.repeat(3)}a b`;
    expect(firstMatch(text, 'a a b')).toBe(4);
    findSource(text);

    const hit = await readText(1, 0, { find: 'a a b' });

    expect(hit).toMatchObject({ matchOffset: 4, text: 'a', hasMore: true });
  });
});

describe('ArchiveMetadataService.getTextContent find under caller cancellation', () => {
  beforeEach(rejectUnstagedFetches);
  afterEach(() => {
    vi.useRealTimers();
  });

  const text = `${filler(6_000)}Pemberley`;

  it('rejects with the abort reason when the body ends at the cancellation, never a miss', async () => {
    const controller = new AbortController();
    const reason = new DOMException('The operation was aborted.', 'AbortError');
    findSource(text, {
      onPull: (_, pull) => {
        if (pull < 3) return;
        controller.abort(reason);
        return 'close';
      },
    });
    const ctx = createMockContext({ errors: iaGetText.errors, signal: controller.signal });

    await expect(readText(400, 0, { find: 'Pemberley' }, ctx)).rejects.toBe(reason);
  });

  it('rejects with the abort reason when the cancellation lands on a stalled body, never find_incomplete', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new DOMException('The operation was aborted.', 'AbortError');
    // No ETag, so no cursor write: the cancellation check alone stands between the stop and find_incomplete.
    findSource(text, {
      etag: null,
      onPull: (_, pull) => {
        if (pull < 3) return;
        controller.abort(reason);
        return 'stall';
      },
    });
    const ctx = createMockContext({ errors: iaGetText.errors, signal: controller.signal });

    const pending = readText(400, 0, { find: 'Pemberley' }, ctx);
    const outcome = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(29_000);
    await outcome;
  });

  it('propagates the error the body raises on the cancellation, as the read without find does', async () => {
    const controller = new AbortController();
    // What fetchWithTimeout's body raises once the caller's signal aborts mid-stream.
    const cancelled = new McpError(JsonRpcErrorCode.RequestCancelled, 'The download was aborted.', {
      errorSource: 'FetchAborted',
    });
    findSource(text, {
      onPull: (_, pull) => {
        if (pull < 3) return;
        controller.abort();
        return { error: cancelled };
      },
    });
    const ctx = createMockContext({ errors: iaGetText.errors, signal: controller.signal });

    await expect(readText(400, 0, { find: 'Pemberley' }, ctx)).rejects.toBe(cancelled);
  });
});

describe('ArchiveMetadataService.getTextContent find time', () => {
  /** CPU ceiling per call: 1 µs per character, the download's decoding included. */
  const MAX_CPU_MS_PER_CHAR = 0.001;

  /** The phrase grows with the input, doubling with it to the 500-character limit at 320k. */
  const phraseLength = (n: number) => Math.min(500, Math.floor(n / 640));

  const WORST_CASES: [string, (n: number) => { text: string; find: string }][] = [
    [
      'one letter repeated, then another, against a run of the first',
      (n) => ({ text: 'a'.repeat(n), find: `${'a'.repeat(phraseLength(n) - 1)}b` }),
    ],
    [
      'single letters separated by spaces against those letters separated by blank lines',
      (n) => ({
        text: 'a\n\n'.repeat(Math.ceil(n / 3)),
        find: `${'a '.repeat(Math.floor(phraseLength(n) / 2) - 1)}b`,
      }),
    ],
    [
      'one long line ending in a break',
      (n) => ({
        text: `${'§1 x'.repeat(Math.ceil(n / 4))}\ny`,
        find: `${'§1 x'.repeat(Math.floor(phraseLength(n) / 4) - 1)}§1 y`,
      }),
    ],
    [
      'breaks throughout',
      (n) => ({
        text: '  \r\n'.repeat(Math.ceil(n / 4)),
        find: `${'x '.repeat(Math.floor(phraseLength(n) / 2) - 1)}y`,
      }),
    ],
  ];

  /** What the staged fetch serves: the manifest body and the download's bytes, in one chunk. */
  let served: { bytes: Uint8Array; manifest: string };
  beforeEach(() => {
    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockImplementation(async (url: string) =>
      url.includes('/metadata/')
        ? ({ text: async () => served.manifest } as Response)
        : new Response(served.bytes),
    );
  });

  /** One search of `text` for `find` through the service, a miss; build the input outside the timing. */
  const searchCall = ({ text, find }: { text: string; find: string }) => {
    const bytes = encoder.encode(text);
    const input = {
      bytes,
      manifest: JSON.stringify({
        metadata: {},
        files: [{ name: 'volume_djvu.txt', format: 'DjVuTXT', size: String(bytes.length) }],
      }),
    };
    const service = buildService();
    const ctx = createMockContext();
    return () => {
      served = input;
      return service.getTextContent('a-volume', 1_000, 0, ctx, deadline(), { find });
    };
  };

  it.each(WORST_CASES)(
    'searches %s in linear time',
    async (_name, build) => {
      // No request spacing on this path, so a sample may batch calls like a synchronous one.
      await expectLinearDoubling(
        (n) => searchCall(build(n)),
        MAX_CPU_MS_PER_CHAR,
        async (large) => expect((await large()).matchOffset).toBeUndefined(),
      );
    },
    0,
  );
});

describe('ArchiveMetadataService service-thrown reasons carry the caller’s recovery hint', () => {
  beforeEach(rejectUnstagedFetches);

  const callers = [
    ['ia_get_item', iaGetItem.errors],
    ['ia_get_text', iaGetText.errors],
    ['ia://item/{identifier}', iaItemResource.errors],
  ] as const;

  describe.each(callers)('item_not_found under the %s contract', (_name, errors) => {
    const hint = declaredRecovery(errors, 'item_not_found');

    it('forwards the hint when the Metadata API returns {} (unknown identifier)', async () => {
      fetchWithTimeout.mockResolvedValueOnce(jsonBody({}));

      await expect(
        buildService().getItem('no-such-item', createMockContext({ errors }), deadline()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: 'Item "no-such-item" not found in the Internet Archive.',
        data: { reason: 'item_not_found', identifier: 'no-such-item', recovery: { hint } },
      });
    });

    it('forwards the hint when the item is dark', async () => {
      fetchWithTimeout.mockResolvedValueOnce(
        jsonBody({ is_dark: true, server: 'ia800000.us.archive.org', dir: '/0/items/x' }),
      );

      await expect(
        buildService().getItem('dark-item', createMockContext({ errors }), deadline()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: 'Item "dark-item" is dark (restricted) in the Internet Archive.',
        data: { reason: 'item_not_found', identifier: 'dark-item', recovery: { hint } },
      });
    });
  });

  it('resolves different item_not_found hints for the tool and resource contracts', () => {
    expect(declaredRecovery(iaGetItem.errors, 'item_not_found')).not.toBe(
      declaredRecovery(iaItemResource.errors, 'item_not_found'),
    );
  });

  it('forwards the ia_get_text hint on no_text_file', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonBody({
        metadata: { title: 'A Film' },
        files: [{ name: 'film.mp4', format: 'MPEG4' }],
      }),
    );

    await expect(
      buildService().getTextContent(
        'film-item',
        100,
        0,
        createMockContext({ errors: iaGetText.errors }),
        deadline(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'no_text_file',
        identifier: 'film-item',
        recovery: { hint: declaredRecovery(iaGetText.errors, 'no_text_file') },
      },
    });
  });
});
