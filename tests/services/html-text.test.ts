/**
 * @fileoverview Unit tests for the HTML text extractors. `htmlToText` turns an archived
 * page into lines: block and `<br>` line breaks, tab-separated table cells, `<pre>` text
 * as written, the same words with one separator between each outside `<pre>`, and linear
 * scan time. `descriptionToText` turns an item description into lines of text — its line
 * rules, links, single reference decode, adversarial markup, real Metadata API values,
 * and linear scan time.
 * @module tests/services/html-text.test
 */

import { describe, expect, it } from 'vitest';
import {
  descriptionToText,
  htmlToText,
  htmlToTextAndAnchors,
  type PageAnchor,
} from '@/services/html-text.js';
import { expectLinearDoubling } from '../helpers/cpu-time.js';

describe('htmlToText', () => {
  it.each([
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
    ['a reference split by markup', '&am<b></b>p;', '&am p;'],
    ['a decoded <pre> as text', '&lt;pre&gt;  a  b', '<pre> a b'],
  ])('keeps its output for %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it('reads each whitespace character a regular expression’s \\s matches as a space, and no other', () => {
    const misread: string[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const char = String.fromCharCode(code);
      if (char === '<') continue;
      const want = /\s/.test(char) ? 'a b' : `a${char}b`;
      if (htmlToText(`a${char}b`) !== want) misread.push(code.toString(16));
    }
    expect(misread).toEqual([]);
  });
});

describe('htmlToText lines (#66)', () => {
  /** The block elements of the HTML Rendering section: blocks, list items, and table rows. */
  const BLOCK_ELEMENTS = [
    'address',
    'article',
    'aside',
    'blockquote',
    'body',
    'caption',
    'center',
    'dd',
    'details',
    'dialog',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hgroup',
    'hr',
    'legend',
    'li',
    'main',
    'menu',
    'nav',
    'ol',
    'p',
    'pre',
    'search',
    'section',
    'summary',
    'table',
    'tbody',
    'tfoot',
    'thead',
    'tr',
    'ul',
  ];

  it.each(BLOCK_ELEMENTS)('starts a new line at a <%s> start or end tag', (name) => {
    expect(htmlToText(`a<${name}>b</${name}>c`)).toBe('a\nb\nc');
  });

  it.each([
    'span',
    'b',
    'a',
    'font',
    'html',
    'head',
    'title',
    'button',
    'img',
    'dir',
    'listing',
    'xmp',
    'h7',
    'divx',
    'p-x',
    'preamble',
    'tdx',
  ])('reads <%s> as a space', (name) => {
    expect(htmlToText(`a<${name}>b</${name}>c`)).toBe('a b c');
  });

  it.each([
    ['a block element in upper case', 'a<BLOCKQUOTE>b', 'a\nb'],
    ['an end tag with whitespace before >', '<p>a</p\n>b</div >c', 'a\nb\nc'],
    ['a start tag with attributes', '<div class="x>y" id=z>a</div>b', 'a\nb'],
    ['a name only non-ASCII case folding would turn into blockquote', 'a<blocKquote>b', 'a b'],
  ])('matches whole element names: %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it.each([
    ['<p> paragraphs', '<p>Hello</p>\n\n<p>world</p>', 'Hello\nworld'],
    ['divs, then text with a <br>', '<div>a</div><div>b</div>x\n\ny<br>z', 'a\nb\nx y\nz'],
    ['adjacent block boundaries as one break', '<ul><li>a</li>\n  <li>b</li></ul><p>c', 'a\nb\nc'],
    ['two <br> as a blank line', 'a<br><br>b', 'a\n\nb'],
    ['three <br> as one blank line', 'a<br><br><br>b', 'a\n\nb'],
    ['</br>, read as <br> like a browser does', 'a</br>b', 'a\nb'],
    ['a <br> after a block end as a blank line', '<div>a</div><br><div>b</div>', 'a\n\nb'],
    ['a block boundary after a <br> as no extra break', 'a<br></div><p>b', 'a\nb'],
    ['spaces around a line break', 'a <br> b <p> c', 'a\nb\nc'],
    [
      'a page’s title, then its body',
      '<html><head><title>T</title></head><body><p>Hello</p></body></html>',
      'T\nHello',
    ],
  ])('breaks lines at %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it.each([
    ['line breaks at both ends', '<br><p>\n<br>a<br><br></p> <br>', 'a'],
    ['block boundaries at both ends', '<div><p><ul><li>a</li></ul></p></div>', 'a'],
    ['a row of empty cells at the end', 'a<tr><td></td><td> </td></tr>', 'a'],
    ['empty cells after the text of a row', '<tr><td>a</td><td></td><td></td></tr>', 'a'],
    ['a page of separators only', '<br><td></td><td></td><p> &nbsp; </p><pre>\n \n\t</pre>', ''],
  ])('writes no separator a rule leaves at the start or end: %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });
});

describe('htmlToText table cells (#66)', () => {
  it.each([
    ['adjacent cells', '<td>Home</td><td>News</td>', 'Home\tNews'],
    ['an empty first cell', '<tr><td></td><td>x</td></tr>', '\tx'],
    [
      'header and data rows',
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
      'A\tB\n1\t2',
    ],
    ['an empty cell inside a row', '<tr><td>a</td><td></td><td>c</td></tr>', 'a\t\tc'],
    [
      'an empty first cell on a later row',
      '<tr><td>a</td></tr><tr><td></td><td>b</td></tr>',
      'a\n\tb',
    ],
    ['spaces beside a tab', '<td> a </td> \n <td> b </td>', 'a\tb'],
    ['cells with no row tags', '<table><td>a<td>b</table>', 'a\tb'],
    ['a <tbody> that starts a new row', '<td>a</td><tbody><td>b</td>', 'a\nb'],
    ['a </tr> with whitespace before >', '<td>a</td></tr\n><td>b</td>', 'a\nb'],
    [
      'cell start tags with attributes, case, and whitespace',
      '<td>a</td><TD\nclass="x">b</TD><th/>c',
      'a\tb\tc',
    ],
    ['a > inside quoted cell attributes', '<td title="a>b">x</td><td title=\'>\'>y</td>', 'x\ty'],
    ['a <tdx>, which is not a cell', '<td>a</td><tdx>b', 'a b'],
    ['a <br> inside a cell', '<tr><td>a<br>b</td><td>c</td></tr>', 'a\nb\tc'],
    ['a block after the text of a row', '<tr><td>a</td><td><p>x</p></td></tr>', 'a\nx'],
    [
      'a block that opens a later cell, which takes the place of its tab',
      '<tr><td>a</td></tr><tr><td></td><td><div>x</div></td></tr>',
      'a\nx',
    ],
    [
      'a row of empty cells, then a row',
      '<tr><td>a</td></tr><tr><td></td><td></td></tr><tr><td>b</td></tr>',
      'a\nb',
    ],
    [
      'a script and a style between cells',
      '<tr><td>a</td><script>x</script><style>p{}</style><td>b</td></tr>',
      'a\tb',
    ],
    [
      'a table nested in a cell, then the outer row’s next cell',
      '<table><tr><td>a<table><tr><td>b</td><td>c</td></tr></table></td><td>d</td></tr></table>',
      'a\nb\tc\n\td',
    ],
    ['nested tables never closed', '<table><tr><td>a<table><tr><td>b<table><tr><td>c', 'a\nb\nc'],
    ['a </table> with no opener', '<td>a</td></table><td>b</td>', 'a\nb'],
    ['a cell tag cut at the end of the page', 'a<td>b<td', 'a b'],
  ])('separates %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });
});

describe('htmlToText <pre> (#66)', () => {
  it.each([
    ['spacing, tabs, and blank lines', '<pre>\n  a\tb\n\n\nc</pre>', '  a\tb\n\n\nc'],
    [
      'an RFC contents line with an inline anchor',
      '<p>Contents</p><pre>   <a href="#section-1">1</a>.  Introduction....1\n</pre>',
      'Contents\n   1.  Introduction....1',
    ],
    ['only the line feed directly after the start tag', '<p>a</p><pre>\n\nx</pre>', 'a\n\nx'],
    [
      'a line feed after markup that follows the start tag',
      '<p>a</p><pre><b></b>\nx</pre>',
      'a\n\nx',
    ],
    ['CRLF and CR line breaks', '<p>a</p><pre>\r\nx\r\ny\rz</pre>', 'a\nx\ny\nz'],
    ['every <br>', '<pre>a<br><br><br>b</pre>', 'a\n\n\nb'],
    ['text before and after', 'x <pre> a </pre> y', 'x\n a\ny'],
    [
      'inline markup, comments, and scripts as nothing',
      '<pre>a<span>b</span><!-- <p> -->c<script>d</script>e</pre>',
      'abce',
    ],
    ['block tags inside', '<pre>a <div>b</div> c</pre>', 'a\nb\n c'],
    ['a <pre> nested in a <pre>', '<pre>a<pre> b</pre> c</pre> d', 'a\n b\n c\nd'],
    ['a <pre> that never closes', 'x<pre>a  b\n  c', 'x\na  b\n  c'],
    [
      'an end tag in upper case or with whitespace before >',
      '<PRE>a  b</PRE >c  d<pre>e  f</pre\n>g  h',
      'a  b\nc d\ne  f\ng h',
    ],
    ['no-break spaces', '<pre>a&nbsp;&nbsp;b</pre>', 'a  b'],
    ['decoded line breaks as line feeds', '<pre>a&#10;b&#13;c</pre>', 'a\nb\nc'],
    ['spaces and tabs at a line end as nothing', '<pre>a  \n  b \t\n   \nc</pre>', 'a\n  b\n\nc'],
    [
      'a reference split by inline markup, decoded per text run',
      '<pre>&am<b></b>p;</pre>',
      '&amp;',
    ],
    ['a row’s first cell inside, joined to the text before it', '<pre>a<td>b</pre>', 'ab'],
    [
      'a <pre> inside a cell, then the next cell after a tab',
      '<td>a<pre>  x  </pre></td><td>b</td>',
      'a\n  x\n\tb',
    ],
    [
      'a table inside, its cells tab-separated, then the spacing after it',
      '<pre>a<table><tr><td>b</td><td>c</td></tr></table>  d</pre>',
      'a\nb\tc\n  d',
    ],
  ])('keeps %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it.each([
    ['a </pre> with no opener', 'a</pre>  b  c', 'a\nb c'],
    ['<preamble>', '<preamble>  a  b', 'a b'],
    ['a comment holding <pre>', 'a<!-- <pre> -->  b  c', 'a b c'],
    [
      'CDATA holding <pre>, a bogus comment that ends at the first >',
      'a<![CDATA[<pre>]]>  b  c',
      'a ]]> b c',
    ],
    ['a <pre> cut at the end of the page', 'a  b<pre', 'a b'],
  ])('collapses whitespace after %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });
});

describe('htmlToText adversarial markup (#66)', () => {
  it.each([
    ['a comment holding block markup', 'a<!-- <p>x</p><br><td> -->b', 'a b'],
    [
      'CDATA holding a block, a bogus comment that ends at the first >',
      'a<![CDATA[<p>x</p>]]>b',
      'a x\n]]>b',
    ],
    ['a script body holding block markup', 'a<script>"<div><br><td>"</script>b', 'a b'],
    ['nested-tag reassembly of a div, one tag named di<div', 'a<di<div>v>b', 'a v>b'],
    ['a block tag cut at the end of the page', 'a<br', 'a'],
    ['an unclosed attribute value on a cell', 'a<td title="x', 'a'],
  ])('handles %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });
});

describe('htmlToText words outside <pre> (#66)', () => {
  /** Mulberry32: the same pages on every run. */
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  /** A word as markup and as the text it reads as. */
  const WORDS: readonly (readonly [string, string])[] = [
    ['a', 'a'],
    ['Bc', 'Bc'],
    ['x&amp;y', 'x&y'],
    ['&copy;2', '©2'],
    ['3<4', '3<4'],
    ['測試', '測試'],
    ['&#x41;', 'A'],
    ['&bogus;', '&bogus;'],
    ['AT&T', 'AT&T'],
  ];
  const ELEMENTS = [
    'p',
    'div',
    'li',
    'h2',
    'hr',
    'caption',
    'table',
    'tbody',
    'thead',
    'tr',
    'td',
    'th',
    'br',
    'span',
    'b',
    'a',
    'img',
  ];
  const ATTRIBUTES = ['', ' class="x>y"', " title='a'", '\n', ' /'];
  const OTHER_SEPARATORS = [
    ' ',
    '\t',
    '\n',
    '\r\n',
    '  \n ',
    '&nbsp;',
    '&#32;',
    '&#9;',
    '　',
    '<!-- <p>x</p> -->',
    '<script>a<br>b</script>',
    '<style>td{}</style>',
    '<!DOCTYPE html>',
  ];

  /** A page of words and separators with no `<pre>`, and its words joined by one space. */
  const page = (next: () => number): { html: string; words: string } => {
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
    const separator = (): string => {
      if (next() < 0.4) return pick(OTHER_SEPARATORS);
      const name = pick(ELEMENTS);
      return `<${next() < 0.4 ? '/' : ''}${next() < 0.3 ? name.toUpperCase() : name}${pick(ATTRIBUTES)}>`;
    };
    const separators = (least: number): string => {
      let html = '';
      for (let n = least + Math.floor(next() * 3); n > 0; n--) html += separator();
      return html;
    };
    const words: string[] = [];
    let html = separators(0);
    for (let count = 1 + Math.floor(next() * 12); count > 0; count--) {
      const [markup, text] = pick(WORDS);
      words.push(text);
      html += markup + separators(count > 1 ? 1 : 0);
    }
    return { html, words: words.join(' ') };
  };

  const PAGES = 2_000;

  it('reads the same words, a run of line breaks and tabs where one space separated two', () => {
    const next = prng(66);
    for (let i = 0; i < PAGES; i++) {
      const { html, words } = page(next);
      const spaced = htmlToText(html).replace(/[\t\n]+/g, ' ');
      // An empty first cell leads the text with a tab, where a space would have been trimmed.
      expect(spaced.startsWith(' ') ? spaced.slice(1) : spaced, JSON.stringify(html)).toBe(words);
    }
  });

  it('writes one separator between words: no space beside a break or tab, no tab ending a line, at most one blank line', () => {
    const next = prng(67);
    for (let i = 0; i < PAGES; i++) {
      const { html } = page(next);
      const text = htmlToText(html);
      expect(text, JSON.stringify(html)).not.toMatch(
        /^[\n ]|\s$|[^\S\t\n ]| {2}| [\t\n]|[\t\n] |\t\n|\n{3}/,
      );
    }
  });
});

describe('htmlToText scan time (#66)', () => {
  /** Repeat `unit` to exactly `n` characters. */
  const fill = (unit: string, n: number): string =>
    unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

  /**
   * The markup-scan worst cases the Wayback suite times through `fetchContent`, then the
   * shapes that load the page's line rules: cells, rows, line breaks, `<pre>`, nested
   * tables, separators that never meet text, and the two line-break shapes.
   */
  const WORST_CASES: readonly [string, (n: number) => string][] = [
    ['unclosed <', (n) => fill('<', n)],
    ['unclosed <a', (n) => fill('<a', n)],
    ['nested openers <a<a…>>', (n) => `${fill('<a', n / 2)}${'>'.repeat(n / 2)}`],
    ['unclosed <!--', (n) => fill('<!--', n)],
    ['unclosed <script>', (n) => fill('<script>', n)],
    ['</script with no > after an open script', (n) => `<script>${fill('</script ', n - 8)}`],
    ['overlapping prefixes <scri<script<!-<!--', (n) => fill('<scri<script<!-<!--', n)],
    ['quote soup <a"', (n) => fill('<a"', n)],
    ['<a with quoted > in attributes and no >', (n) => `<a${fill(" a='x>y'", n - 2)}`],
    ['unterminated references &#1', (n) => fill('&#1', n)],
    ['unterminated names &amp', (n) => fill('&amp', n)],
    ['runs of <td>', (n) => fill('<td>', n)],
    ['runs of <td>x', (n) => fill('<td>x', n)],
    ['rows of empty cells', (n) => fill('<tr><td></td><td>', n)],
    ['runs of <tr>', (n) => fill('<tr>', n)],
    ['runs of <br>', (n) => fill('<br>', n)],
    ['runs of <br>x', (n) => fill('<br>x', n)],
    ['runs of <div></div>', (n) => fill('<div></div>', n)],
    ['unclosed <pre> runs', (n) => fill('<pre>', n)],
    ['unclosed <pre>x runs', (n) => fill('<pre>x', n)],
    ['</pre> with no opener', (n) => fill('</pre>', n)],
    ['one unclosed <pre> holding tags and lines', (n) => `<pre>${fill('a <b>x</b>\n ', n - 5)}`],
    ['spaces between tags inside <pre>', (n) => `<pre>${fill(' <b>', n - 6)}x`],
    ['line breaks inside <pre>', (n) => `<pre>${fill('\n', n - 6)}x`],
    ['nested <table><tr><td> never closed', (n) => fill('<table><tr><td>', n)],
    [
      'nested tables, then their end tags',
      (n) => `${fill('<table><td>a', n / 2)}${fill('</table><td>', n / 2)}`,
    ],
    ['spaces, tabs, and no-break spaces', (n) => fill(' \t &nbsp;', n)],
    ['one long line ending in a break', (n) => `${fill('§1 x', n - 2)}\ny`],
    ['breaks throughout', (n) => fill('  \r\n', n)],
    ['a long digit run', (n) => '1'.repeat(n)],
  ];

  /** CPU ceiling per call: 1 µs per character, about 17× the slowest shape measured (19 ms at 320k). */
  const MAX_CPU_MS_PER_CHAR = 0.001;

  /** Asserts that `convert` over `build(n)` grows linearly as `n` doubles. */
  const expectLinearConversion = (
    build: (n: number) => string,
    convert: (html: string) => unknown,
  ): Promise<void> =>
    expectLinearDoubling((n) => {
      const html = build(n);
      return () => convert(html);
    }, MAX_CPU_MS_PER_CHAR);

  it.each(WORST_CASES)(
    'converts %s in linear time',
    async (_name, build) => {
      await expectLinearConversion(build, htmlToText);
    },
    0,
  );

  /** Shapes that load the anchor reading: many anchors, empty ones, one never closed, `<base>` runs, and long hrefs. */
  const ANCHOR_CASES: readonly [string, (n: number) => string][] = [
    ['runs of <a href>', (n) => fill('<a href="x">', n)],
    ['runs of <a href>x</a>', (n) => fill('<a href="x">x</a>', n)],
    ['distinct label-less links', (n) => fill('<a href="/web/2015/http://e.com/"></a>', n)],
    ['an unclosed <a> before long text', (n) => `<a href="x">${fill('word ', n - 12)}`],
    [
      'an unclosed <a> before one long line ending in a break',
      (n) => `<a href=x>${fill('§1 x', n - 12)}\ny`,
    ],
    ['an unclosed <a> before breaks throughout', (n) => `<a href=x>${fill('  \r\n', n - 10)}`],
    [
      'an unclosed <a> inside <pre> before spaced words',
      (n) => `<pre><a href=x>${fill(' x  ', n - 15)}`,
    ],
    ['runs of <base href>', (n) => fill('<base href="/web/1/http://b/">', n)],
    ['runs of <base> without href', (n) => fill('<base target="t">', n)],
    ['one <a> with many attributes and no href', (n) => `<a${fill(' b=c', n - 3)}>`],
    ['one <a> whose quoted href never closes', (n) => `<a href="${fill('x', n - 9)}`],
    ['references in one href', (n) => `<a href="${fill('&amp;', n - 12)}">x</a>`],
    ['<a href= openers before one >', (n) => `${fill('<a href=', n - 1)}>`],
  ];

  // A shape with no `<a` or `<base` tag takes the same path with anchors read as without.
  it.each([...WORST_CASES.filter(([name]) => name.includes('<a')), ...ANCHOR_CASES])(
    'reads the anchors of %s in linear time (#67)',
    async (_name, build) => {
      await expectLinearConversion(build, htmlToTextAndAnchors);
    },
    0,
  );
});

describe('htmlToTextAndAnchors (#67)', () => {
  const anchor = (href: string, offset: number, text: string): PageAnchor => ({
    href,
    offset,
    text,
  });

  it.each([
    [
      'an anchor’s text, its href’s references decoded',
      'foo <a href="x&amp;y">bar <b>baz</b></a> qux',
      [anchor('x&y', 4, 'bar baz')],
    ],
    [
      'an image-only anchor, at the end of the text before it',
      '<p>a</p><a href="1"><img alt="i"></a><p>b</p>',
      [anchor('1', 1, '')],
    ],
    ['an image-only anchor that starts the page', '<a href="1"><img></a>x', [anchor('1', 0, '')]],
    [
      'an <a> start tag closing the open anchor',
      '<a href=1>one<a href=2>two</a>',
      [anchor('1', 0, 'one'), anchor('2', 4, 'two')],
    ],
    [
      'an <a> without href: no link, but it closes the open one',
      '<a href=1>one<a name=x>two</a>',
      [anchor('1', 0, 'one')],
    ],
    ['stray </a> tags', 'a</a><a href=1>b</a></a>c', [anchor('1', 2, 'b')]],
    ['an unclosed <a> taking the rest of the page', '<a href=1>x <p>y', [anchor('1', 0, 'x y')]],
    [
      'text across a line break and a cell, on one line',
      '<table><tr><td><a href=4>c1<br>c1b</td><td>c2</a></td></tr></table>',
      [anchor('4', 0, 'c1 c1b c2')],
    ],
    [
      'text inside <pre>, each whitespace run one space',
      '<pre>\n  <a href=5>x   y\n z</a></pre>',
      [anchor('5', 2, 'x y z')],
    ],
    [
      'href values as written: any case, any quote, unquoted, empty',
      `<A HREF='/web/2015/http://a/'>u</A> <a href=  "  b  " >v</a> <a href=c>w</a> <a href="">x</a>`,
      [
        anchor('/web/2015/http://a/', 0, 'u'),
        anchor('  b  ', 2, 'v'),
        anchor('c', 4, 'w'),
        anchor('', 6, 'x'),
      ],
    ],
    [
      'no anchor inside a comment or a script body',
      '<!-- <a href=6>no</a> --><script>"<a href=7>"</script>z',
      [],
    ],
  ])('reads %s', (_name, html, anchors) => {
    const page = htmlToTextAndAnchors(html);
    expect(page.anchors).toEqual(anchors);
    expect(page.text).toBe(htmlToText(html));
  });

  it.each([
    [
      'the first <base> with an href, decoded',
      '<base target=_b><base href="/web/1/http://b/&amp;"><base href=c>',
      '/web/1/http://b/&',
    ],
    ['a <base> after the body text', 'x<base href=d>', 'd'],
    ['no <base href>', '<base target=_b><a href=x>x</a>', undefined],
  ])('reads %s', (_name, html, baseHref) => {
    expect(htmlToTextAndAnchors(html).baseHref).toBe(baseHref);
  });

  /** Mulberry32: the same pages on every run. */
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  /** Markup that separates words, each written with a space after it so no two words join. */
  const SEPARATORS = [
    '',
    '\n',
    '\t',
    '&nbsp;',
    '<br>',
    '<p>',
    '</p>',
    '<li>',
    '<tr>',
    '<td>',
    '<b>',
    '<img alt="i">',
    '<pre>',
    '</pre>',
    '<!-- <a href="c">c</a> -->',
    '<script>"<a href=s>s</a>"</script>',
    '<base target="t">',
  ];

  /**
   * A page of unique words, separators, `<a href>` anchors closed by `</a>`, a later `<a>`
   * start tag, an `<a>` without href, or the end of the page, and `<base>` tags; with the
   * anchors and base it holds, read from how it was built.
   */
  const page = (next: () => number) => {
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
    const built: { href: string; words: string[]; before: string | undefined }[] = [];
    let open: (typeof built)[number] | undefined;
    let lastWord: string | undefined;
    let baseHref: string | undefined;
    let html = '';
    const close = () => {
      if (open) built.push(open);
      open = undefined;
    };
    for (let i = 0, count = 1 + Math.floor(next() * 40); i < count; i++) {
      const r = next();
      if (r < 0.15) {
        close();
        html += `<a href="u${i}&amp;v">`;
        open = { href: `u${i}&v`, words: [], before: lastWord };
      } else if (r < 0.2) {
        html += '</a>';
        close();
      } else if (r < 0.23) {
        html += '<a name="n">';
        close();
      } else if (r < 0.26) {
        html += `<base href="b${i}&amp;x">`;
        baseHref ??= `b${i}&x`;
      } else if (r < 0.5) {
        html += `${pick(SEPARATORS)} `;
      } else {
        const word = `w${String(i).padStart(4, '0')}`;
        html += `${word} `;
        open?.words.push(word);
        lastWord = word;
      }
    }
    close();
    return { html, built, baseHref };
  };

  it('finds each anchor at its first word, its words joined by one space, the text as htmlToText reads it', () => {
    const next = prng(67);
    for (let i = 0; i < 2_000; i++) {
      const { html, built, baseHref } = page(next);
      const text = htmlToText(html);
      const want = built.map(({ href, words, before }) => {
        const [first] = words;
        if (first !== undefined) return anchor(href, text.indexOf(first), words.join(' '));
        return anchor(href, before === undefined ? 0 : text.indexOf(before) + before.length, '');
      });
      const got = htmlToTextAndAnchors(html);
      expect(got.text, JSON.stringify(html)).toBe(text);
      expect(got.anchors, JSON.stringify(html)).toEqual(want);
      expect(got.baseHref, JSON.stringify(html)).toBe(baseHref);
    }
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

  /** CPU ceiling per call: 1 µs per character, about 12× the slowest shape measured (27 ms at 320k). */
  const MAX_CPU_MS_PER_CHAR = 0.001;

  it.each(WORST_CASES)(
    'converts %s in linear time',
    async (_name, build) => {
      await expectLinearDoubling((n) => {
        const description = build(n);
        return () => descriptionToText(description);
      }, MAX_CPU_MS_PER_CHAR);
    },
    0,
  );
});
