/**
 * @fileoverview Unit tests for the Wayback capture-URL reader: which `url` values read as a
 * capture (its original URL and timestamp) and which pass through unchanged, how the original
 * is taken from the raw string, the explicit `timestamp` beside it (filled, accepted, invalid,
 * or ambiguous), the shared host set, and linear time; and the URL each form of `href` Wayback
 * writes on a replayed page names (`hrefTarget`), in linear time.
 * @module tests/services/wayback-capture-url.test
 */

import { describe, expect, it } from 'vitest';
import {
  hrefTarget,
  readCaptureTarget,
  WAYBACK_HOSTS,
} from '@/services/wayback/wayback-capture-url.js';
import { expectLinearDoubling } from '../helpers/cpu-time.js';

const UCD = 'https://digital.ucd.ie/';
const CAPTURE = `https://web.archive.org/web/20241231012939/${UCD}`;

describe('WAYBACK_HOSTS', () => {
  it('holds the Wayback host and its redirecting alias, lowercase', () => {
    expect([...WAYBACK_HOSTS].sort()).toEqual(['wayback.archive.org', 'web.archive.org']);
  });
});

describe('readCaptureTarget: what reads as a capture', () => {
  it.each([
    ['an https capture URL', CAPTURE, UCD, '20241231012939'],
    [
      'an http capture URL',
      `http://web.archive.org/web/20241231012939/${UCD}`,
      UCD,
      '20241231012939',
    ],
    ['a scheme-less capture URL', `web.archive.org/web/2024/${UCD}`, UCD, '2024'],
    ['an upper-case scheme and host', `HTTPS://WEB.ARCHIVE.ORG/web/2024/${UCD}`, UCD, '2024'],
    ['the wayback.archive.org alias', `https://wayback.archive.org/web/2024/${UCD}`, UCD, '2024'],
    ['the alias in mixed case', `WayBack.Archive.org/web/2024/${UCD}`, UCD, '2024'],
    [
      'the id_ modifier',
      `https://web.archive.org/web/20241231012939id_/${UCD}`,
      UCD,
      '20241231012939',
    ],
    [
      'the if_ modifier',
      `https://web.archive.org/web/20241231012939if_/${UCD}`,
      UCD,
      '20241231012939',
    ],
    ['the im_ modifier', `https://web.archive.org/web/2024im_/${UCD}`, UCD, '2024'],
    ['the js_ modifier', `https://web.archive.org/web/2024js_/${UCD}`, UCD, '2024'],
    ['the cs_ modifier', `https://web.archive.org/web/2024cs_/${UCD}`, UCD, '2024'],
    ['any two-letter modifier', `https://web.archive.org/web/2024zq_/${UCD}`, UCD, '2024'],
  ])('reads %s as its original URL and timestamp', (_label, url, original, timestamp) => {
    expect(readCaptureTarget(url)).toEqual({ kind: 'target', url: original, timestamp });
  });

  it.each([
    [
      'its query string',
      'https://web.archive.org/web/2020/https://news.ycombinator.com/item?id=1',
      'https://news.ycombinator.com/item?id=1',
    ],
    [
      'dot segments and the query',
      'https://web.archive.org/web/2020/https://example.com/a/../b?x=1',
      'https://example.com/a/../b?x=1',
    ],
    [
      'doubled slashes and a fragment',
      'https://web.archive.org/web/2020/https://example.com/b//c?x=1&y=2#frag',
      'https://example.com/b//c?x=1&y=2#frag',
    ],
    [
      'a scheme-less original',
      'https://web.archive.org/web/2020/digital.ucd.ie/',
      'digital.ucd.ie/',
    ],
    [
      'a collapsed https:/ original',
      'https://web.archive.org/web/2020/https:/digital.ucd.ie/',
      'https:/digital.ucd.ie/',
    ],
    [
      'an escape in an original whose scheme is not encoded',
      'https://web.archive.org/web/2020/https://example.com/a%20b%2Fc',
      'https://example.com/a%20b%2Fc',
    ],
    [
      'an original that is itself a capture URL',
      `https://web.archive.org/web/2020/${CAPTURE}`,
      CAPTURE,
    ],
  ])('takes the original from the raw string, keeping %s', (_label, url, original) => {
    expect(readCaptureTarget(url)).toMatchObject({ kind: 'target', url: original });
  });

  it.each([
    [
      'an encoded scheme',
      'https://web.archive.org/web/20241231012939/https%3A%2F%2Fdigital.ucd.ie%2F',
      UCD,
    ],
    [
      'lower-case hex',
      'https://web.archive.org/web/20241231012939/http%3a%2f%2fdigital.ucd.ie%2f',
      'http://digital.ucd.ie/',
    ],
    [
      'an encoded query',
      'https://web.archive.org/web/2020/https%3A%2F%2Fnews.ycombinator.com%2Fitem%3Fid%3D1',
      'https://news.ycombinator.com/item?id=1',
    ],
    [
      'an escape encoded again, once',
      'https://web.archive.org/web/2020/https%3A%2F%2Fexample.com%2Fa%2520b',
      'https://example.com/a%20b',
    ],
    [
      'an escape that decodes nothing, as given',
      'https://web.archive.org/web/2020/https%3A%2F%2Fexample.com%2F100%',
      'https%3A%2F%2Fexample.com%2F100%',
    ],
  ])('decodes an original whose scheme is percent-encoded once: %s', (_label, url, original) => {
    expect(readCaptureTarget(url)).toMatchObject({ kind: 'target', url: original });
  });

  it.each([
    ['a calendar URL', `https://web.archive.org/web/*/${UCD}`],
    ['a calendar URL over a period', 'https://web.archive.org/web/2020*/digital.ucd.ie'],
    [
      'the calendar URL whose own captures Wayback lists',
      'https://web.archive.org/web/2*/http://abcnews.go.com/Technology/wireStory/plastic-surgery-clinics-hacked-25000-photos-data-online-47728631',
    ],
    ['a timegate URL', `https://web.archive.org/web/${UCD}`],
    [
      'a timegate URL whose original opens with digits',
      'https://web.archive.org/web/123.example.com/',
    ],
    ['a timemap URL', `https://web.archive.org/web/timemap/json?url=${UCD}`],
    ['an archive.org/web URL', `https://archive.org/web/20241231012939/${UCD}`],
    ['a www.archive.org/web URL', `https://www.archive.org/web/20241231012939/${UCD}`],
    ['a capture URL with a port', `https://web.archive.org:443/web/20241231012939/${UCD}`],
    ['a capture URL with userinfo', `https://user@web.archive.org/web/20241231012939/${UCD}`],
    ['an ftp URL', `ftp://web.archive.org/web/20241231012939/${UCD}`],
    ['an upper-case /WEB/ path', `https://web.archive.org/WEB/20241231012939/${UCD}`],
    ['an upper-case modifier', `https://web.archive.org/web/20241231012939ID_/${UCD}`],
    ['a three-letter modifier', `https://web.archive.org/web/20241231012939abc_/${UCD}`],
    ['a capture path with no original', 'https://web.archive.org/web/20241231012939/'],
    ['the Wayback root', 'https://web.archive.org/web/'],
    ['the bare host', 'web.archive.org'],
    ['the same path on another host', `https://example.com/web/20241231012939/${UCD}`],
    ['a lookalike host', `https://web.archive.org.example.com/web/20241231012939/${UCD}`],
    ['an ordinary URL', UCD],
  ])('passes %s through unchanged', (_label, url) => {
    expect(readCaptureTarget(url)).toEqual({ kind: 'target', url, timestamp: undefined });
    expect(readCaptureTarget(url, '2020-06-15')).toEqual({
      kind: 'target',
      url,
      timestamp: '20200615',
    });
  });

  it.each([
    ['names an impossible month', '20241399'],
    ['has 15 digits', '202412310129390'],
    ['names a day the month lacks', '20230229'],
  ])(
    'fails a capture URL whose timestamp %s as invalid_timestamp naming url and the digits',
    (_label, digits) => {
      const target = readCaptureTarget(`https://web.archive.org/web/${digits}/${UCD}`, '');

      expect(target).toEqual({
        kind: 'invalid_timestamp',
        field: 'url',
        message: expect.stringContaining(`timestamp, ${digits}, is not`),
        hint: expect.stringMatching(/digits after \/web\/.*pass the URL it archives as url/),
      });
    },
  );
});

describe('readCaptureTarget: the timestamp beside url', () => {
  it.each([
    ['omitted', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('reads a timestamp %s as the latest capture of an ordinary URL', (_label, timestamp) => {
    expect(readCaptureTarget(UCD, timestamp)).toEqual({
      kind: 'target',
      url: UCD,
      timestamp: undefined,
    });
  });

  it.each([
    ['digits', '20200615', '20200615'],
    ['an ISO date-time, trimmed', ' 2020-06-15T12:34:56Z ', '20200615123456'],
  ])('reads %s beside an ordinary URL as its digits', (_label, timestamp, digits) => {
    expect(readCaptureTarget(UCD, timestamp)).toEqual({
      kind: 'target',
      url: UCD,
      timestamp: digits,
    });
  });

  it.each([
    ['omitted', undefined],
    ['empty', ''],
    ['whitespace-only', '  '],
    ['the same digits', '20241231012939'],
    ['the same digits as an ISO date-time', '2024-12-31T01:29:39Z'],
  ])('fills or accepts a timestamp %s beside a capture URL with its own', (_label, timestamp) => {
    expect(readCaptureTarget(CAPTURE, timestamp)).toEqual({
      kind: 'target',
      url: UCD,
      timestamp: '20241231012939',
    });
  });

  it.each([
    ['a prefix of the capture’s timestamp', CAPTURE, '2024', '20241231012939', '2024'],
    ['another capture', CAPTURE, '2025-01-01', '20241231012939', '20250101'],
    [
      'a capture inside the URL’s period',
      `https://web.archive.org/web/2024/${UCD}`,
      '20241231012939',
      '2024',
      '20241231012939',
    ],
  ])(
    'fails a timestamp naming %s as ambiguous_timestamp, naming the original and both timestamps',
    (_label, url, timestamp, embedded, explicit) => {
      expect(readCaptureTarget(url, timestamp)).toEqual({
        kind: 'ambiguous_timestamp',
        message: `url is a Wayback capture URL naming ${UCD} at ${embedded}, and timestamp names a different timestamp, ${explicit}.`,
      });
    },
  );

  it.each([
    ['an ordinary URL', UCD],
    ['a capture URL', CAPTURE],
  ])(
    'fails a malformed timestamp beside %s as invalid_timestamp naming timestamp',
    (_label, url) => {
      expect(readCaptureTarget(url, 'January 2015')).toEqual({
        kind: 'invalid_timestamp',
        field: 'timestamp',
        message: expect.stringMatching(/^timestamp must be 1–14 digits.*ISO 8601/),
      });
    },
  );

  it('names url first when both the capture URL’s timestamp and timestamp are malformed', () => {
    expect(
      readCaptureTarget(`https://web.archive.org/web/20241399/${UCD}`, 'January 2015'),
    ).toMatchObject({
      kind: 'invalid_timestamp',
      field: 'url',
    });
  });
});

describe('hrefTarget (#67)', () => {
  const PAGE = new URL('http://info.cern.ch/hypertext/WWW/TheProject.html');

  it.each([
    [
      'a root-relative capture URL',
      '/web/20151231164925/http://info.cern.ch/hypertext/DataSources/Top.html',
      'http://info.cern.ch/hypertext/DataSources/Top.html',
    ],
    [
      'an absolute capture URL',
      'https://web.archive.org/web/20221231052306/https://www.rfc-editor.org/info/rfc2606',
      'https://www.rfc-editor.org/info/rfc2606',
    ],
    [
      'a protocol-relative capture URL',
      '//web.archive.org/web/20200101030920/https://en.wikipedia.org/wiki/Axis_powers',
      'https://en.wikipedia.org/wiki/Axis_powers',
    ],
    [
      'a capture URL on the alias host, in upper case',
      'HTTP://WAYBACK.ARCHIVE.ORG/web/2015/http://a.example/x',
      'http://a.example/x',
    ],
    [
      'a link to an archived copy, read once to its capture URL',
      '/web/20200101030920/https://web.archive.org/web/20180325210216/http://ibiblio.org/pha/policy/1941/411209b.html',
      'https://web.archive.org/web/20180325210216/http://ibiblio.org/pha/policy/1941/411209b.html',
    ],
    [
      'a rewritten mailto:',
      'https://web.archive.org/web/20221231052306/mailto:d3e3e3%40gmail.com',
      'mailto:d3e3e3%40gmail.com',
    ],
    [
      'a rewritten ftp:',
      'https://web.archive.org/web/20221231052306/ftp://rs.internic.net/archives/namedroppers',
      'ftp://rs.internic.net/archives/namedroppers',
    ],
    [
      'a capture whose original’s scheme is percent-encoded',
      '/web/2015/https%3A%2F%2Fa.example%2Fb',
      'https://a.example/b',
    ],
    [
      'a capture of a bare host',
      '/web/20070101025432/http://typo3.sunsite.dk',
      'http://typo3.sunsite.dk/',
    ],
    ['a plain relative path', 'Summary.html', 'http://info.cern.ch/hypertext/WWW/Summary.html'],
    [
      'a relative path with a fragment, kept',
      'Status.html#35',
      'http://info.cern.ch/hypertext/WWW/Status.html#35',
    ],
    ['a ../ path', '../DataSources/Top.html', 'http://info.cern.ch/hypertext/DataSources/Top.html'],
    ['a fragment', '#section-1', `${PAGE.href}#section-1`],
    ['an empty href, as the base', '', PAGE.href],
    ['a javascript: href, scheme kept', 'javascript:void(0)', 'javascript:void(0)'],
    [
      'tabs, line breaks, and edge spaces',
      ' \tSum\nmary.html \r\n',
      'http://info.cern.ch/hypertext/WWW/Summary.html',
    ],
    [
      'a /web/ path naming no capture, against the base',
      '/web/*/http://a.example/',
      'http://info.cern.ch/web/*/http://a.example/',
    ],
    [
      'a relative path that starts like a scheme-less capture URL',
      'web.archive.org/web/2015/http://a.example/',
      'http://info.cern.ch/hypertext/WWW/web.archive.org/web/2015/http://a.example/',
    ],
    ['a Wayback URL naming no capture', 'https://web.archive.org/', 'https://web.archive.org/'],
    [
      'a protocol-relative URL off Wayback, in the base’s scheme',
      '//cdn.example/x.js',
      'http://cdn.example/x.js',
    ],
    ['an href that does not parse', 'http://[', undefined],
    ['a capture whose original does not parse', '/web/2015/not a url', undefined],
  ])('reads %s', (_label, href, want) => {
    expect(hrefTarget(href, PAGE)?.href).toBe(want);
  });

  it('resolves a relative href against the base it is given, not the page', () => {
    expect(hrefTarget('about/', new URL('http://typo3.org/'))?.href).toBe(
      'http://typo3.org/about/',
    );
  });

  it('reads an absolute href with no base, and no relative one', () => {
    expect(hrefTarget('https://a.example/x#y', undefined)?.href).toBe('https://a.example/x#y');
    expect(hrefTarget('/web/2015/http://a.example/', undefined)?.href).toBe('http://a.example/');
    expect(hrefTarget('Summary.html', undefined)).toBeUndefined();
  });
});

describe('hrefTarget in linear time (#67)', () => {
  const fill = (unit: string, n: number): string =>
    unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const PAGE = new URL('http://info.cern.ch/hypertext/WWW/TheProject.html');

  /** Long hrefs of each form, padding the trim and the tab and line-break removal works through, and the two line-break shapes. */
  const WORST_CASES: [name: string, build: (n: number) => string][] = [
    ['a long relative path', (n) => fill('a/', n)],
    ['a long capture original', (n) => `/web/2015/http://a.example/${fill('b/', n - 27)}`],
    ['a long protocol-relative host', (n) => `//${fill('a', n - 2)}`],
    ['a long capture digit run', (n) => `/web/${fill('1', n - 5)}`],
    ['tabs and line breaks throughout', (n) => fill('a\t\n\r', n)],
    ['spaces at both ends', (n) => `${fill(' ', n / 2)}x${fill(' ', n / 2 - 1)}`],
    ['one long line ending in a break', (n) => `${fill('§1 x', n - 2)}\ny`],
    ['breaks throughout', (n) => fill('  \r\n', n)],
  ];

  /** CPU ceiling per call: 1 µs per character. */
  const MAX_CPU_MS_PER_CHAR = 0.001;

  it.each(WORST_CASES)(
    'reads %s in linear time',
    async (_name, build) => {
      await expectLinearDoubling((n) => {
        const href = build(n);
        return () => hrefTarget(href, PAGE);
      }, MAX_CPU_MS_PER_CHAR);
    },
    0,
  );
});

describe('readCaptureTarget in linear time', () => {
  const fill = (unit: string, n: number): string =>
    unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const web = 'https://web.archive.org/web/';
  const capture = `${web}2020/`;
  const encoded = `${capture}https%3A%2F%2F`;

  /**
   * Worst cases: digit runs the capture path backs off from, long hosts and originals, escapes
   * an encoded original decodes, line breaks, and a long timestamp beside a capture URL.
   */
  const WORST_CASES: [name: string, build: (n: number) => [string, string?]][] = [
    ['a long digit run', (n) => [fill('1', n)]],
    ['capture digits with no slash after them', (n) => [web + fill('1', n - web.length)]],
    ['capture digits followed by a letter', (n) => [`${web}${fill('1', n - web.length - 1)}a`]],
    [
      'capture digits followed by a modifier and no slash',
      (n) => [`${web}${fill('1', n - web.length - 3)}id_`],
    ],
    ['a long host', (n) => [fill('a', n)]],
    ['runs of slashes', (n) => [fill('/', n)]],
    ['repeated schemes', (n) => [fill('https://', n)]],
    ['a long original of segments', (n) => [capture + fill('a/', n - capture.length)]],
    ['an encoded original of escapes', (n) => [encoded + fill('%2F', n - encoded.length)]],
    [
      'an encoded original of broken escapes',
      (n) => [encoded + fill('%E0%A4', n - encoded.length)],
    ],
    ['an encoded original of lone % signs', (n) => [encoded + fill('%', n - encoded.length)]],
    [
      'one long line ending in a break',
      (n) => [`${capture}${fill('§1 x', n - capture.length - 2)}\ny`],
    ],
    ['breaks throughout', (n) => [capture + fill('  \r\n', n - capture.length)]],
    ['a padded timestamp beside a capture URL', (n) => [CAPTURE, `${fill(' ', n - 4)}2024`]],
    ['a long timestamp beside a capture URL', (n) => [CAPTURE, fill('1', n)]],
  ];

  /** CPU ceiling per call: 0.1 µs per character, about 40× the slowest shape measured (0.83 ms at 320k). */
  const MAX_CPU_MS_PER_CHAR = 0.0001;

  it.each(WORST_CASES)(
    'reads %s in linear time',
    async (_name, build) => {
      await expectLinearDoubling((n) => {
        const [url, timestamp] = build(n);
        return () => readCaptureTarget(url, timestamp);
      }, MAX_CPU_MS_PER_CHAR);
    },
    0,
  );
});
