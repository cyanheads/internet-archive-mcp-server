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

/** `description` values as the Metadata API returns them (2026-11-12). */
const DESCRIPTIONS = {
  CrackedUpNoCC:
    '<div>"Seventeen-year-old track star, John Owens, has never used any drug stronger than pot, until he meets an older woman who introduces him to crack cocaine. He quickly becomes addicted but is able to hide his problem from all except his best friend, Chris. - Written by Herman Seifer "</div><div>-from IMDB &lt;a href="http://www.imdb.com/title/tt0092792/?ref_=ttpl_pl_tt" rel="nofollow"&gt;&lt;/a&gt;</div>',
  'gd1977-05-08.shure57.stevenson.29303.flac16':
    "Set 1\n\nNew Minglewood Blues  \nLoser  \nEl Paso  \nThey Love Each Other  \nJack Straw  \nDeal  \nLazy Lightnin'  ->\nSupplication  \nBrown Eyed Women  \nMama Tried  \nRow Jimmy  \nDancing In The Street  \n\nSet 2\n\nScarlet Begonias  ->\nFire On The Mountain  \nEstimated Prophet  \nSaint Stephen  ->\nNot Fade Away  ->\nSaint Stephen  ->\nMorning Dew  \n\nEncore\nOne More Saturday Night",
  'elmo-612-r-1018-r-users-manual-j':
    "ELMO SUPER 612R<div>ELMO SUPER 1018R</div><div>User's Manual (Japanese)</div><div><br /></div>",
  'arkivkopia.se-digmus-tek-TEKA0007051':
    'Mer information på <a href="http://arkivkopia.se/sak/digmus-tek-TEKA0007051" rel="ugc nofollow">http://arkivkopia.se/sak/digmus-tek-TEKA0007051</a>.',
  'gov.uscourts.mieb.653252':
    '<a href="http://www.archive.org/download/gov.uscourts.mieb.653252/gov.uscourts.mieb.653252.docket.html" rel="ugc nofollow">Click here</a> to see available docket information and document downloads for this case.  If you need the complete docket, you should consult PACER directly.',
  // 00hamigoog's three-value list, with markup added to the second value.
  'list-description': [
    'Book digitized by Google from the library of University of Michigan and uploaded to the Internet Archive by user tpb.',
    '<div>Photocopy</div><div>Mode of access: Internet</div>',
  ],
} as const;

/** Catalog and access fields with part of each manifest, as the Metadata API returns them (2026-11-12). */
const CATALOG_RECORDS = {
  prideprejudice00aust: {
    metadata: {
      mediatype: 'texts',
      publisher: 'London : George Allen',
      openlibrary_edition: 'OL7173379M',
      openlibrary_work: 'OL66554W',
      imagecount: '518',
    },
    files: [
      { name: 'prideprejudice00aust_djvu.txt', format: 'DjVuTXT', size: '874482' },
      { name: 'prideprejudice00aust_meta.xml', format: 'Metadata', size: '2958' },
    ],
  },
  blackreconstruc00dubo: {
    metadata: {
      mediatype: 'texts',
      publisher: 'New York, Harcourt, Brace and Company',
      lccn: '35008545',
      openlibrary_edition: 'OL6320138M',
      openlibrary_work: 'OL28614W',
      'access-restricted-item': 'true',
      imagecount: '770',
    },
    files: [
      {
        name: 'blackreconstruc00dubo_djvu.txt',
        format: 'DjVuTXT',
        size: '2386365',
        private: 'true',
      },
      { name: 'blackreconstruc00dubo_meta.xml', format: 'Metadata', size: '3437' },
    ],
  },
  'bdrc-W1KG6113': {
    metadata: { mediatype: 'texts', 'access-restricted-item': 'true', imagecount: '896' },
    files: [
      {
        name: 'bdrc-W1KG6113_bdrc.zip',
        format: 'Raw BDRC Book Zip',
        size: '5401918131',
        private: 'true',
      },
      { name: 'bdrc-W1KG6113_djvu.txt', format: 'DjVuTXT', size: '2176316' },
    ],
  },
  dictionaryofmedi0002unse_x3v6: {
    metadata: {
      mediatype: 'texts',
      isbn: [
        '9780313328770',
        '0313328773',
        '9780313328787',
        '0313328781',
        '9780313328794',
        '031332879X',
        '9780313328800',
        '0313328803',
        '9780313328817',
        '0313328811',
        '9780313328824',
        '031332882X',
      ],
      lccn: '2006022953',
      volume: '2',
      'access-restricted-item': 'true',
      imagecount: '354',
    },
    files: [
      {
        name: 'dictionaryofmedi0002unse_x3v6_djvu.txt',
        format: 'DjVuTXT',
        size: '2051598',
        private: 'true',
      },
    ],
  },
  archiveteam_vidme_20171212200101: {
    metadata: { mediatype: 'web', 'access-restricted-item': 'true', imagecount: '1255' },
    files: [
      {
        name: 'archiveteam_vidme_20171212200101.cdx.gz',
        format: 'Item CDX Index',
        size: '93041',
        private: 'true',
      },
    ],
  },
} as const;

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
  {
    // A 1908 book catalogued in two scripts (Metadata API, 2026-11-12).
    match: `${METADATA}/00hamigoog`,
    respond: Response.json({
      metadata: {
        identifier: '00hamigoog',
        title: ['Afganistan ', 'Афганистанъ '],
        date: '1908',
        mediatype: 'texts',
        publisher: [
          'S.-Peterburg : Izdal V. Berezovskīĭ, Komissīoner Voenno-Uchebnykh zavedenīĭ',
          'С.-Петербургъ : Издалъ В. Березовскій, Комиссіонеръ Военно-Учебныхъ заведеній',
        ],
        'oclc-id': '85792390',
        imagecount: '353',
      },
      files: [],
    }),
  },
  ...Object.entries(CATALOG_RECORDS).map(([identifier, { metadata, files }]) => ({
    match: `${METADATA}/${identifier}`,
    respond: Response.json({ metadata: { identifier, ...metadata }, files }),
  })),
  {
    // A malformed upstream record: one title character and one date character per value.
    match: `${METADATA}/TuxCastDE-News-1-vom-23-45-6789`,
    respond: Response.json({
      metadata: {
        identifier: 'TuxCastDE-News-1-vom-23-45-6789',
        title: [...'TuxCastDENews#1vom23.45.6789'],
        date: [...'6789-45-23'],
        mediatype: 'movies',
      },
      files: [],
    }),
  },
  ...Object.entries(DESCRIPTIONS).map(([identifier, description]) => ({
    match: `${METADATA}/${identifier}`,
    respond: Response.json({ metadata: { identifier, description }, files: [] }),
  })),
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
    {
      name: 'relays a list-valued title as received and renders both values',
      input: { identifier: '00hamigoog' },
      expected: { title: ['Afganistan ', 'Афганистанъ '], date: '1908' },
      assert: (result) => {
        const text = contentText(result);
        expect(text).toMatch(/^# Afganistan , Афганистанъ/);
        expect(text).toContain('**Date:** 1908');
      },
    },
    {
      name: 'relays a 28-value title and a 10-value date on both surfaces',
      input: { identifier: 'TuxCastDE-News-1-vom-23-45-6789' },
      expected: { title: [...'TuxCastDENews#1vom23.45.6789'], date: [...'6789-45-23'] },
      assert: (result) => {
        const sc = result.structuredContent as { title: string[]; date: string[] };
        expect(sc.title).toHaveLength(28);
        expect(sc.date).toHaveLength(10);
        const text = contentText(result);
        expect(text).toMatch(/^# T, u, x, C, a, s, t, D, E, N, e, w, s, /);
        expect(text).toContain('**Date:** 6, 7, 8, 9, -, 4, 5, -, 2, 3');
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

describe('ia_get_item descriptions as plain text', () => {
  /** The description on both surfaces: the structured value, and content[]'s line after the label. */
  const describeItem = async (identifier: keyof typeof DESCRIPTIONS) => {
    const result = await runToolContract(iaGetItem, { identifier });
    expect(result.isError).toBeFalsy();
    const description = (result.structuredContent as { description: string | string[] })
      .description;
    const rendered = /\*\*Description:\*\* ([\s\S]*?)\n\n\*\*Files/.exec(contentText(result))?.[1];
    return { description, rendered };
  };

  it('splits CrackedUpNoCC into two lines and keeps its escaped anchor literal', async () => {
    const { description, rendered } = await describeItem('CrackedUpNoCC');

    const lines = (description as string).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^"Seventeen-year-old track star, .* Herman Seifer "$/);
    expect(lines[1]).toBe(
      '-from IMDB <a href="http://www.imdb.com/title/tt0092792/?ref_=ttpl_pl_tt" rel="nofollow"></a>',
    );
    expect(rendered).toContain('Herman Seifer "\\\n-from IMDB \\<a href="http://www.imdb.com/');
    expect(rendered).toMatch(/ rel="nofollow">\\<\/a>$/);
  });

  it('keeps gd1977-05-08 one song per line, set breaks included', async () => {
    const { description, rendered } = await describeItem(
      'gd1977-05-08.shure57.stevenson.29303.flac16',
    );

    const lines = (description as string).split('\n');
    expect(lines.slice(0, 4)).toEqual(['Set 1', '', 'New Minglewood Blues', 'Loser']);
    expect(lines).toContain("Lazy Lightnin' ->");
    expect(lines.at(-1)).toBe('One More Saturday Night');
    expect(lines).toHaveLength(27);
    expect(rendered).toMatch(/^Set 1\\\n\\\nNew Minglewood Blues\\\nLoser\\\n/);
  });

  it('reads elmo-612-r-1018-r-users-manual-j as three lines with no trailing blank line', async () => {
    const { description, rendered } = await describeItem('elmo-612-r-1018-r-users-manual-j');

    expect(description).toBe("ELMO SUPER 612R\nELMO SUPER 1018R\nUser's Manual (Japanese)");
    expect(rendered).toBe("ELMO SUPER 612R\\\nELMO SUPER 1018R\\\nUser's Manual (Japanese)");
  });

  it('reads the arkivkopia.se link as its URL once', async () => {
    const { description, rendered } = await describeItem('arkivkopia.se-digmus-tek-TEKA0007051');

    expect(description).toBe('Mer information på http://arkivkopia.se/sak/digmus-tek-TEKA0007051.');
    expect(rendered).toBe('Mer information på http://arkivkopia.se/sak/digmus-tek-TEKA0007051.');
  });

  it('reads the gov.uscourts.mieb.653252 link as label (URL)', async () => {
    const { description } = await describeItem('gov.uscourts.mieb.653252');

    expect(description).toMatch(
      /^Click here \(http:\/\/www\.archive\.org\/download\/gov\.uscourts\.mieb\.653252\/gov\.uscourts\.mieb\.653252\.docket\.html\) to see available docket information/,
    );
  });

  it('converts each value of a list and puts each on its own line', async () => {
    const { description, rendered } = await describeItem('list-description');

    expect(description).toEqual([
      'Book digitized by Google from the library of University of Michigan and uploaded to the Internet Archive by user tpb.',
      'Photocopy\nMode of access: Internet',
    ]);
    expect(rendered).toBe(
      'Book digitized by Google from the library of University of Michigan and uploaded to the Internet Archive by user tpb.\\\nPhotocopy\\\nMode of access: Internet',
    );
  });
});

describe('ia_get_item catalog identifiers and access restriction', () => {
  const getItem = async (identifier: string) => {
    const result = await runToolContract(iaGetItem, { identifier });
    expect(result.isError).toBeFalsy();
    return {
      sc: result.structuredContent as Record<string, unknown> & {
        files: Record<string, unknown>[];
      },
      text: contentText(result),
    };
  };

  it('returns prideprejudice00aust’s publisher, Open Library IDs, and image count, unrestricted', async () => {
    const { sc, text } = await getItem('prideprejudice00aust');

    expect(sc).toMatchObject({
      publisher: 'London : George Allen',
      openlibrary_edition: 'OL7173379M',
      openlibrary_work: 'OL66554W',
      image_count: 518,
    });
    expect(sc).not.toHaveProperty('access_restricted');
    expect(sc.files.some((f) => 'private' in f)).toBe(false);
    expect(text).toContain('**Publisher:** London : George Allen');
    expect(text).toContain('**Open Library Edition:** OL7173379M');
    expect(text).toContain('**Open Library Work:** OL66554W');
    expect(text).toContain('**Page Images:** 518');
    expect(text).not.toContain('Access Restricted');
  });

  it('marks blackreconstruc00dubo restricted and its DjVuTXT private', async () => {
    const { sc, text } = await getItem('blackreconstruc00dubo');

    expect(sc).toMatchObject({ access_restricted: true, lccn: '35008545' });
    expect(sc.files).toEqual([
      expect.objectContaining({ name: 'blackreconstruc00dubo_djvu.txt', private: true }),
      expect.not.objectContaining({ private: expect.anything() }),
    ]);
    expect(text).toContain('**Access Restricted:** true');
    expect(text).toContain('**LCCN:** 35008545');
    expect(text).toContain(
      '- **blackreconstruc00dubo_djvu.txt** (DjVuTXT, 2386365 bytes, private):',
    );
  });

  it('marks bdrc-W1KG6113 restricted while its DjVuTXT stays public', async () => {
    const { sc } = await getItem('bdrc-W1KG6113');

    expect(sc.access_restricted).toBe(true);
    expect(sc.files.find((f) => f.format === 'DjVuTXT')).not.toHaveProperty('private');
    expect(sc.files.find((f) => f.format === 'Raw BDRC Book Zip')).toMatchObject({
      private: true,
    });
  });

  it('returns dictionaryofmedi0002unse_x3v6’s 12-value isbn list and volume', async () => {
    const { sc, text } = await getItem('dictionaryofmedi0002unse_x3v6');

    expect(sc.isbn).toEqual(CATALOG_RECORDS.dictionaryofmedi0002unse_x3v6.metadata.isbn);
    expect(sc.volume).toBe('2');
    expect(text).toContain(
      `**ISBN:** ${CATALOG_RECORDS.dictionaryofmedi0002unse_x3v6.metadata.isbn.join(', ')}`,
    );
    expect(text).toContain('**Volume:** 2');
  });

  it('returns 00hamigoog’s publisher list and OCLC number', async () => {
    const { sc, text } = await getItem('00hamigoog');

    expect(sc.publisher).toEqual([
      'S.-Peterburg : Izdal V. Berezovskīĭ, Komissīoner Voenno-Uchebnykh zavedenīĭ',
      'С.-Петербургъ : Издалъ В. Березовскій, Комиссіонеръ Военно-Учебныхъ заведеній',
    ]);
    expect(sc.oclc_id).toBe('85792390');
    expect(sc.image_count).toBe(353);
    expect(text).toContain('**OCLC ID:** 85792390');
  });

  it('returns no image_count for a web item, whose imagecount counts captured URIs', async () => {
    const { sc, text } = await getItem('archiveteam_vidme_20171212200101');

    expect(sc).not.toHaveProperty('image_count');
    expect(sc.access_restricted).toBe(true);
    expect(text).not.toContain('1255');
  });
});
