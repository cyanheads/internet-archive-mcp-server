/**
 * @fileoverview Tests for WaybackService.fetchContent — the text it extracts from an
 * archived page (markup removal, one-pass character-reference decoding, linear-time
 * scanning), the charset it decodes the body with, how the replay's media type routes
 * the read (HTML, text from the `id_` form, or no text), and the status it reports for the
 * capture served. Redirects, and the capture they lead to, are covered by
 * wayback-redirects.test.ts, which routes each 3xx as Wayback sends it.
 * @module tests/services/wayback-content.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  type Attempt = Parameters<Parameters<typeof actual.withRetry>[0]>[0];
  return {
    ...actual,
    fetchWithTimeout: (...args: Parameters<typeof fetchWithTimeout>) => fetchWithTimeout(...args),
    // One attempt, on the caller's signal; async like the real loop, so a throw inside the attempt arrives as a rejection.
    withRetry: async <T>(
      fn: (attempt: Attempt) => Promise<T>,
      options?: Parameters<typeof actual.withRetry>[1],
    ): Promise<T> =>
      await fn({
        signal: options?.signal ?? new AbortController().signal,
        remainingMs: Number.POSITIVE_INFINITY,
      }),
  };
});

import { getServerConfig } from '@/config/server-config.js';
import { iaGetSnapshot } from '@/mcp-server/tools/definitions/ia-get-snapshot.tool.js';
import { startCallDeadline } from '@/services/call-deadline.js';
import { WaybackService } from '@/services/wayback/wayback-service.js';
import {
  CPU_TIMED_TEST_TIMEOUT_MS,
  cpuMsPerCall,
  expectLinearDoubling,
  expectLinearScaling,
} from '../helpers/cpu-time.js';

const SNAPSHOT = 'https://web.archive.org/web/20120601000000/https://www.nasa.gov';

const buildService = (): WaybackService =>
  new WaybackService({ mcpServerVersion: '0.0.0-test' } as AppConfig, {} as StorageService);

/** A 2xx replay response as `fetchWithTimeout` hands it back. */
const served = (
  body: BodyInit,
  {
    contentType = 'text/html',
    headers = {},
    status = 200,
  }: {
    contentType?: string | null;
    headers?: Record<string, string>;
    status?: number;
  } = {},
): Response =>
  new Response(body, {
    status,
    headers: { ...(contentType ? { 'content-type': contentType } : {}), ...headers },
  });

const fetchContent = (response: Response) => {
  fetchWithTimeout.mockResolvedValueOnce(response);
  const ctx = createMockContext({ errors: iaGetSnapshot.errors });
  return buildService().fetchContent(SNAPSHOT, ctx, startCallDeadline(ctx.signal));
};

/** The text extracted from an HTML string served as UTF-8. */
const textOf = async (html: string): Promise<string> => (await fetchContent(served(html))).text;

/** Bytes of a string in ISO-8859-1 — one byte per code unit below U+0100. */
const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

beforeEach(() => {
  fetchWithTimeout.mockReset();
  fetchWithTimeout.mockImplementation((url: string) =>
    Promise.reject(new Error(`unmocked fetch: ${url}`)),
  );
});

describe('fetchContent text extraction — existing behavior', () => {
  it('drops script and style bodies, strips tags, and writes block elements as lines (#66)', async () => {
    const html =
      '<html><head><title>T</title><style>p { color: red }</style>' +
      '<script>var x = 1;</script></head>\n<body>  <p>Hello</p>\n\n<p>world</p></body></html>';
    expect(await textOf(html)).toBe('T\nHello\nworld');
  });

  it('decodes the core references', async () => {
    expect(await textOf('&amp; &lt; &gt; &quot; &#039;')).toBe('& < > " \'');
  });

  it('leaves a bare < that opens no tag as text', async () => {
    expect(await textOf('a < b and 3<4')).toBe('a < b and 3<4');
  });

  it('separates adjacent cells with a tab (#66)', async () => {
    expect(await textOf('<td>Home</td><td>News</td>')).toBe('Home\tNews');
  });

  it('keeps the spacing and line breaks of <pre> text (#66)', async () => {
    expect(
      await textOf('<p>Contents</p><pre>\n   <a href="#s1">1</a>. Intro....1\n\n x</pre>'),
    ).toBe('Contents\n   1. Intro....1\n\n x');
  });

  it('returns the whole extracted text, with no character cap of its own (#44)', async () => {
    const length = getServerConfig().maxSnapshotChars + 1_000;
    const result = await fetchContent(served(`<p>${'x'.repeat(length)}</p>`));
    expect(result.text).toBe('x'.repeat(length));
  });

  it('decodes an undeclared UTF-8 page as UTF-8', async () => {
    const bytes = new TextEncoder().encode('<p>Actualités — ünïcödé</p>');
    expect((await fetchContent(served(bytes))).text).toBe('Actualités — ünïcödé');
  });
});

describe('fetchContent links (#67)', () => {
  /** fetchContent of `snapshotUrl`, the upstream answering each request in turn with `responses`, with `options`. */
  const fetchWith = (
    options: { links?: boolean } | undefined,
    snapshotUrl: string,
    ...responses: Response[]
  ) => {
    for (const response of responses) fetchWithTimeout.mockResolvedValueOnce(response);
    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    return buildService().fetchContent(snapshotUrl, ctx, startCallDeadline(ctx.signal), options);
  };

  /** The links of `html` served as an HTML replay of `snapshotUrl`. */
  const linksOf = async (html: string, snapshotUrl = SNAPSHOT) =>
    (await fetchWith({ links: true }, snapshotUrl, served(html))).links;

  /** Each link's text and URL, without its offset. */
  const targets = (links: { text: string; url: string }[] | undefined) =>
    links?.map(({ text, url }) => ({ text, url }));

  it('returns what it returned before without links: true, no links field included', async () => {
    const html = '<p>See the <a href="Summary.html">executive summary</a>.</p>';
    const omitted = await fetchContent(served(html));
    const off = await fetchWith({ links: false }, SNAPSHOT, served(html));
    const on = await fetchWith({ links: true }, SNAPSHOT, served(html));
    expect(omitted).toEqual({
      text: 'See the executive summary.',
      replayUrl: SNAPSHOT,
      timestamp: '20120601000000',
      status: '200',
    });
    expect('links' in omitted).toBe(false);
    expect('links' in off).toBe(false);
    expect(off).toEqual(omitted);
    const { links: _links, ...rest } = on;
    expect(rest).toEqual(omitted);
  });

  const CERN =
    'https://web.archive.org/web/20151231164925/http://info.cern.ch/hypertext/WWW/TheProject.html';
  /** Lines 16–39 of the 20151231164925 replay of the CERN project page, as Wayback serves them. */
  const CERN_REPLAY = `<body>
<h1>World Wide Web</h1>The WorldWideWeb (W3) is a wide-area<a name="0" href="WhatIs.html">
hypermedia</a> information retrieval
initiative aiming to give universal
access to a large universe of documents.<p>
Everything there is online about
W3 is linked directly or indirectly
to this document, including an <a name="24" href="Summary.html">executive
summary</a> of the project, <a name="29" href="Administration/Mailing/Overview.html">Mailing lists</a>
, <a name="30" href="Policy.html">Policy</a> , November's  <a name="34" href="News/9211.html">W3  news</a> ,
<a name="41" href="FAQ/List.html">Frequently Asked Questions</a> .
<dl>
<dt><a name="44" href="/web/20151231164925/http://info.cern.ch/hypertext/DataSources/Top.html">What's out there?</a>
<dd> Pointers to the
world's online information,<a name="45" href="/web/20151231164925/http://info.cern.ch/hypertext/DataSources/bySubject/Overview.html"> subjects</a>
, <a name="z54" href="/web/20151231164925/http://info.cern.ch/hypertext/DataSources/WWW/Servers.html">W3 servers</a>, etc.
<dt><a name="46" href="Help.html">Help</a>
<dd> on the browser you are using
<dt><a name="13" href="Status.html">Software Products</a>
<dd> A list of W3 project
components and their current state.
(e.g. <a name="27" href="LineMode/Browser.html">Line Mode</a> ,X11 <a name="35" href="Status.html#35">Viola</a> ,  <a name="26" href="NeXT/WorldWideWeb.html">NeXTStep</a>
, <a name="25" href="Daemon/Overview.html">Servers</a> , <a name="51" href="Tools/Overview.html">Tools</a> ,<a name="53" href="MailRobot/Overview.html"> Mail robot</a> ,<a name="52" href="Status.html#57">
Library</a> )`;

  it('lists the CERN page’s links: relative hrefs against the page URL, rewritten ones read once, Status.html#35 and #57 folded into Status.html', async () => {
    const result = await fetchWith({ links: true }, CERN, served(CERN_REPLAY));
    const www = 'http://info.cern.ch/hypertext/WWW/';
    const sources = 'http://info.cern.ch/hypertext/DataSources/';
    expect(targets(result.links)).toEqual([
      { text: 'hypermedia', url: `${www}WhatIs.html` },
      { text: 'executive summary', url: `${www}Summary.html` },
      { text: 'Mailing lists', url: `${www}Administration/Mailing/Overview.html` },
      { text: 'Policy', url: `${www}Policy.html` },
      { text: 'W3 news', url: `${www}News/9211.html` },
      { text: 'Frequently Asked Questions', url: `${www}FAQ/List.html` },
      { text: "What's out there?", url: `${sources}Top.html` },
      { text: 'subjects', url: `${sources}bySubject/Overview.html` },
      { text: 'W3 servers', url: `${sources}WWW/Servers.html` },
      { text: 'Help', url: `${www}Help.html` },
      { text: 'Software Products', url: `${www}Status.html` },
      { text: 'Line Mode', url: `${www}LineMode/Browser.html` },
      { text: 'NeXTStep', url: `${www}NeXT/WorldWideWeb.html` },
      { text: 'Servers', url: `${www}Daemon/Overview.html` },
      { text: 'Tools', url: `${www}Tools/Overview.html` },
      { text: 'Mail robot', url: `${www}MailRobot/Overview.html` },
    ]);
    for (const { offset, text } of result.links ?? []) {
      expect(result.text.slice(offset, offset + text.length)).toBe(text);
    }
    expect(result.links?.[0]?.offset).toBe(result.text.indexOf('hypermedia'));
    expect(fetchWithTimeout.mock.calls.map((call) => String(call[0]))).toEqual([CERN]);
  });

  const TYPO3 = 'https://web.archive.org/web/20070101025432/http://typo3.org/';

  it('resolves against a rewritten <base href>, leaving out the page itself and javascript: links', async () => {
    const html = `<head><base href="${TYPO3}"/></head><body><div id="logo"><a href=""><img alt="TYPO3"/></a></div><a href="about/">About</a> Author:&nbsp;<a href="javascript:linkTo_UnCryptMailto('pdlowr-qhwvhuylfhCqlhnrp1gh');">Peter Niederlag</a></body>`;
    expect(targets(await linksOf(html, TYPO3))).toEqual([
      { text: 'About', url: 'http://typo3.org/about/' },
    ]);
  });

  it.each([
    [
      'the first <base href>, read once',
      `<base target="_top"><base href="${TYPO3}"><base href="http://other.example/">`,
      'http://typo3.org/about/',
    ],
    [
      'a <base href> Wayback did not rewrite',
      '<base href="http://typo3.org/">',
      'http://typo3.org/about/',
    ],
    [
      'the page URL, when <base href> does not parse',
      '<base href="http://[">',
      'https://www.nasa.gov/about/',
    ],
    [
      'the page URL, when no <base> has an href',
      '<base target="_top">',
      'https://www.nasa.gov/about/',
    ],
  ])('resolves a relative href against %s', async (_name, head, url) => {
    expect(targets(await linksOf(`${head}<a href="about/">About</a>`))).toEqual([
      { text: 'About', url },
    ]);
  });

  it('resolves against a relative <base href> Wayback did not rewrite, read against the page URL', async () => {
    const page = 'https://web.archive.org/web/20120601000000/http://example.com/x/y.html';
    expect(await linksOf('<base href="/docs/"><a href="a.html">A</a>', page)).toEqual([
      { offset: 0, text: 'A', url: 'http://example.com/docs/a.html' },
    ]);
  });

  it('resolves relative hrefs against the page an archived redirect led to, leaving that page out', async () => {
    const asked = 'https://web.archive.org/web/20240515003448/http://example.com/';
    const target = 'https://web.archive.org/web/20240515003448/http://example.com/home/index.html';
    // The 302 the replay answers with, rejected as fetchWithTimeout rejects a 3xx under redirect: 'manual'.
    fetchWithTimeout.mockRejectedValueOnce(
      await httpErrorFromResponse(
        new Response(null, {
          status: 302,
          headers: {
            location: '/web/20240515003448/http://example.com/home/index.html',
            'memento-datetime': 'Wed, 15 May 2024 00:34:48 GMT',
          },
        }),
        { errorHeaders: ['memento-datetime', 'location'] },
      ),
    );

    const result = await fetchWith(
      { links: true },
      asked,
      served('<a href="about.html">About</a> <a href="index.html">Home</a>'),
    );

    expect(result.links).toEqual([
      { offset: 0, text: 'About', url: 'http://example.com/home/about.html' },
    ]);
    expect(result.replayUrl).toBe(target);
    expect(fetchWithTimeout.mock.calls.map((call) => String(call[0]))).toEqual([asked, target]);
  });

  it('leaves out rewritten mailto: and ftp:, other schemes, fragments, and the page itself', async () => {
    const page =
      'https://web.archive.org/web/20221231052306/https://datatracker.ietf.org/doc/html/rfc2606';
    const html = `<a href="#section-1">1</a> <a href="https://web.archive.org/web/20221231052306/mailto:d3e3e3%40gmail.com">mail</a> <a href="https://web.archive.org/web/20221231052306/ftp://rs.internic.net/archives/namedroppers">ftp</a> <a href="javascript:void(0)">js</a> <a href="tel:+1">tel</a> <a href="/web/20221231052306/https://datatracker.ietf.org/doc/html/rfc2606">self</a> <a href="https://datatracker.ietf.org/doc/html/rfc2606#page-2">page 2</a> <a href="/web/20221231052306/https://www.rfc-editor.org/info/rfc2606">RFC Editor</a>`;
    expect(targets(await linksOf(html, page))).toEqual([
      { text: 'RFC Editor', url: 'https://www.rfc-editor.org/info/rfc2606' },
    ]);
  });

  it('keeps a link to an archived copy as its capture URL, and reads a protocol-relative capture URL', async () => {
    const wwii =
      'https://web.archive.org/web/20200101030920/https://en.wikipedia.org/wiki/World_War_II';
    const archived =
      'https://web.archive.org/web/20180325210216/http://ibiblio.org/pha/policy/1941/411209b.html';
    const html = `<a href="/web/20200101030920/${archived}">Proclamation</a> <a href="//web.archive.org/web/20200101030920/https://en.wikipedia.org/wiki/Axis_powers">Axis</a>`;
    expect(targets(await linksOf(html, wwii))).toEqual([
      { text: 'Proclamation', url: archived },
      { text: 'Axis', url: 'https://en.wikipedia.org/wiki/Axis_powers' },
    ]);
  });

  it('lists a repeated target once, at its first anchor, with the first non-empty text', async () => {
    const html =
      '<a href="a.html"><img alt="logo"></a> x <a href="a.html#top">Home</a> <a href="a.html">Again</a> <a href="b.html">First</a> <a href="b.html">Second</a>';
    expect(await linksOf(html)).toEqual([
      { offset: 0, text: 'Home', url: 'https://www.nasa.gov/a.html' },
      { offset: 13, text: 'First', url: 'https://www.nasa.gov/b.html' },
    ]);
  });

  it('reads a link’s text on one line, and an href’s character references decoded', async () => {
    const html = '<table><tr><td><a href="q?x=1&amp;y=2">a<br>b</td><td>c</a></td></tr></table>';
    const result = await fetchWith({ links: true }, SNAPSHOT, served(html));
    expect(result.text).toBe('a\nb\tc');
    expect(result.links).toEqual([
      { offset: 0, text: 'a b c', url: 'https://www.nasa.gov/q?x=1&y=2' },
    ]);
  });

  it('returns no links for an HTML page without anchors', async () => {
    expect(await linksOf('<p>no links here</p>')).toEqual([]);
  });

  it('returns no links for a capture read as another text type', async () => {
    const utf8 = (text: string) => new TextEncoder().encode(text);
    const result = await fetchWith(
      { links: true },
      SNAPSHOT,
      served(utf8('<a href="/web/2012/http://a.example/">rewritten</a>'), {
        contentType: 'text/plain',
      }),
      served(utf8('<a href="http://a.example/">raw</a>'), { contentType: 'text/plain' }),
    );
    expect(result.text).toBe('<a href="http://a.example/">raw</a>');
    expect(result.links).toEqual([]);
  });

  it('reads links from the bytes its text comes from: none past the 4 MiB read', async () => {
    const html = `<a href="a.html">a</a>${'x'.repeat(4 * 1024 * 1024)}<a href="b.html">b</a>`;
    const result = await fetchWith({ links: true }, SNAPSHOT, served(html));
    expect(result.truncatedAtBytes).toBe(4 * 1024 * 1024);
    expect(targets(result.links)).toEqual([{ text: 'a', url: 'https://www.nasa.gov/a.html' }]);
  });

  describe('in linear time', () => {
    /** `n` characters of `unit(i)` for i = 0, 1, 2, …, so each repeat can name a different target. */
    const fill = (unit: (i: number) => string, n: number): string => {
      let html = '';
      for (let i = 0; html.length < n; i++) html += unit(i);
      return html.slice(0, n);
    };

    /** Link lists of every shape: distinct targets with and without text, one target repeated, targets left out, `<base>` runs, an unclosed anchor. */
    const WORST_CASES: readonly [string, (n: number) => string][] = [
      [
        'distinct label-less links',
        (n) => fill((i) => `<a href="/web/2012/http://e.com/${i}"></a>`, n),
      ],
      ['distinct labelled links', (n) => fill((i) => `<a href="p${i}.html">p${i}</a> `, n)],
      ['one target repeated', (n) => fill(() => '<a href="x.html">x</a> ', n)],
      [
        'one target repeated without text, then with',
        (n) => `${fill(() => '<a href="x.html"></a>', n - 22)}<a href="x.html">x</a>`,
      ],
      ['self and fragment links', (n) => fill((i) => `<a href="#s${i}">s</a> `, n)],
      [
        'rewritten mailto: links',
        (n) => fill((i) => `<a href="/web/2012/mailto:a${i}@e.com">m</a> `, n),
      ],
      [
        'runs of <base href>',
        (n) => `${fill(() => '<base href="/web/2012/http://b.example/">', n - 20)}<a href=x>x</a>`,
      ],
      [
        'an unclosed <a> before long text',
        (n) => `<a href="x.html">${fill(() => 'word ', n - 17)}`,
      ],
      [
        'one long line ending in a break inside an anchor',
        (n) => `<a href=x>${fill(() => '§1 x', n - 12)}\ny`,
      ],
      ['breaks throughout an anchor', (n) => `<a href=x>${fill(() => '  \r\n', n - 10)}`],
    ];

    /** CPU ceiling per call: 0.5 µs per character, about 10× the slowest shape measured (16 ms at 320k). */
    const MAX_CPU_MS_PER_CHAR = 0.0005;

    /** One fetchContent call with links over `html`, as a thunk to time. */
    const fetchOver = (html: string) => {
      const svc = buildService();
      const ctx = createMockContext({ errors: iaGetSnapshot.errors });
      return () => {
        fetchWithTimeout.mockResolvedValueOnce(served(html));
        return svc.fetchContent(SNAPSHOT, ctx, startCallDeadline(ctx.signal), { links: true });
      };
    };

    it.each(WORST_CASES)(
      'reads the links of %s in linear time',
      async (_name, build) => {
        await expectLinearDoubling((n) => fetchOver(build(n)), MAX_CPU_MS_PER_CHAR);
      },
      0,
    );
  });
});

describe('fetchContent text-level tags, hidden content, and templates (#75, #76)', () => {
  const WIKI =
    'https://web.archive.org/web/20141230091718/https://en.wikipedia.org/wiki/ISO_3166-1';

  /** The text and links of `html` served as an HTML replay of the ISO 3166-1 capture. */
  const read = async (html: string) => {
    fetchWithTimeout.mockResolvedValueOnce(served(html));
    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const result = await buildService().fetchContent(WIKI, ctx, startCallDeadline(ctx.signal), {
      links: true,
    });
    return { text: result.text, links: result.links };
  };

  it('adds no separator at a text-level tag, and keeps one at an image', async () => {
    const { text, links } = await read(
      '<p>Name changes <i>(<a href="/wiki/Afghanistan">Afghanistan</a>, <a href="/wiki/Azerbaijan">Azerbaijan</a>)</i></p><p><b>H</b>ello<img src="x.png">world</p>',
    );
    expect(text).toBe('Name changes (Afghanistan, Azerbaijan)\nHello world');
    expect(text).toHaveLength(50);
    expect(links).toEqual([
      { offset: 14, text: 'Afghanistan', url: 'https://en.wikipedia.org/wiki/Afghanistan' },
      { offset: 27, text: 'Azerbaijan', url: 'https://en.wikipedia.org/wiki/Azerbaijan' },
    ]);
  });

  it('leaves out a hidden phrasing element and the link inside it, and keeps a hidden block', async () => {
    const { text, links } = await read(
      '<p>Visible <span style="display:none"><a href="/wiki/Hidden">secret</a></span><a href="/wiki/Shown">shown</a>.</p><div hidden>Block</div>',
    );
    expect(text).toBe('Visible shown.\nBlock');
    expect(text).toHaveLength(20);
    expect(links).toEqual([
      { offset: 8, text: 'shown', url: 'https://en.wikipedia.org/wiki/Shown' },
    ]);
  });

  it('leaves out a template and the link inside it, and reads a declarative shadow root', async () => {
    const { text, links } = await read(
      '<p>Before<template><a href="/wiki/Template">T</a></template> after</p><div><template shadowrootmode="open"><a href="/wiki/Shadow">S</a></template></div>',
    );
    expect(text).toBe('Before after\nS');
    expect(text).toHaveLength(14);
    expect(links).toEqual([{ offset: 13, text: 'S', url: 'https://en.wikipedia.org/wiki/Shadow' }]);
  });
});

describe('fetchContent character references (#8)', () => {
  it.each([
    ['&#160;', 'a&#160;b', 'a b'],
    ['&#8217;', 'it&#8217;s', 'it’s'],
    ['&#x2014;', 'a&#x2014;b', 'a—b'],
    ['&#X41;', '&#X41;', 'A'],
    ['&rsaquo;', '&rsaquo; Learn', '› Learn'],
    ['&mdash;', 'a&mdash;b', 'a—b'],
    ['&copy;', '&copy; 2012', '© 2012'],
    ['&uuml;', 'M&uuml;nchen', 'München'],
    ['&lang; (WHATWG code point)', '&lang;x&rang;', '⟨x⟩'],
  ])('decodes %s', async (_name, html, want) => {
    expect(await textOf(html)).toBe(want);
  });

  it('decodes each reference exactly once', async () => {
    expect(await textOf('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
  });

  it('resolves names case-sensitively', async () => {
    expect(await textOf('&Uuml;|&uuml;|&AMP;|&NBSP;')).toBe('Ü|ü|&|&NBSP;');
  });

  it('remaps numeric references 0x80–0x9F through Windows-1252', async () => {
    expect(await textOf('&#149; &#151; &#150; &#x80;')).toBe('• — – €');
  });

  it.each([
    '&constructor;',
    '&toString;',
    '&__proto__;',
    '&hasOwnProperty;',
    '&#0;',
    '&#xD800;',
    '&#xDFFF;',
    '&#1114112;',
    '&#x110000;',
    '&#99999999999999999999;',
    'AT&T',
    '&copy 2004',
    '&;',
    '&#;',
    '&#x;',
  ])('passes %s through verbatim', async (html) => {
    expect(await textOf(html)).toBe(html);
  });

  it('turns &nbsp; and &#160; into an ordinary space', async () => {
    const text = await textOf('a&nbsp;b&#160;c&#xA0;d');
    expect(text).toBe('a b c d');
    expect(text).not.toContain(' ');
  });

  it('decodes the navigation text of the nasa.gov 2012 capture', async () => {
    const html =
      '<div id="nav"><a href="/audience/forpublic/">For Public</a> &#160;&#160;&#160;|&#160;&#160;&#160; ' +
      '<a href="/audience/foreducators/">For Educators</a></div>' +
      '<p class="more"><a href="/about/">&rsaquo; Learn How</a></p>';
    const text = await textOf(html);
    expect(text).toBe('For Public | For Educators\n› Learn How');
    expect(text).not.toMatch(/&#?\w+;/);
  });
});

describe('fetchContent markup removal (#8)', () => {
  it.each([
    ['</script >', '<script>var x=1</script >after'],
    ['</script foo="bar">', '<script>x</script foo="bar">after'],
    ['</script\\t\\n bar>', '<script>x</script\t\n bar>after'],
    ['</SCRIPT>', '<SCRIPT>x</SCRIPT>after'],
    ['</STYLE >', '<STYLE>p{}</STYLE >after'],
    ['</style foo>', '<style media="x">p{}</style foo>after'],
  ])('closes the element at %s', async (_name, html) => {
    expect(await textOf(html)).toBe('after');
  });

  it('keeps a script body open past a non-end tag that shares its prefix', async () => {
    expect(await textOf('<script>a="</scripts>"</script>after')).toBe('after');
  });

  it('removes a comment whole, markup inside included', async () => {
    expect(await textOf('a<!-- <li>Moon & Mars</li> -->b')).toBe('a b');
  });

  it('removes a comment closed with --!>', async () => {
    expect(await textOf('a<!-- <li>x</li> --!>b')).toBe('a b');
  });

  it('removes abruptly closed empty comments', async () => {
    expect(await textOf('a<!-->b<!--->c')).toBe('a b c');
  });

  it('ignores a > inside a quoted attribute value', async () => {
    expect(await textOf('<img alt=">">text')).toBe('text');
    expect(await textOf('<img alt=\'a>b\' title="c>d">text')).toBe('text');
    expect(await textOf('<a href = "x>y">text</a>')).toBe('text');
  });

  it('treats a quote outside an attribute value as an ordinary character', async () => {
    // Wayback's rewriter leaves attribute soup like this in the lemonde.fr 2004 capture.
    const html =
      '<a href="/depeches/" onclick="xt_clic(\'N\',\'Les" depeches\') class="nh-btm-zop">' +
      'Les Dépêches</a></td><td><a href="/desk/">Le Desk</a>';
    expect(await textOf(html)).toBe('Les Dépêches Le Desk');
    expect(await textOf('<a b=c"d>text</a>')).toBe('text');
  });

  it('runs an unterminated quoted value to the end of the page', async () => {
    expect(await textOf('before<img alt="never closed>after')).toBe('before');
  });

  it('keeps references produced by decoding as text, never as markup', async () => {
    expect(await textOf('&lt;script&gt;alert(1)&lt;/script&gt; ok')).toBe(
      '<script>alert(1)</script> ok',
    );
  });

  it('drops the rest of the page after an unclosed comment or script', async () => {
    expect(await textOf('before<!-- never closed <p>x</p>')).toBe('before');
    expect(await textOf('before<script>never closed <p>x</p>')).toBe('before');
  });
});

describe('fetchContent scan time (#8)', () => {
  /** Repeat `unit` to exactly `n` characters. */
  const fill = (unit: string, n: number): string =>
    unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

  const WORST_CASES: readonly [string, (n: number) => string][] = [
    ['unclosed <', (n) => fill('<', n)],
    ['unclosed <a', (n) => fill('<a', n)],
    ['nested openers <a<a…>>', (n) => `${fill('<a', n / 2)}${'>'.repeat(n / 2)}`],
    ['unclosed <!--', (n) => fill('<!--', n)],
    ['unclosed <!-', (n) => fill('<!-', n)],
    ['unclosed <script>', (n) => fill('<script>', n)],
    ['unclosed <script', (n) => fill('<script', n)],
    ['</script with no > after an open script', (n) => `<script>${fill('</script ', n - 8)}`],
    ['</style\\t prefixes after an open style', (n) => `<style>${fill('</style\t', n - 7)}`],
    ['overlapping prefixes <scri<script<!-<!--', (n) => fill('<scri<script<!-<!--', n)],
    ['quote soup <a"', (n) => fill('<a"', n)],
    ['mixed quotes <a \'"', (n) => fill('<a \'"', n)],
    ['one unpaired quote after many tags', (n) => `${fill('<a b ', n - 1)}"`],
    ['<script with quoted attributes and no >', (n) => `<script${fill(' a="x"', n - 8)}"`],
    ['<script with bare attributes and no >', (n) => `<script ${fill('abc ', n - 9)}"`],
    ['<a with quoted > in attributes and no >', (n) => `<a${fill(" a='x>y'", n - 2)}`],
    ['<script with = and spaces, no quote, no >', (n) => `<script${fill(' b=   c', n - 7)}`],
    ['<a with stray quotes around =', (n) => `<a${fill(' b"=\'c', n - 2)}`],
    ['unterminated references &#1', (n) => fill('&#1', n)],
    ['unterminated names &amp', (n) => fill('&amp', n)],
    ['meta openers <meta', (n) => fill('<meta ', n)],
    ['meta charset= then spaces', (n) => `<meta charset=${' '.repeat(n - 14)}`],
  ];

  /** CPU ceiling for one 160k-character call: about 10× the slowest case measured (2.8 ms). */
  const LINEAR_160K_MAX_CPU_MS = 30;

  /** One fetchContent call over `html`, as a thunk to time. */
  const fetchOver = (html: string) => {
    const svc = buildService();
    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    return () => {
      fetchWithTimeout.mockResolvedValueOnce(served(html));
      return svc.fetchContent(SNAPSHOT, ctx, startCallDeadline(ctx.signal));
    };
  };

  it.each(WORST_CASES)(
    'scans %s in linear time',
    async (_name, build) => {
      await expectLinearScaling((n) => fetchOver(build(n)), LINEAR_160K_MAX_CPU_MS);
    },
    CPU_TIMED_TEST_TIMEOUT_MS,
  );

  it.each([
    ['<', '<'],
    ['<a', '<a'],
    ['<!--', '<!--'],
    ['<script>', '<script>'],
    ['<a"', '<a"'],
  ])(
    'strips 40,000 repetitions of %s within 1 s of CPU',
    async (_name, unit) => {
      expect(await cpuMsPerCall(fetchOver(unit.repeat(40_000)))).toBeLessThan(1_000);
    },
    CPU_TIMED_TEST_TIMEOUT_MS,
  );
});

describe('fetchContent charset (#25)', () => {
  const PAGE = '<p>Actualités, Multimédia</p>';
  const WANT = 'Actualités, Multimédia';

  it('decodes with the Content-Type charset', async () => {
    const result = await fetchContent(
      served(latin1(PAGE), { contentType: 'text/html; charset=ISO-8859-1' }),
    );
    expect(result.text).toBe(WANT);
  });

  it('decodes with a quoted Content-Type charset', async () => {
    const result = await fetchContent(
      served(latin1(PAGE), { contentType: 'text/html;charset="windows-1252"' }),
    );
    expect(result.text).toBe(WANT);
  });

  it('decodes with an http-equiv declaration placed after the Wayback banner scripts', async () => {
    const banner =
      '<script type="text/javascript" src="https://web-static.archive.org/_static/js/bundle-playback.js" charset="utf-8"></script>\n'.repeat(
        10,
      );
    const html =
      `<!-- Rosae:: Mercredi 9 Juin 2004 -->\n<html>\n <head>${banner}<!-- End Wayback Rewrite JS Include -->\n` +
      '<title>Le Monde.fr : A la Une</title>\n' +
      '<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">\n' +
      `</head><body>${PAGE}</body></html>`;
    expect(html.indexOf('<meta')).toBeGreaterThan(1024);
    const result = await fetchContent(served(latin1(html)));
    expect(result.text).toBe(`Le Monde.fr : A la Une\n${WANT}`);
    expect(result.text).not.toContain('�');
  });

  it('decodes with a meta charset attribute', async () => {
    const html = `<meta charset="windows-1252">${PAGE} &#8212; \x93quoted\x94`;
    expect((await fetchContent(served(latin1(html)))).text).toBe(`${WANT}\n— “quoted”`);
  });

  it('prefers the Content-Type charset over the document declaration', async () => {
    const html = `<meta charset="iso-8859-1">${PAGE}`;
    const result = await fetchContent(
      served(new TextEncoder().encode(html), { contentType: 'text/html; charset=utf-8' }),
    );
    expect(result.text).toBe(WANT);
  });

  it('ignores a declaration inside a comment', async () => {
    const html = `<!-- <meta charset="iso-8859-1"> -->${PAGE}`;
    expect((await fetchContent(served(new TextEncoder().encode(html)))).text).toBe(WANT);
  });

  it('prefers a UTF-8 byte-order mark over any declaration', async () => {
    const utf8 = new TextEncoder().encode(`<meta charset="iso-8859-1">${PAGE}`);
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
    const result = await fetchContent(
      served(bytes, { contentType: 'text/html; charset=iso-8859-1' }),
    );
    expect(result.text).toBe(WANT);
  });

  it('reads a meta-declared UTF-16 as UTF-8, since the declaration itself was ASCII', async () => {
    const html = `<meta charset="utf-16">${PAGE}`;
    expect((await fetchContent(served(new TextEncoder().encode(html)))).text).toBe(WANT);
  });

  it.each([
    ['an unknown Content-Type label', 'text/html; charset=x-no-such-charset', ''],
    ['an unknown meta label', 'text/html', '<meta charset="x-no-such-charset">'],
    ['the replacement encoding', 'text/html; charset=iso-2022-kr', ''],
  ])('falls back to UTF-8 on %s', async (_name, contentType, prefix) => {
    const bytes = new TextEncoder().encode(`${prefix}${PAGE}`);
    await expect(fetchContent(served(bytes, { contentType }))).resolves.toMatchObject({
      text: WANT,
    });
  });

  it('decodes as UTF-8 when no charset is declared anywhere', async () => {
    const result = await fetchContent(
      served(new TextEncoder().encode(PAGE), { contentType: null }),
    );
    expect(result.text).toBe(WANT);
  });

  it('only reads a declaration within the first 16 KiB', async () => {
    const html = `${'<p>filler</p>'.repeat(1_300)}<meta charset="iso-8859-1">${PAGE}`;
    expect(html.indexOf('<meta')).toBeGreaterThan(16_384);
    const result = await fetchContent(served(new TextEncoder().encode(html)));
    expect(result.text.endsWith(WANT)).toBe(true);
  });
});

describe('fetchContent guessed charset (#25)', () => {
  const PAGE = '<p>The Rest \xa9 1997-99 Rob Malda, Actualit\xe9s</p>';
  const WANT = 'The Rest © 1997-99 Rob Malda, Actualités';
  const guessed = (label: string) => ({ headers: { 'x-archive-guessed-charset': label } });

  it('decodes an undeclared Latin-1 page with the replay’s guessed charset', async () => {
    const result = await fetchContent(served(latin1(PAGE), guessed('iso-8859-1')));
    expect(result.text).toBe(WANT);
    expect(result.text).not.toContain('�');
  });

  it('prefers a meta declaration over the guessed charset', async () => {
    const html = new TextEncoder().encode(`<meta charset="utf-8"><p>Actualités</p>`);
    const result = await fetchContent(served(html, guessed('iso-8859-1')));
    expect(result.text).toBe('Actualités');
  });

  it('prefers the Content-Type charset over the guessed charset', async () => {
    const html = new TextEncoder().encode('<p>Actualités</p>');
    const result = await fetchContent(
      served(html, { contentType: 'text/html; charset=utf-8', ...guessed('iso-8859-1') }),
    );
    expect(result.text).toBe('Actualités');
  });

  it('decodes undeclared non-UTF-8 bytes with a guess that differs from windows-1252', async () => {
    // ISO-8859-7 (Greek): windows-1252 would read these bytes as áèçíá.
    const result = await fetchContent(
      served(latin1('<p>\xe1\xe8\xe7\xed\xe1</p>'), guessed('iso-8859-7')),
    );
    expect(result.text).toBe('αθηνα');
  });

  it('keeps a valid UTF-8 page as UTF-8 under a guessed label TextDecoder does not know', async () => {
    const html = new TextEncoder().encode('<p>Actualités</p>');
    await expect(fetchContent(served(html, guessed('ibm852')))).resolves.toMatchObject({
      text: 'Actualités',
    });
  });

  it('keeps an undeclared page that is valid UTF-8 as UTF-8 despite a wrong guess', async () => {
    const page = '<p>Actualités — 20 € · München · 東京 · 😀</p>';
    const bytes = new TextEncoder().encode(page);
    const result = await fetchContent(served(bytes, guessed('iso-8859-2')));
    // What 0.2.0's response.text() decoded, with markup removed.
    expect(result.text).toBe(
      new TextDecoder()
        .decode(bytes)
        .replace(/<\/?p>/g, '')
        .trim(),
    );
    expect(result.text).toBe('Actualités — 20 € · München · 東京 · 😀');
  });

  it('decodes undeclared bytes that are not UTF-8 as windows-1252 when the guess is unknown', async () => {
    // slashdot.org 1999: Latin-1 bytes, guessed `ibm852`, which TextDecoder does not know.
    const html = latin1('<p>the PEZ\xae mark. The Rest \xa9 1997-99</p>');
    const result = await fetchContent(served(html, guessed('ibm852')));
    expect(result.text).toBe('the PEZ® mark. The Rest © 1997-99');
  });

  it('decodes undeclared bytes that are not UTF-8 as windows-1252 when nothing is guessed', async () => {
    const result = await fetchContent(served(latin1('<p>Actualit\xe9s \x93quoted\x94</p>')));
    expect(result.text).toBe('Actualités “quoted”');
  });

  it('decodes leniently as UTF-8 when the guess itself is UTF-8 but the bytes are not', async () => {
    const result = await fetchContent(served(latin1('<p>Actualit\xe9s</p>'), guessed('utf-8')));
    expect(result.text).toBe('Actualit\ufffds');
  });
});

/**
 * Each case streams and decodes about 4 MiB: a few hundred milliseconds on an idle machine,
 * but past Vitest's 5 s default when other processes hold the cores. Nothing here asserts
 * on time, so the wall-clock timeout only needs room never to decide the result.
 */
describe('fetchContent byte ceiling (#28)', { timeout: 60_000 }, () => {
  const CEILING = 4 * 1024 * 1024;
  const CHUNK = 64 * 1024;

  /**
   * A replay body streamed in `CHUNK`-byte pieces, built lazily from `chunkAt(i)` for
   * `chunks` chunks. Records how many chunks the reader pulled and whether it cancelled.
   */
  const streamed = (chunks: number, chunkAt: (i: number) => Uint8Array) => {
    const stats = { pulled: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (stats.pulled >= chunks) {
          controller.close();
          return;
        }
        controller.enqueue(chunkAt(stats.pulled++));
      },
      cancel() {
        stats.cancelled = true;
      },
    });
    return { body, stats };
  };

  const ascii = (text: string) => new TextEncoder().encode(text);
  /** A `CHUNK`-byte run of `<p>word</p>` paragraphs, padded with spaces. */
  const paragraphChunk = (word: string) => {
    const unit = ascii(`<p>${word}</p>`);
    const chunk = new Uint8Array(CHUNK).fill(0x20);
    for (let at = 0; at + unit.length <= CHUNK; at += unit.length) chunk.set(unit, at);
    return chunk;
  };

  it('stops reading at the ceiling, cancels the upstream body, and reports the cut', async () => {
    const { body, stats } = streamed(200, () => paragraphChunk('word'));

    const result = await fetchContent(served(body));

    expect(result.truncatedAtBytes).toBe(CEILING);
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThan(200);
    expect(stats.pulled * CHUNK).toBeLessThanOrEqual(CEILING + 2 * CHUNK);
    expect(result.text.startsWith('word\nword')).toBe(true);
  });

  it('extracts no markup from a tag the cut splits', async () => {
    const tag = ascii(
      '<a href="https://example.com/a-very-long-link-that-the-cut-splits">link</a>',
    );
    const lead = paragraphChunk('lead');
    const cutChunk = CEILING / CHUNK - 1;
    const { body } = streamed(80, (i) => {
      if (i !== cutChunk && i !== cutChunk + 1) return lead;
      const chunk = new Uint8Array(CHUNK).fill(0x20);
      if (i === cutChunk) chunk.set(tag.subarray(0, 30), CHUNK - 30);
      else chunk.set(tag.subarray(30), 0);
      return chunk;
    });

    const result = await fetchContent(served(body));

    expect(result.truncatedAtBytes).toBe(CEILING);
    expect(result.text.endsWith('lead')).toBe(true);
    expect(result.text).not.toContain('<a');
    expect(result.text).not.toContain('href');
  });

  it('drops a multi-byte character the cut splits instead of emitting U+FFFD', async () => {
    const cutChunk = CEILING / CHUNK - 1;
    const { body } = streamed(80, (i) => {
      if (i !== cutChunk) return paragraphChunk('é');
      const chunk = new Uint8Array(CHUNK).fill(0x78);
      chunk.set([0xc3, 0xa9, 0xc3], CHUNK - 3);
      return chunk;
    });

    const result = await fetchContent(served(body));

    expect(result.truncatedAtBytes).toBe(CEILING);
    expect(result.text).not.toContain('�');
    expect(result.text.endsWith('xé')).toBe(true);
  });

  it('keeps a cut UTF-8 body as UTF-8 under a wrong guess when the cut splits a character', async () => {
    const cutChunk = CEILING / CHUNK - 1;
    const { body } = streamed(80, (i) => {
      if (i !== cutChunk) return paragraphChunk('é');
      const chunk = new Uint8Array(CHUNK).fill(0x78);
      chunk.set([0xc3, 0xa9, 0xc3], CHUNK - 3);
      return chunk;
    });

    const result = await fetchContent(
      served(body, { headers: { 'x-archive-guessed-charset': 'iso-8859-2' } }),
    );

    expect(result.truncatedAtBytes).toBe(CEILING);
    expect(result.text.startsWith('é\né')).toBe(true);
    expect(result.text.endsWith('xé')).toBe(true);
  });

  it('reads a body that ends exactly at the ceiling in full, with no cut reported', async () => {
    const { body, stats } = streamed(CEILING / CHUNK, () => paragraphChunk('w'));

    const result = await fetchContent(served(body));

    expect(result.truncatedAtBytes).toBeUndefined();
    expect(stats.cancelled).toBe(false);
    expect(stats.pulled).toBe(CEILING / CHUNK);
  });

  it('reads a page under the ceiling whole, as before', async () => {
    const result = await fetchContent(served('<p>small page</p>'));
    expect(result).toMatchObject({ text: 'small page' });
    expect(result.truncatedAtBytes).toBeUndefined();
  });

  it('sniffs the charset from the head of a cut body', async () => {
    const head = latin1('<meta charset="iso-8859-1"><p>Actualit\xe9s</p>');
    const { body } = streamed(80, (i) => {
      if (i > 0) return paragraphChunk('x');
      const chunk = new Uint8Array(CHUNK).fill(0x20);
      chunk.set(head, 0);
      return chunk;
    });

    const result = await fetchContent(served(body));

    expect(result.truncatedAtBytes).toBe(CEILING);
    expect(result.text.slice(0, 20)).toBe('Actualités\nx\nx\nx\nx\nx');
  });
});

describe('fetchContent served status (#19)', () => {
  it('reports the HTTP status Wayback replayed the served capture with', async () => {
    const result = await fetchContent(served('<p>x</p>', { status: 203 }));
    expect(result.status).toBe('203');
  });
});

describe('fetchContent media-type routing (#49)', () => {
  const GITHUB = 'https://web.archive.org/web/20200116122222/https://api.github.com/';
  const GITHUB_RAW = 'https://web.archive.org/web/20200116122222id_/https://api.github.com/';
  /** The first two keys of the 2020-01-16 api.github.com capture, as each replay form serves them. */
  const GITHUB_JSON =
    '{"current_user_url":"https://api.github.com/user","current_user_authorizations_html_url":"https://github.com/settings/connections/applications{/client_id}"}';
  const GITHUB_JSON_REWRITTEN =
    '{"current_user_url":"https://web.archive.org/web/20200116122222/https://api.github.com/user","current_user_authorizations_html_url":"https://web.archive.org/web/20200116122222/https://github.com/settings/connections/applications{/client_id}"}';
  const utf8 = (text: string) => new TextEncoder().encode(text);

  /** A body that counts reads and records a cancel; nothing is pulled until a read asks for it. */
  const tracked = (body: Uint8Array) => {
    const stats = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          stats.pulled++;
          controller.enqueue(body);
          controller.close();
        },
        cancel() {
          stats.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, stats };
  };

  /** fetchContent of `snapshotUrl`, the upstream answering each request in turn with `responses`. */
  const fetchServed = (snapshotUrl: string, ...responses: Response[]) => {
    for (const response of responses) fetchWithTimeout.mockResolvedValueOnce(response);
    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    return buildService().fetchContent(snapshotUrl, ctx, startCallDeadline(ctx.signal));
  };
  const requestedUrls = () => fetchWithTimeout.mock.calls.map((call) => String(call[0]));

  it.each([
    ['text/html', 'text/html'],
    ['application/xhtml+xml', 'application/xhtml+xml'],
    ['an HTML type in mixed case with parameters', 'Text/HTML ; charset=UTF-8'],
    ['no Content-Type', null],
    ['a Content-Type naming no subtype', 'unk'],
  ])('extracts %s from the plain form as HTML, in one request', async (_name, contentType) => {
    const result = await fetchServed(
      SNAPSHOT,
      served(utf8('<p>a</p>\n<p>b &amp; c</p>'), { contentType }),
    );
    expect(result.text).toBe('a\nb & c');
    expect(requestedUrls()).toEqual([SNAPSHOT]);
  });

  it('reads a JSON capture from its id_ form, leaving the URL-rewritten plain body unread', async () => {
    const plain = tracked(utf8(GITHUB_JSON_REWRITTEN));
    const json = 'application/json; charset=utf-8';

    const result = await fetchServed(
      GITHUB,
      served(plain.stream, {
        contentType: json,
        headers: { 'x-archive-guessed-charset': 'utf-8' },
      }),
      served(utf8(GITHUB_JSON), { contentType: json }),
    );

    expect(result.text).toBe(GITHUB_JSON);
    expect(result).toMatchObject({ replayUrl: GITHUB, timestamp: '20200116122222', status: '200' });
    expect(requestedUrls()).toEqual([GITHUB, GITHUB_RAW]);
    expect(plain.stats).toEqual({ pulled: 0, cancelled: true });
  });

  it.each([
    'text/plain; charset=utf-8',
    'TEXT/CSS',
    'text/xml',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/rss+xml',
    'application/ld+json',
  ])('reads a %s capture from its id_ form as text', async (contentType) => {
    const body = 'a <b>c</b>\n  &amp; d';
    const result = await fetchServed(
      SNAPSHOT,
      served(utf8('rewritten'), { contentType }),
      served(utf8(body), { contentType }),
    );
    expect(result.text).toBe(body);
    expect(requestedUrls()).toEqual([
      SNAPSHOT,
      'https://web.archive.org/web/20120601000000id_/https://www.nasa.gov',
    ]);
  });

  it('decodes a text body with the charset its id_ response declares', async () => {
    const result = await fetchServed(
      SNAPSHOT,
      served(utf8('rewritten'), { contentType: 'text/plain; charset=iso-8859-1' }),
      served(latin1('Actualit\xe9s'), { contentType: 'text/plain; charset=iso-8859-1' }),
    );
    expect(result.text).toBe('Actualités');
  });

  it('decodes an undeclared non-UTF-8 text body with the charset Wayback guessed for the capture', async () => {
    const result = await fetchServed(
      SNAPSHOT,
      served(utf8('rewritten'), {
        contentType: 'text/plain',
        headers: { 'x-archive-guessed-charset': 'iso-8859-7' },
      }),
      served(latin1('\xe1\xe8\xe7\xed\xe1'), { contentType: 'text/plain' }),
    );
    expect(result.text).toBe('αθηνα');
  });

  it('reads no <meta> declaration in a text body', async () => {
    const body = '<meta charset="iso-8859-1"> Actualités';
    const result = await fetchServed(
      SNAPSHOT,
      served(utf8('rewritten'), { contentType: 'text/plain' }),
      served(utf8(body), { contentType: 'text/plain' }),
    );
    expect(result.text).toBe(body);
  });

  it('decodes a text body by its byte-order mark first', async () => {
    const utf16le = Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0xe9, 0x00]);
    const result = await fetchServed(
      SNAPSHOT,
      served(utf8('rewritten'), { contentType: 'text/plain; charset=iso-8859-1' }),
      served(utf16le, { contentType: 'text/plain; charset=iso-8859-1' }),
    );
    expect(result.text).toBe('Aé');
  });

  it('cuts an id_ body at the byte ceiling and cancels the rest', async () => {
    const CEILING = 4 * 1024 * 1024;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled++ === 100) return controller.close();
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await fetchServed(
      SNAPSHOT,
      served(utf8('rewritten'), { contentType: 'text/plain' }),
      served(body, { contentType: 'text/plain' }),
    );

    expect(result.truncatedAtBytes).toBe(CEILING);
    expect(result.text).toBe('a'.repeat(CEILING));
    expect(cancelled).toBe(true);
  });

  it.each([
    ['application/pdf', 'application/pdf'],
    ['image/png', 'image/png'],
    ['application/octet-stream', 'application/octet-stream'],
    ['Application/PDF; name="f1040.pdf"', 'application/pdf'],
    ['application/constructor', 'application/constructor'],
    ['__proto__/__proto__', '__proto__/__proto__'],
  ])('fails a %s capture as non-text without reading its body', async (contentType, mediaType) => {
    const pdf = tracked(latin1('%PDF-1.7\r%\xe2\xe3\xcf\xd3\r\n922 0 obj\r<</Linearized'));

    const err = await fetchServed(SNAPSHOT, served(pdf.stream, { contentType })).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining(mediaType),
      data: { mediaType, replayUrl: SNAPSHOT },
    });
    expect(err).not.toHaveProperty('data.redirects');
    expect(requestedUrls()).toEqual([SNAPSHOT]);
    expect(pdf.stats).toEqual({ pulled: 0, cancelled: true });
  });
});
