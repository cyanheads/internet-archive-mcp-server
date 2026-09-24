/**
 * @fileoverview Tests for WaybackService.fetchContent — the text it extracts from an
 * archived page (markup removal, one-pass character-reference decoding, linear-time
 * scanning), the charset it decodes the body with, and the replay URL and timestamp
 * it reports for the capture Wayback actually served.
 * @module tests/services/wayback-content.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: Parameters<typeof fetchWithTimeout>) => fetchWithTimeout(...args),
    withRetry: <T>(fn: () => Promise<T>) => fn(),
  };
});

import { iaGetSnapshot } from '@/mcp-server/tools/definitions/ia-get-snapshot.tool.js';
import { WaybackService } from '@/services/wayback/wayback-service.js';

const SNAPSHOT = 'https://web.archive.org/web/20120601000000/https://www.nasa.gov';

const buildService = (): WaybackService =>
  new WaybackService({ mcpServerVersion: '0.0.0-test' } as AppConfig, {} as StorageService);

/** A 2xx replay response as `fetchWithTimeout` hands it back. */
const served = (
  body: BodyInit,
  {
    contentType = 'text/html',
    url,
    headers = {},
    status = 200,
  }: {
    contentType?: string | null;
    url?: string;
    headers?: Record<string, string>;
    status?: number;
  } = {},
): Response => {
  const response = new Response(body, {
    status,
    headers: { ...(contentType ? { 'content-type': contentType } : {}), ...headers },
  });
  if (url !== undefined) Object.defineProperty(response, 'url', { value: url });
  return response;
};

const fetchContent = (response: Response, maxChars?: number) => {
  fetchWithTimeout.mockResolvedValueOnce(response);
  return buildService().fetchContent(
    SNAPSHOT,
    createMockContext({ errors: iaGetSnapshot.errors }),
    maxChars,
  );
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
  it('drops script and style bodies, strips tags, and collapses whitespace', async () => {
    const html =
      '<html><head><title>T</title><style>p { color: red }</style>' +
      '<script>var x = 1;</script></head>\n<body>  <p>Hello</p>\n\n<p>world</p></body></html>';
    expect(await textOf(html)).toBe('T Hello world');
  });

  it('decodes the core references', async () => {
    expect(await textOf('&amp; &lt; &gt; &quot; &#039;')).toBe('& < > " \'');
  });

  it('leaves a bare < that opens no tag as text', async () => {
    expect(await textOf('a < b and 3<4')).toBe('a < b and 3<4');
  });

  it('separates adjacent cells with a space', async () => {
    expect(await textOf('<td>Home</td><td>News</td>')).toBe('Home News');
  });

  it('caps the text at maxChars', async () => {
    const result = await fetchContent(served(`<p>${'x'.repeat(100)}</p>`), 10);
    expect(result.text).toBe('x'.repeat(10));
  });

  it('decodes an undeclared UTF-8 page as UTF-8', async () => {
    const bytes = new TextEncoder().encode('<p>Actualités — ünïcödé</p>');
    expect((await fetchContent(served(bytes))).text).toBe('Actualités — ünïcödé');
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
    expect(text).toBe('For Public | For Educators › Learn How');
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

  /** Best per-call time over three batches of roughly 320k characters each. */
  const perCallMs = async (html: string): Promise<number> => {
    const svc = buildService();
    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const reps = Math.max(1, Math.round(320_000 / html.length));
    let best = Number.POSITIVE_INFINITY;
    for (let batch = 0; batch < 3; batch++) {
      const start = performance.now();
      for (let i = 0; i < reps; i++) {
        fetchWithTimeout.mockResolvedValueOnce(served(html));
        await svc.fetchContent(SNAPSHOT, ctx, 100);
      }
      best = Math.min(best, (performance.now() - start) / reps);
    }
    return best;
  };

  it.each(WORST_CASES)(
    'scans %s in linear time',
    async (_name, build) => {
      const t5k = await perCallMs(build(5_000));
      const t80k = await perCallMs(build(80_000));
      // Linear is ×16 across the span, quadratic ×256; headroom for per-call overhead and load.
      expect(t80k / Math.max(t5k, 0.005)).toBeLessThan(64);
      expect(t80k).toBeLessThan(250);
    },
    120_000,
  );

  it.each([
    ['<', '<'],
    ['<a', '<a'],
    ['<!--', '<!--'],
    ['<script>', '<script>'],
    ['<a"', '<a"'],
  ])(
    'strips 40,000 repetitions of %s within 1 s',
    async (_name, unit) => {
      const start = performance.now();
      await fetchContent(served(unit.repeat(40_000)));
      expect(performance.now() - start).toBeLessThan(1_000);
    },
    60_000,
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
    expect(result.text).toBe(`Le Monde.fr : A la Une ${WANT}`);
    expect(result.text).not.toContain('�');
  });

  it('decodes with a meta charset attribute', async () => {
    const html = `<meta charset="windows-1252">${PAGE} &#8212; \x93quoted\x94`;
    expect((await fetchContent(served(latin1(html)))).text).toBe(`${WANT} — “quoted”`);
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

describe('fetchContent replay URL (#19)', () => {
  const FINAL = 'https://web.archive.org/web/20200104000551/https://example.com/';

  it('reports the URL the fetch ended on and its capture timestamp', async () => {
    const result = await fetchContent(served('<p>x</p>', { url: FINAL }));
    expect(result).toMatchObject({ replayUrl: FINAL, timestamp: '20200104000551' });
  });

  it('reports the https form of a final web.archive.org URL', async () => {
    const result = await fetchContent(
      served('<p>x</p>', { url: 'http://web.archive.org/web/20200104000551/https://example.com/' }),
    );
    expect(result.replayUrl).toBe(FINAL);
  });

  it('reports the requested replay URL when the response carries no final URL', async () => {
    const result = await fetchContent(served('<p>x</p>', { url: '' }));
    expect(result).toMatchObject({ replayUrl: SNAPSHOT, timestamp: '20120601000000' });
  });

  it('reports the requested replay URL when the fetch ended off web.archive.org', async () => {
    const result = await fetchContent(served('<p>x</p>', { url: 'https://example.com/' }));
    expect(result).toMatchObject({ replayUrl: SNAPSHOT, timestamp: '20120601000000' });
  });

  it('keeps the requested URL when Wayback served it without a redirect', async () => {
    const result = await fetchContent(served('<p>x</p>', { url: SNAPSHOT }));
    expect(result).toMatchObject({ replayUrl: SNAPSHOT, timestamp: '20120601000000' });
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

describe('fetchContent byte ceiling (#28)', () => {
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

    const result = await fetchContent(served(body), 10_000_000);

    expect(result.truncatedAtBytes).toBe(CEILING);
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThan(200);
    expect(stats.pulled * CHUNK).toBeLessThanOrEqual(CEILING + 2 * CHUNK);
    expect(result.text.startsWith('word word')).toBe(true);
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

    const result = await fetchContent(served(body), 10_000_000);

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

    const result = await fetchContent(served(body), 10_000_000);

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
      10_000_000,
    );

    expect(result.truncatedAtBytes).toBe(CEILING);
    expect(result.text.startsWith('é é')).toBe(true);
    expect(result.text.endsWith('xé')).toBe(true);
  });

  it('reads a body that ends exactly at the ceiling in full, with no cut reported', async () => {
    const { body, stats } = streamed(CEILING / CHUNK, () => paragraphChunk('w'));

    const result = await fetchContent(served(body), 10_000_000);

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

    const result = await fetchContent(served(body), 20);

    expect(result.truncatedAtBytes).toBe(CEILING);
    expect(result.text).toBe('Actualités x x x x x');
  });
});

describe('fetchContent served status (#19)', () => {
  it('reports the HTTP status Wayback replayed the served capture with', async () => {
    const result = await fetchContent(served('<p>x</p>', { status: 203 }));
    expect(result.status).toBe('203');
  });
});
