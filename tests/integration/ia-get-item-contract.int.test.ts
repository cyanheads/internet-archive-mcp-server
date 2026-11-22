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
      creator: ['Austen, Jane, 1775-1817', 'Thomson, Hugh, 1860-1920, ill'],
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

/**
 * A record whose every relayed field is a string, its keys in an order unlike the output's, with
 * a non-URL rights statement and markup to escape: the shape 0.6.1 answered correctly.
 */
const ALL_STRING_RECORD = {
  metadata: {
    identifier: 'all-string-record',
    'access-restricted-item': 'true',
    imagecount: '518',
    openlibrary_work: 'OL66554W',
    openlibrary_edition: 'OL7173379M',
    lccn: '35008545',
    'oclc-id': '85792390',
    isbn: '0313328773',
    volume: 'v.6',
    publisher: 'London : George Allen',
    language: 'eng',
    rights: 'Public domain <b>in the US</b>.',
    licenseurl: 'http://creativecommons.org/publicdomain/mark/1.0/',
    collection: 'americana',
    subject: 'Fiction',
    date: '1894',
    mediatype: 'texts',
    description: '<p>A *novel*.</p>',
    creator: 'Austen, Jane, 1775-1817',
    title: 'Pride and prejudice',
  },
  files: [{ name: 'all-string-record_djvu.txt', format: 'DjVuTXT', size: '874482', md5: 'abc' }],
} as const;

/** Records with a list where 0.6.1 declared a string, as the Metadata API returns them (2026-11-22). */
const LIST_RECORDS = {
  'ArchiveIt-Collection-4450': {
    title: '10 years on Mars',
    mediatype: 'collection',
    date: 'April 2014',
    rights: [
      'This collection is made accessible to the public without restriction. The University of Michigan School of Information and Archive-It do not own copyright to these materials; contact the copyright holders for further information.',
      "All materials in this collection are either government-created or have been archived under a claim of fair use for educational and research purposes. If you are the copyright holder to any of these materials and have comments or objections as to its use here, please contact any of the collectors and we'll be happy to discuss your concerns.",
    ],
  },
  'TantaresIVAExpansion-v1.0.1': {
    title: 'Tantares IVA Expansion - v1.0.1',
    mediatype: 'software',
    licenseurl: [
      'https://opensource.org/licenses/MIT',
      'http://creativecommons.org/licenses/by-nc-sa/3.0',
    ],
  },
  kinematographyea1931kine: {
    title: 'Kinematograph Year Book 1931',
    mediatype: 'texts',
    date: '1931',
    volume: ['1931', '18'],
    imagecount: '540',
  },
} as const;

/** An item with no publication date but both upload dates, as the Metadata API returns it (2026-11-22). */
const UNDATED_RECORD = {
  identifier: 'achristmascarol19505gut',
  title: 'A Christmas Carol',
  creator: 'Dickens, Charles, 1812-1870',
  mediatype: 'audio',
  publicdate: '2014-10-24 16:15:43',
  addeddate: '2006-12-06',
  language: 'eng',
  collection: 'gutenberg',
} as const;

/** Audio items with part of each manifest, as the Metadata API returns them (2026-11-22). */
const AUDIO_RECORDS = {
  'gd77-05-08.sbd.hicks.4982.sbeok.shnf': {
    metadata: {
      title: 'Grateful Dead Live at Barton Hall, Cornell University on 1977-05-08',
      mediatype: 'etree',
    },
    files: [
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
        mtime: '1417376261',
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
        original: 'gd77-05-08eaton-d1t01.shn',
        size: '9430',
        md5: 'd105252abdee7b86d91d5d55631c8811',
      },
    ],
  },
  pride_and_prejudice_librivox: {
    metadata: { title: 'Pride and Prejudice', mediatype: 'audio', runtime: '13:06:44' },
    files: [
      {
        name: 'prideandprejudice_01-03_austen.mp3',
        source: 'original',
        size: '18129230',
        format: 'VBR MP3',
        creator: 'Jane Austen',
        album: 'Pride and Prejudice',
        title: 'Chapters 1-3',
        track: '1/37',
        md5: 'e6cff6db8fc50a802a28a07772e94888',
        length: '1133.07',
        genre: 'Speech',
      },
      {
        name: 'prideandprejudice_01-03_austen_64kb.mp3',
        source: 'derivative',
        size: '9064064',
        title: 'Chapters 1-3',
        length: '18:52',
        format: '64Kbps MP3',
        md5: '5ffa934b41c9c7b3d611cf3e5adaea35',
      },
    ],
  },
} as const;

/** Unmatched requests throw — no test in this file reaches the network. */
const http = createFetchMock([
  ...Object.entries(AUDIO_RECORDS).map(([identifier, { metadata, files }]) => ({
    match: `${METADATA}/${identifier}`,
    respond: Response.json({ metadata: { identifier, ...metadata }, files }),
  })),
  {
    match: `${METADATA}/all-string-record`,
    respond: Response.json(ALL_STRING_RECORD),
  },
  ...Object.entries(LIST_RECORDS).map(([identifier, metadata]) => ({
    match: `${METADATA}/${identifier}`,
    respond: Response.json({ metadata: { identifier, ...metadata }, files: [] }),
  })),
  {
    match: `${METADATA}/achristmascarol19505gut`,
    respond: Response.json({ metadata: UNDATED_RECORD, files: [] }),
  },
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
        expect(contentText(result)).toContain(
          '**Media Type:** texts\n**Language:**\n\n- German\n- English\n- French\n\n**Files (1):**',
        );
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
      name: 'relays a list-valued title as received and lists both values under the identifier heading',
      input: { identifier: '00hamigoog' },
      expected: { title: ['Afganistan ', 'Афганистанъ '], date: '1908' },
      assert: (result) => {
        expect(contentText(result)).toBe(
          '# 00hamigoog\n**Title:**\n\n- Afganistan&#32;\n- Афганистанъ&#32;\n\n**Identifier:** 00hamigoog\n**Media Type:** texts\n**Date:** 1908\n**Publisher:**\n\n- S.-Peterburg : Izdal V. Berezovskīĭ, Komissīoner Voenno-Uchebnykh zavedenīĭ\n- С.-Петербургъ : Издалъ В. Березовскій, Комиссіонеръ Военно-Учебныхъ заведеній\n\n**OCLC ID:** 85792390\n**Page Images:** 353\n\n**Files (0):**',
        );
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
        expect(contentText(result)).toBe(
          '# TuxCastDE-News-1-vom-23-45-6789\n**Title:**\n\n- T\n- u\n- x\n- C\n- a\n- s\n- t\n- D\n- E\n- N\n- e\n- w\n- s\n- \\#\n- 1\n- v\n- o\n- m\n- 2\n- 3\n- .\n- 4\n- 5\n- .\n- 6\n- 7\n- 8\n- 9\n\n**Identifier:** TuxCastDE-News-1-vom-23-45-6789\n**Media Type:** movies\n**Date:**\n\n- 6\n- 7\n- 8\n- 9\n- \\-\n- 4\n- 5\n- \\-\n- 2\n- 3\n\n**Files (0):**',
        );
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

describe('ia_get_item on a record whose every field is a string', () => {
  it('returns the same structuredContent, key order included, and content[] as 0.6.1', async () => {
    const result = await runToolContract(iaGetItem, { identifier: 'all-string-record' });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.structuredContent)).toBe(
      '{"identifier":"all-string-record","title":"Pride and prejudice","creator":"Austen, Jane, 1775-1817","description":"A *novel*.","mediatype":"texts","date":"1894","subject":"Fiction","collection":"americana","licenseurl":"http://creativecommons.org/publicdomain/mark/1.0/","rights":"Public domain <b>in the US</b>.","language":"eng","publisher":"London : George Allen","volume":"v.6","isbn":"0313328773","oclc_id":"85792390","lccn":"35008545","openlibrary_edition":"OL7173379M","openlibrary_work":"OL66554W","image_count":518,"access_restricted":true,"file_count":1,"files":[{"name":"all-string-record_djvu.txt","format":"DjVuTXT","size":"874482","md5":"abc","download_url":"https://archive.org/download/all-string-record/all-string-record_djvu.txt"}]}',
    );
    expect(contentText(result)).toBe(
      '# Pride and prejudice\n**Identifier:** all-string-record\n**Media Type:** texts\n**Creator:** Austen, Jane, 1775-1817\n**Date:** 1894\n**Publisher:** London : George Allen\n**Volume:** v.6\n**Language:** eng\n**Subjects:** Fiction\n**Collection:** americana\n**ISBN:** 0313328773\n**OCLC ID:** 85792390\n**LCCN:** 35008545\n**Open Library Edition:** OL7173379M\n**Open Library Work:** OL66554W\n**Page Images:** 518\n**License:** [http://creativecommons.org/publicdomain/mark/1.0/](<http://creativecommons.org/publicdomain/mark/1.0/>)\n**Rights:** Public domain \\<b>in the US\\</b>.\n**Access Restricted:** true\n\n**Description:** A \\*novel\\*.\n\n**Files (1):**\n- **all-string-record_djvu.txt** (DjVuTXT, 874482 bytes, md5:abc): [https://archive.org/download/all-string-record/all-string-record_djvu.txt](<https://archive.org/download/all-string-record/all-string-record_djvu.txt>)',
    );
  });
});

describe('ia_get_item list-valued rights, licenseurl, and volume', () => {
  const getItem = async (identifier: keyof typeof LIST_RECORDS) => {
    const result = await runToolContract(iaGetItem, { identifier });
    expect(result.isError).toBeFalsy();
    return { sc: result.structuredContent as Record<string, unknown>, text: contentText(result) };
  };

  it('returns ArchiveIt-Collection-4450’s two rights statements, one item each', async () => {
    const { sc, text } = await getItem('ArchiveIt-Collection-4450');

    expect(sc.rights).toEqual(LIST_RECORDS['ArchiveIt-Collection-4450'].rights);
    expect(text).toBe(
      "# 10 years on Mars\n**Identifier:** ArchiveIt-Collection-4450\n**Media Type:** collection\n**Date:** April 2014\n**Rights:**\n\n- This collection is made accessible to the public without restriction. The University of Michigan School of Information and Archive-It do not own copyright to these materials; contact the copyright holders for further information.\n- All materials in this collection are either government-created or have been archived under a claim of fair use for educational and research purposes. If you are the copyright holder to any of these materials and have comments or objections as to its use here, please contact any of the collectors and we'll be happy to discuss your concerns.\n\n**Files (0):**",
    );
  });

  it('returns TantaresIVAExpansion-v1.0.1’s two license URLs, each a link', async () => {
    const { sc, text } = await getItem('TantaresIVAExpansion-v1.0.1');

    expect(sc.licenseurl).toEqual([
      'https://opensource.org/licenses/MIT',
      'http://creativecommons.org/licenses/by-nc-sa/3.0',
    ]);
    expect(text).toBe(
      '# Tantares IVA Expansion - v1.0.1\n**Identifier:** TantaresIVAExpansion-v1.0.1\n**Media Type:** software\n**License:**\n\n- [https://opensource.org/licenses/MIT](<https://opensource.org/licenses/MIT>)\n- [http://creativecommons.org/licenses/by-nc-sa/3.0](<http://creativecommons.org/licenses/by-nc-sa/3.0>)\n\n**Files (0):**',
    );
  });

  it('returns kinematographyea1931kine’s two volume values and its page-image count', async () => {
    const { sc, text } = await getItem('kinematographyea1931kine');

    expect(sc).toMatchObject({ volume: ['1931', '18'], mediatype: 'texts', image_count: 540 });
    expect(text).toBe(
      '# Kinematograph Year Book 1931\n**Identifier:** kinematographyea1931kine\n**Media Type:** texts\n**Date:** 1931\n**Volume:**\n\n- 1931\n- 18\n\n**Page Images:** 540\n\n**Files (0):**',
    );
  });
});

describe('ia_get_item upload dates', () => {
  it('returns achristmascarol19505gut’s publicdate and addeddate as stored, with no date, on both surfaces', async () => {
    const result = await runToolContract(iaGetItem, { identifier: 'achristmascarol19505gut' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      publicdate: '2014-10-24 16:15:43',
      addeddate: '2006-12-06',
    });
    expect(result.structuredContent).not.toHaveProperty('date');
    expect(contentText(result)).toBe(
      '# A Christmas Carol\n**Identifier:** achristmascarol19505gut\n**Media Type:** audio\n**Creator:** Dickens, Charles, 1812-1870\n**Public Date:** 2014-10-24 16:15:43\n**Added Date:** 2006-12-06\n**Language:** eng\n**Collection:** gutenberg\n\n**Files (0):**',
    );
  });
});

describe('ia_get_item track details and runtime', () => {
  const download = (identifier: string, name: string) =>
    `https://archive.org/download/${identifier}/${name}`;
  const link = (identifier: string, name: string) =>
    `[${download(identifier, name)}](<${download(identifier, name)}>)`;

  it('returns Minglewood Blues’ title, track, and length on its MP3, and only a length on its Ogg', async () => {
    const id = 'gd77-05-08.sbd.hicks.4982.sbeok.shnf';
    const result = await runToolContract(iaGetItem, { identifier: id });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.structuredContent)).toBe(
      `{"identifier":"${id}","title":"Grateful Dead Live at Barton Hall, Cornell University on 1977-05-08","mediatype":"etree","file_count":3,"files":[{"name":"gd77-05-08eaton-d1t01.mp3","title":"Minglewood Blues","track":"1","length":"06:21","format":"VBR MP3","size":"8838656","md5":"96d1fc48cae5e3bdd62c383d5b458a43","download_url":"${download(id, 'gd77-05-08eaton-d1t01.mp3')}"},{"name":"gd77-05-08eaton-d1t01.ogg","length":"381.1","format":"Ogg Vorbis","size":"4267995","md5":"a0de3951d73f67c0e3fb6d7384592ac1","download_url":"${download(id, 'gd77-05-08eaton-d1t01.ogg')}"},{"name":"gd77-05-08eaton-d1t01.png","format":"PNG","size":"9430","md5":"d105252abdee7b86d91d5d55631c8811","download_url":"${download(id, 'gd77-05-08eaton-d1t01.png')}"}]}`,
    );
    expect(contentText(result)).toBe(
      `# Grateful Dead Live at Barton Hall, Cornell University on 1977-05-08\n**Identifier:** ${id}\n**Media Type:** etree\n\n**Files (3):**\n- **gd77-05-08eaton-d1t01.mp3** (VBR MP3, 8838656 bytes, md5:96d1fc48cae5e3bdd62c383d5b458a43): ${link(id, 'gd77-05-08eaton-d1t01.mp3')}\n  - **Title:** Minglewood Blues\n  - **Track:** 1\n  - **Length:** 06:21\n- **gd77-05-08eaton-d1t01.ogg** (Ogg Vorbis, 4267995 bytes, md5:a0de3951d73f67c0e3fb6d7384592ac1): ${link(id, 'gd77-05-08eaton-d1t01.ogg')}\n  - **Length:** 381.1\n- **gd77-05-08eaton-d1t01.png** (PNG, 9430 bytes, md5:d105252abdee7b86d91d5d55631c8811): ${link(id, 'gd77-05-08eaton-d1t01.png')}`,
    );
  });

  it('returns a LibriVox chapter’s title, track of total, and length, and the item’s runtime', async () => {
    const id = 'pride_and_prejudice_librivox';
    const result = await runToolContract(iaGetItem, { identifier: id, format: 'vbr mp3' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      runtime: '13:06:44',
      files: [
        {
          name: 'prideandprejudice_01-03_austen.mp3',
          title: 'Chapters 1-3',
          track: '1/37',
          length: '1133.07',
        },
      ],
    });
    expect(contentText(result)).toContain(
      `**Media Type:** audio\n**Runtime:** 13:06:44\n\n**Files (showing 1 of 2 in the manifest):**\n- **prideandprejudice_01-03_austen.mp3** (VBR MP3, 18129230 bytes, md5:e6cff6db8fc50a802a28a07772e94888): ${link(id, 'prideandprejudice_01-03_austen.mp3')}\n  - **Title:** Chapters 1-3\n  - **Track:** 1/37\n  - **Length:** 1133.07\n`,
    );
  });
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
  /**
   * The description on both surfaces: the structured value, the inline value content[] renders
   * after the label (undefined for a list, which renders as items), and the whole content[] text.
   */
  const describeItem = async (identifier: keyof typeof DESCRIPTIONS) => {
    const result = await runToolContract(iaGetItem, { identifier });
    expect(result.isError).toBeFalsy();
    const description = (result.structuredContent as { description: string | string[] })
      .description;
    const text = contentText(result);
    const rendered = /\*\*Description:\*\* ([\s\S]*?)\n\n\*\*Files/.exec(text)?.[1];
    return { description, rendered, text };
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

  it('converts each value of a list and renders each as its own item', async () => {
    const { description, rendered, text } = await describeItem('list-description');

    expect(description).toEqual([
      'Book digitized by Google from the library of University of Michigan and uploaded to the Internet Archive by user tpb.',
      'Photocopy\nMode of access: Internet',
    ]);
    expect(rendered).toBeUndefined();
    expect(text).toBe(
      '# list-description\n**Identifier:** list-description\n\n**Description:**\n\n- Book digitized by Google from the library of University of Michigan and uploaded to the Internet Archive by user tpb.\n- Photocopy\\\nMode of access: Internet\n\n**Files (0):**',
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

  it('returns prideprejudice00aust’s creators, publisher, Open Library IDs, and image count, unrestricted', async () => {
    const { sc, text } = await getItem('prideprejudice00aust');

    expect(sc).toMatchObject({
      creator: ['Austen, Jane, 1775-1817', 'Thomson, Hugh, 1860-1920, ill'],
      publisher: 'London : George Allen',
      openlibrary_edition: 'OL7173379M',
      openlibrary_work: 'OL66554W',
      image_count: 518,
    });
    expect(sc).not.toHaveProperty('access_restricted');
    expect(sc.files.some((f) => 'private' in f)).toBe(false);
    expect(text).toContain(
      '\n**Media Type:** texts\n**Creator:**\n\n- Austen, Jane, 1775-1817\n- Thomson, Hugh, 1860-1920, ill\n\n**Publisher:** London : George Allen\n',
    );
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
      '\n**Volume:** 2\n**ISBN:**\n\n- 9780313328770\n- 0313328773\n- 9780313328787\n- 0313328781\n- 9780313328794\n- 031332879X\n- 9780313328800\n- 0313328803\n- 9780313328817\n- 0313328811\n- 9780313328824\n- 031332882X\n\n**LCCN:** 2006022953\n',
    );
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
