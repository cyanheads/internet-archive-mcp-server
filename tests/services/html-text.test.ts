/**
 * @fileoverview Unit tests for the HTML text extractors: `htmlToText`, which turns an
 * archived page into one line of text, and `descriptionToText`, which turns an item
 * description into lines of text — its line rules, links, single reference decode,
 * adversarial markup, real Metadata API values, and linear scan time.
 * @module tests/services/html-text.test
 */

import { describe, expect, it } from 'vitest';
import { descriptionToText, htmlToText } from '@/services/html-text.js';
import { cpuMsPerCall } from '../helpers/cpu-time.js';

describe('htmlToText', () => {
  it.each([
    ['block elements on one line', '<p>Hello</p>\n\n<p>world</p>', 'Hello world'],
    ['divs and line breaks', '<div>a</div><div>b</div>x\n\ny<br>z', 'a b x y z'],
    ['an anchor and its href', '<a href="http://example.com/">label</a>.', 'label .'],
    ['a comment', 'a<!-- <li>x</li> -->b', 'a b'],
    ['a script body', '<script>var x = "<p>";</script >after', 'after'],
    ['references, once', '&amp;lt;b&amp;gt; &copy; &#x2014; &#150;', '&lt;b&gt; © — –'],
    ['a non-breaking space', 'a&nbsp;b&#160;c', 'a b c'],
    [
      'undeclared names',
      '&constructor; &__proto__; &toString;',
      '&constructor; &__proto__; &toString;',
    ],
    ['a bare <', 'a < b and 3<4', 'a < b and 3<4'],
    ['an unclosed tag', 'before<img alt="never closed>after', 'before'],
    ['edge whitespace', '  \t<b> x </b>\n ', 'x'],
  ])('keeps its output for %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });
});

describe('descriptionToText line structure', () => {
  it.each([
    ['<br>', 'a<br>b', 'a\nb'],
    ['<br/>', 'a<br/>b', 'a\nb'],
    ['<br />', 'a<br />b', 'a\nb'],
    ['<BR>', 'a<BR>b', 'a\nb'],
    ['</br>, read as <br> like a browser does', 'a</br>b', 'a\nb'],
    ['two <br> as a blank line', 'a<br><br>b', 'a\n\nb'],
    ['a <div> start tag after text', 'a<div>b', 'a\nb'],
    ['adjacent </div><div> as one break', '<div>a</div><div>b</div>', 'a\nb'],
    ['<p> paragraphs', '<p>a</p><p>b</p>', 'a\nb'],
    ['<li> items inside a list', '<ul><li>a</li><li>b</li></ul>', 'a\nb'],
    ['block tags in any case and with space before >', '<DIV>a</DIV ><P >b</p\t>', 'a\nb'],
    ['a <br> after a block end as a blank line', '<div>a</div><br><div>b</div>', 'a\n\nb'],
    ['a block end after a <br> as no extra break', 'a<br></div>b', 'a\nb'],
    ['an empty <div><br></div> line between two lines', 'a<div><br></div>b', 'a\n\nb'],
  ])('breaks the line at %s', (_name, html, want) => {
    expect(descriptionToText(html)).toBe(want);
  });

  it.each([
    ['<pre>', 'a<pre>b'],
    ['<link>', 'a<link>b'],
    ['<abbr>', 'a<abbr>b'],
    ['<span>', 'a<span>b'],
    ['<b>', 'a<b>b'],
  ])('reads %s as a space, not a line break', (_name, html) => {
    expect(descriptionToText(html)).toBe('a b');
  });

  it('keeps the line breaks already in a plain-text value, CRLF and CR included', () => {
    expect(descriptionToText('Set 1\n\nNew Minglewood Blues  \nLoser  ')).toBe(
      'Set 1\n\nNew Minglewood Blues\nLoser',
    );
    expect(descriptionToText('a\r\nb\rc\n\r\nd')).toBe('a\nb\nc\n\nd');
  });

  it('takes a line break right after a block boundary as that boundary’s break', () => {
    expect(descriptionToText('<p>a</p>\n<p>b</p>')).toBe('a\nb');
    expect(descriptionToText('<li>a</li>  \r\n  <li>b</li>')).toBe('a\nb');
    expect(descriptionToText('<p>a</p>\n\n<p>b</p>')).toBe('a\n\nb');
    expect(descriptionToText('a\n<div>b</div>')).toBe('a\nb');
  });

  it('collapses spaces, tabs, and non-breaking spaces within a line and trims each line', () => {
    expect(descriptionToText(' a \t b&nbsp;&nbsp;c  \nd&#160; ')).toBe('a b c\nd');
  });

  it('drops blank lines at both ends and keeps them inside', () => {
    expect(descriptionToText('<div><br></div>\n \na<br><br>\n\nb<br /><div><br /></div>\n')).toBe(
      'a\n\n\n\nb',
    );
    expect(descriptionToText('<div><br></div>&nbsp;<br>')).toBe('');
  });

  it('returns an empty string for an empty value', () => {
    expect(descriptionToText('')).toBe('');
  });
});

describe('descriptionToText links', () => {
  it.each([
    [
      'label then URL',
      'See <a href="http://example.com/x">the page</a> now.',
      'See the page (http://example.com/x) now.',
    ],
    [
      'the URL once when the label is the URL',
      'At <a href="http://example.com/x" rel="nofollow">http://example.com/x</a>.',
      'At http://example.com/x.',
    ],
    [
      'the URL once when the label matches it after decoding and whitespace collapse',
      '<a href="http://example.com/?a=1&amp;b=2"> http://example.com/?a=1&#38;b=2 </a>',
      'http://example.com/?a=1&b=2',
    ],
    [
      'the URL alone for an empty label',
      'IMDB <a href="http://example.com/t"></a>',
      'IMDB http://example.com/t',
    ],
    ['a decoded href', '<a href="/s?q=a&amp;r=b">find</a>', 'find (/s?q=a&r=b)'],
    ['a single-quoted href', "<a href='http://example.com/'>x</a>", 'x (http://example.com/)'],
    ['an unquoted href', '<a href=http://example.com/>x</a>', 'x (http://example.com/)'],
    [
      'a > inside a quoted href',
      '<a href="http://example.com/?a>b">x</a>',
      'x (http://example.com/?a>b)',
    ],
    [
      'an upper-case HREF after other attributes',
      '<A class="c" HREF = "http://example.com/">x</A>',
      'x (http://example.com/)',
    ],
    [
      'tabs and line breaks stripped from an href',
      '<a href=" http://exa\tmple.com/\n">x</a>',
      'x (http://example.com/)',
    ],
    [
      'a label holding a line break',
      '<a href="http://example.com/">one<br>two</a>',
      'one\ntwo (http://example.com/)',
    ],
    [
      'an unclosed anchor closed at the end of the value',
      'go <a href="http://example.com/">there',
      'go there (http://example.com/)',
    ],
    [
      'an anchor opened inside another, which closes the first',
      '<a href="http://example.com/1">one<a href="http://example.com/2">two</a>',
      'one (http://example.com/1) two (http://example.com/2)',
    ],
    ['an anchor with no href as its label', '<a name="top">Top</a> of page', 'Top of page'],
    ['an anchor with an empty href as its label', '<a href=" ">Top</a>', 'Top'],
    ['</a> with no opener as nothing', 'a</a>b</a >', 'ab'],
  ])('renders %s', (_name, html, want) => {
    expect(descriptionToText(html)).toBe(want);
  });

  it.each([
    ['data-href', '<a data-href="http://example.com/x">x</a>'],
    ['href inside another attribute’s value', '<a title=" href=http://example.com/x">x</a>'],
    ['hreflang', '<a hreflang="en">x</a>'],
    ['href with no value', '<a href>x</a>'],
  ])('ignores %s', (_name, html) => {
    expect(descriptionToText(html)).toBe('x');
  });
});

describe('descriptionToText character references', () => {
  it('decodes each reference once, after markup is removed', () => {
    expect(descriptionToText('&amp;lt;b&amp;gt; &lt;div&gt;x&lt;/div&gt;')).toBe(
      '&lt;b&gt; <div>x</div>',
    );
  });

  it('keeps an escaped anchor as literal text', () => {
    expect(descriptionToText('IMDB &lt;a href="http://example.com/t"&gt;&lt;/a&gt;')).toBe(
      'IMDB <a href="http://example.com/t"></a>',
    );
  });

  it.each([
    '&constructor;',
    '&__proto__;',
    '&toString;',
    '&hasOwnProperty;',
    '&#xD800;',
    '&#55296;',
    '&#0;',
    '&#x110000;',
    'AT&T',
    '&copy 2004',
  ])('passes %s through verbatim', (text) => {
    expect(descriptionToText(text)).toBe(text);
  });

  it('decodes &copy; &#8217; &#x2014; and Windows-1252 &#150;', () => {
    expect(descriptionToText('&copy; it&#8217;s a&#x2014;b &#150;')).toBe('© it’s a—b –');
  });
});

describe('descriptionToText adversarial markup', () => {
  it.each([
    ['a comment holding block markup', 'a<!-- <div>x</div><br> -->b', 'a b'],
    ['a comment closed with --!>', 'a<!-- <p>x --!>b', 'a b'],
    ['CDATA, a bogus comment that ends at the first >', '<![CDATA[<div>x</div>]]>', 'x\n]]>'],
    ['a script body holding block markup', 'a<script>"<div><br>"</script>b', 'a b'],
    ['a style body', 'a<style>p{}</style >b', 'a b'],
    ['nested-tag reassembly of a script', '<scr<b>ipt>alert(1)</script>', 'ipt>alert(1)'],
    ['nested-tag reassembly of a div', 'a<di<div>v>b', 'a v>b'],
    ['an unclosed tag, which runs to the end', 'before<div class="x>after', 'before'],
    ['an unclosed comment', 'before<!-- <div>x', 'before'],
    ['a bare < that opens no tag', 'a < b and 3<4<br>c', 'a < b and 3<4\nc'],
  ])('handles %s', (_name, html, want) => {
    expect(descriptionToText(html)).toBe(want);
  });
});

describe('descriptionToText on Metadata API descriptions (2026-11-12)', () => {
  it('splits CrackedUpNoCC into two lines and keeps its escaped anchor literal', () => {
    const html =
      '<div>"Seventeen-year-old track star, John Owens, has never used any drug stronger than pot, until he meets an older woman who introduces him to crack cocaine. He quickly becomes addicted but is able to hide his problem from all except his best friend, Chris. - Written by Herman Seifer "</div><div>-from IMDB &lt;a href="http://www.imdb.com/title/tt0092792/?ref_=ttpl_pl_tt" rel="nofollow"&gt;&lt;/a&gt;</div>';
    const lines = descriptionToText(html).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^"Seventeen-year-old track star, .* - Written by Herman Seifer "$/);
    expect(lines[1]).toBe(
      '-from IMDB <a href="http://www.imdb.com/title/tt0092792/?ref_=ttpl_pl_tt" rel="nofollow"></a>',
    );
  });

  it('keeps gd1977-05-08 one song per line with its set breaks', () => {
    const text = descriptionToText(
      "Set 1\n\nNew Minglewood Blues  \nLoser  \nEl Paso  \nLazy Lightnin'  ->\nSupplication  \n\nEncore\nOne More Saturday Night",
    );
    expect(text).toBe(
      "Set 1\n\nNew Minglewood Blues\nLoser\nEl Paso\nLazy Lightnin' ->\nSupplication\n\nEncore\nOne More Saturday Night",
    );
  });

  it('reads elmo-612-r-1018-r-users-manual-j as three lines with no trailing blank line', () => {
    expect(
      descriptionToText(
        "ELMO SUPER 612R<div>ELMO SUPER 1018R</div><div>User's Manual (Japanese)</div><div><br /></div>",
      ),
    ).toBe("ELMO SUPER 612R\nELMO SUPER 1018R\nUser's Manual (Japanese)");
  });

  it('reads the arkivkopia.se link as its URL once', () => {
    expect(
      descriptionToText(
        'Mer information på <a href="http://arkivkopia.se/sak/digmus-tek-TEKA0007051" rel="ugc nofollow">http://arkivkopia.se/sak/digmus-tek-TEKA0007051</a>.',
      ),
    ).toBe('Mer information på http://arkivkopia.se/sak/digmus-tek-TEKA0007051.');
  });

  it('reads the gov.uscourts.mieb.653252 link as label (URL)', () => {
    expect(
      descriptionToText(
        '<a href="http://www.archive.org/download/gov.uscourts.mieb.653252/gov.uscourts.mieb.653252.docket.html" rel="ugc nofollow">Click here</a> to see available docket information and document downloads for this case.  If you need the complete docket, you should consult PACER directly.',
      ),
    ).toBe(
      'Click here (http://www.archive.org/download/gov.uscourts.mieb.653252/gov.uscourts.mieb.653252.docket.html) to see available docket information and document downloads for this case. If you need the complete docket, you should consult PACER directly.',
    );
  });

  it('reads cleveoh-Healthy_Cleveland_-_Health_Literacy as five <br>-separated lines', () => {
    expect(
      descriptionToText(
        'TV20, We Are Cleveland! <br />Want to stay up to date on all things Cleveland? Follow us on Facebook and Twitter. <br />https://www.facebook.com/ClevelandTV20/<br />https://twitter.com/TV20Cleveland<br />http://www.tv20cleveland.com/',
      ),
    ).toBe(
      'TV20, We Are Cleveland!\nWant to stay up to date on all things Cleveland? Follow us on Facebook and Twitter.\nhttps://www.facebook.com/ClevelandTV20/\nhttps://twitter.com/TV20Cleveland\nhttp://www.tv20cleveland.com/',
    );
  });
});

describe('descriptionToText scan time', () => {
  /** Repeat `unit` to exactly `n` characters. */
  const fill = (unit: string, n: number): string =>
    unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

  /**
   * The worst cases the Wayback suite times `htmlToText` on, then the shapes that load the
   * description rules: links, block boundaries, line breaks, and the per-line pass. None
   * crosses into Bun's slower regular-expression mode below 320k characters (measured), so
   * every shape runs the full 64× span.
   */
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
    ['unclosed <a href="', (n) => fill('<a href="', n)],
    ['</a> with no opener', (n) => fill('</a>', n)],
    ['runs of <div></div>', (n) => fill('<div></div>', n)],
    ['links, each closing the last', (n) => fill('<a href=x>y', n)],
    ['runs of <br>', (n) => fill('<br>', n)],
    [
      'one unclosed link with a long label',
      (n) => `<a href="http://example.com/">${fill('x ', n - 29)}`,
    ],
    ['one link with a long encoded href', (n) => `<a href="${fill('&amp;', n - 15)}">x</a>`],
    ['an <a with many attributes', (n) => `<a${fill(' b=c', n - 3)}>`],
    ['an <a with many bare href attributes', (n) => `<a${fill(' href', n - 3)}>`],
    ['paragraphs, each followed by a line break', (n) => fill('<p>a</p>\n', n)],
    ['one long line ending in a break', (n) => `${fill('§1 x', n - 2)}\ny`],
    ['breaks throughout', (n) => fill('  \r\n', n)],
    ['a long digit run', (n) => '1'.repeat(n)],
  ];

  /** Smallest input; each larger size doubles it, up to 64× at 320k. */
  const BASE = 5_000;
  const LARGEST = 320_000;

  /** CPU ceiling per call: 1 µs per character, about 12× the slowest shape measured (27 ms at 320k). */
  const MAX_CPU_MS_PER_CHAR = 0.001;

  it.each(WORST_CASES)(
    'converts %s in linear time',
    async (_name, build) => {
      const base = build(BASE);
      for (let n = BASE * 2; n <= LARGEST; n *= 2) {
        const large = build(n);
        let growth = Number.POSITIVE_INFINITY;
        for (let round = 0; round < 3; round++) {
          const tBase = await cpuMsPerCall(() => descriptionToText(base));
          const tLarge = await cpuMsPerCall(() => descriptionToText(large));
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
