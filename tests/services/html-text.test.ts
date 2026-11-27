/**
 * @fileoverview Unit tests for the HTML text extractors. `htmlToText` turns an archived
 * page into lines: block and `<br>` line breaks, tab-separated table cells, `<pre>` text
 * as written, text-level tags that add no separator, the same words with one separator
 * between each outside `<pre>`, the content of hidden phrasing elements and `<template>`
 * left out, and linear scan time. `descriptionToText` turns an item description into
 * lines of text — its line rules, links, single reference decode, adversarial markup,
 * real Metadata API values, and linear scan time.
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
    ['an anchor and its href', '<a href="http://example.com/">label</a>.', 'label.'],
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
    ['a reference split by markup', '&am<b></b>p;', '&amp;'],
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

  /** The text-level elements: phrasing elements that only hold text, and the obsolete inline elements. */
  const TEXT_LEVEL_ELEMENTS = [
    'a',
    'abbr',
    'acronym',
    'b',
    'bdi',
    'bdo',
    'big',
    'blink',
    'cite',
    'code',
    'data',
    'del',
    'dfn',
    'em',
    'font',
    'i',
    'ins',
    'kbd',
    'label',
    'mark',
    'nobr',
    'output',
    'q',
    'rb',
    'ruby',
    's',
    'samp',
    'small',
    'span',
    'strike',
    'strong',
    'sub',
    'sup',
    'time',
    'tt',
    'u',
    'var',
    'wbr',
  ];

  it.each(TEXT_LEVEL_ELEMENTS)('reads <%s> start and end tags as nothing (#75)', (name) => {
    expect(htmlToText(`a<${name}>b</${name}>c`)).toBe('abc');
    expect(htmlToText(`a<${name.toUpperCase()} class="x>y">b</${name}\n>c`)).toBe('abc');
  });

  it.each([
    'html',
    'head',
    'title',
    'button',
    'img',
    'input',
    'select',
    'option',
    'textarea',
    'iframe',
    'embed',
    'object',
    'video',
    'audio',
    'canvas',
    'svg',
    'math',
    'picture',
    'meter',
    'progress',
    'map',
    'area',
    'datalist',
    'slot',
    'noscript',
    'rt',
    'rp',
    'dir',
    'listing',
    'xmp',
    'h7',
    'divx',
    'p-x',
    'my-widget',
    'o:p',
    'spanx',
    'preamble',
    'tdx',
  ])('reads <%s> as a space', (name) => {
    expect(htmlToText(`a<${name}>b</${name}>c`)).toBe('a b c');
  });

  it.each([
    [
      'a footnote marker and the period after it',
      'word<sup><a href="#n">[1]</a></sup>.',
      'word[1].',
    ],
    ['a <wbr> inside a URL', 'http://example.com/<wbr>long', 'http://example.com/long'],
    ['a word whose first letter is larger', '<font size="+2">T</font>he', 'The'],
    ['a word that changes style partway', '<b>H</b>ello', 'Hello'],
    [
      'links in parentheses, each before a comma',
      'Name changes <i>(<a href="/wiki/Afghanistan" title="Afghanistan">Afghanistan</a>, <a href="/wiki/Azerbaijan">Azerbaijan</a>)</i>',
      'Name changes (Afghanistan, Azerbaijan)',
    ],
    ['CJK text with ruby bases', '世間を<ruby><rb>憚</rb></ruby>る', '世間を憚る'],
  ])('joins %s (#75)', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it.each([
    ['an image between words', 'Home<img src="x">About', 'Home About'],
    ['an input between labels', 'Name:<input>Email:', 'Name: Email:'],
    [
      'a ruby reading, apart from its base',
      '<ruby>東京<rt>とうきょう</rt></ruby>で',
      '東京 とうきょう で',
    ],
    ['a custom element', 'a<my-widget>b</my-widget>c', 'a b c'],
    ['a comment', 'a<!-- x -->b', 'a b'],
    ['a button', 'Search<button>Go</button>now', 'Search Go now'],
    [
      'the options of a select',
      '<select><option>Small</option><option>Large</option></select>',
      'Small Large',
    ],
  ])('keeps the separator of %s (#75)', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it.each([
    ['sibling links', '<a href=1>esp</a><a href=2>ame</a><a href=3>mex</a>', 'esp ame mex'],
    [
      'a link and the badge after it',
      '<a href=u>Bernardito</a><span class="flair">Moderator</span>',
      'Bernardito Moderator',
    ],
    ['a link whose label ends in another end tag', '<a href=1><b>x</b></a><a href=2>y</a>', 'x y'],
    ['links of digits', '<a>2020</a><a>2021</a>', '2020 2021'],
    ['links in another script', '<a>Москва</a><a>Париж</a>', 'Москва Париж'],
    ['links of astral letters, each read as one character', '<a>𝐀</a><a>𝐁</a>', '𝐀 𝐁'],
    [
      'two links with a hidden element between them, its content left out',
      '<a href=1>x</a><span hidden>h</span><a href=2>y</a>',
      'x y',
    ],
    ['tags in upper case with attributes', '<A HREF="x>y">x</A\n><SPAN class=a>y</SPAN>', 'x y'],
    ['a link after another element', '<b>x</b><a>y</a>', 'x y'],
    ['a timestamp and the category link after it', '<span>7h</span><a>Sport</a>', '7h Sport'],
    ['a label and the link after it', '<label>me</label><a>reset</a>', 'me reset'],
    ['an end tag right after the link’s', '<span><a>x</a></span><span>y</span>', 'x y'],
    [
      'links whose ends reach the next element through an end tag',
      '<span><a>x</a></span><span><a>y</a></span>',
      'x y',
    ],
    [
      'a link’s end and the next element, an </a> the parser drops between them',
      '<a>x</a></a><b>y</b>',
      'x y',
    ],
    [
      'an element’s end and the link after it, an </a> the parser drops between them',
      '<b>x</b></a><a>y</a>',
      'x y',
    ],
  ])(
    'keeps one space between two words where a link and the element beside it meet: %s (#75)',
    (_name, html, want) => {
      expect(htmlToText(html)).toBe(want);
    },
  );

  it.each([
    ['a superscript note marker after a link', '<a href=1>TL</a><sup>a</sup>', 'TLa'],
    ['a subscript after a link', '<a>H</a><sub>2</sub>O', 'H2O'],
    ['a link inside a superscript after an element', '<b>x</b><sup><a>1</a></sup>', 'x1'],
    ['CJK links', '<a>東京</a><a>大阪</a>', '東京大阪'],
    ['a CJK element and the link after it', '<span>東京</span><a>大阪</a>', '東京大阪'],
    ['kana links', '<a>ひらがな</a><a>カタカナ</a>', 'ひらがなカタカナ'],
    ['Hangul links', '<a>서울</a><a>부산</a>', '서울부산'],
    ['a Latin link beside a CJK one', '<a>abc</a><a>東京</a>', 'abc東京'],
    ['fullwidth Latin links', '<a>ＡＢ</a><a>ＣＤ</a>', 'ＡＢＣＤ'],
    ['punctuation opening the next element', '<a>x</a><a>,y</a>', 'x,y'],
    ['punctuation ending the link', '<a>x.</a><b>y</b>', 'x.y'],
    ['a symbol opening the next element', '<a>x</a><b>$5</b>', 'x$5'],
    ['text between the link and the next tag', '<a>x</a>y<b>z</b>', 'xyz'],
    ['text between an element and the link after it', '<b>x</b>y<a>z</a>', 'xyz'],
    ['an </a> with no <a> open, which ends no link', 'x</a><b>y</b>', 'xy'],
    [
      'an </a> with no <a> open before a link, which ends nothing',
      'a</a><a href=1>b</a></a>c',
      'abc',
    ],
    ['sibling links inside <pre>', '<pre><a>x</a><a>y</a></pre>', 'xy'],
    ['sibling elements with no link', '<b>Gam</b><i>ma</i>', 'Gamma'],
    ['sibling spans inside one link', '<a href=x><span>s</span><span>iː</span></a>', 'siː'],
    ['a link inside a note marker', 'x<sup><a>1</a></sup>', 'x1'],
    ['a link right after text, with no end tag before it', 'see<a>here</a>', 'seehere'],
  ])('joins %s, as text-level tags do (#75)', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
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

  /**
   * A word as markup, the text it reads as, and whether that text starts and ends with a
   * letter or digit outside CJK.
   */
  const WORDS: readonly (readonly [string, string, boolean, boolean])[] = [
    ['a', 'a', true, true],
    ['Bc', 'Bc', true, true],
    ['x&amp;y', 'x&y', true, true],
    ['&copy;2', '©2', false, true],
    ['3<4', '3<4', true, true],
    ['測試', '測試', false, false],
    ['&#x41;', 'A', true, true],
    ['&bogus;', '&bogus;', false, false],
    ['AT&T', 'AT&T', true, true],
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
    'sup',
    'img',
  ];
  /** The text-level names among `ELEMENTS`, whose tags read as nothing (#75). */
  const TEXT_LEVEL = new Set(['span', 'b', 'a', 'sup']);
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

  /**
   * A page of words and separators with no `<pre>`, and its words joined by one space, or
   * by nothing where only text-level tags stand between two — unless, among those tags, an
   * end tag comes directly before a start tag other than `<sup>`, a link tag comes, and a
   * letter or digit outside CJK stands on each side (#75). An `</a>` with no `<a>` open is
   * dropped, as the HTML parser drops it.
   */
  const page = (next: () => number): { html: string; words: string } => {
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
    /** An `<a>` is open, so the next `</a>` ends a link. */
    let linkOpen = false;
    /**
     * A separator: whether it reads as nothing; whether it is a start tag other than `<sup>`,
     * an end tag, or a link tag (an `<a>` start tag, or an `</a>` that ends a link); and
     * whether it is an `</a>` with no `<a>` open.
     */
    const separator = () => {
      if (next() < 0.4) {
        const markup = pick(OTHER_SEPARATORS);
        return { markup, nothing: false, start: false, end: false, linkTag: false, dropped: false };
      }
      const name = pick(ELEMENTS);
      const end = next() < 0.4;
      const markup = `<${end ? '/' : ''}${next() < 0.3 ? name.toUpperCase() : name}${pick(ATTRIBUTES)}>`;
      const dropped = end && name === 'a' && !linkOpen;
      if (name === 'a') linkOpen = !end;
      const start = !end && name !== 'sup';
      return { markup, nothing: TEXT_LEVEL.has(name), start, end, linkTag: name === 'a', dropped };
    };
    /**
     * A run of separators, whether every one in it reads as nothing, and whether, the dropped
     * `</a>` tags aside, an end tag in it comes directly before a start tag other than
     * `<sup>` and a link tag comes.
     */
    const separators = (least: number): readonly [string, boolean, boolean] => {
      let html = '';
      let joins = true;
      let elementsMeet = false;
      let atLink = false;
      let afterEndTag = false;
      for (let n = least + Math.floor(next() * 3); n > 0; n--) {
        const { markup, nothing, start, end, linkTag, dropped } = separator();
        html += markup;
        joins &&= nothing;
        if (dropped) continue;
        elementsMeet ||= afterEndTag && start;
        atLink ||= linkTag;
        afterEndTag = end;
      }
      return [html, joins, elementsMeet && atLink];
    };
    let [html] = separators(0);
    let words = '';
    let joined = false;
    let linkMeetsElement = false;
    let endsInWord = false;
    for (let count = 1 + Math.floor(next() * 12), first = true; count > 0; count--) {
      const [markup, text, startsWithWord, endsWithWord] = pick(WORDS);
      const together = joined && !(linkMeetsElement && endsInWord && startsWithWord);
      words += first || together ? text : ` ${text}`;
      first = false;
      const [after, joins, meet] = separators(count > 1 ? 1 : 0);
      html += markup + after;
      joined = joins;
      linkMeetsElement = meet;
      endsInWord = endsWithWord;
    }
    return { html, words };
  };

  const PAGES = 2_000;

  it('reads the same words, joined where only text-level tags stood between two (#75) unless a link and the element beside it met between letters or digits, a run of line breaks and tabs where one space separated two', () => {
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

/**
 * Shapes that load the inline-style reading, an `<a>` ending a hidden part, the elements
 * whose content is text, and declarative shadow roots; both scan-time suites time them.
 */
const RULE_CASES: readonly [string, (n: number) => string][] = (() => {
  const fill = (unit: string, n: number): string =>
    unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const styled = (style: string) => `<span style="${style}">x</span>`;
  return [
    ['one style of escapes', (n) => styled(fill('\\\\', n - 23))],
    ['one style of hex escapes', (n) => styled(fill('\\6e ', n - 23))],
    ['one style of open parentheses', (n) => styled(fill('(', n - 23))],
    ['one style of closing brackets', (n) => styled(fill(')]}', n - 23))],
    ['one style of quoted strings', (n) => styled(fill("'a;", n - 23))],
    ['one style of escaped quotes in one string', (n) => styled(`'${fill("\\'", n - 24)}`)],
    ['one style of strings, each ended by a line break', (n) => styled(fill("'\r\n", n - 23))],
    [
      'hidden spans inside one <a>, each ending at an <a>',
      (n) => `<a href=w>${fill('<span hidden>x<a href=y>z', n - 10)}`,
    ],
    ['one unclosed <textarea> holding templates', (n) => `<textarea>${fill('<template>', n - 10)}`],
    ['runs of <title><template></title>', (n) => fill('<title><template></title>', n)],
    [
      'runs of declarative shadow roots',
      (n) => fill('<template shadowrootmode=open>x</template>', n),
    ],
    ['one <template> with many attributes', (n) => `<template${fill(' a=b', n - 11)}>x`],
  ];
})();

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
    ['runs of <b></b>', (n) => fill('<b></b>', n)],
    ['runs of <wbr>', (n) => fill('<wbr>', n)],
    ['runs of <span>x</span>', (n) => fill('<span>x</span>', n)],
    ['runs of sibling links <a>x</a><a>y</a>', (n) => fill('<a>x</a><a>y</a>', n)],
    [
      'runs of <a>x</a><span hidden>h</span><a>y</a>, a hidden span between links',
      (n) => fill('<a>x</a><span hidden>h</span><a>y</a>', n),
    ],
    [
      'runs of <a>x</a> before <sup> and <b> in turn',
      (n) => fill('<a>x</a><sup>1</sup><a>y</a><b>z</b>', n),
    ],
    ['runs of <a> links of astral letters', (n) => fill('<a>𝐀</a><a>𝐁</a>', n)],
    ['runs of stray </a> before a start tag', (n) => fill('x</a><b>', n)],
    [
      'sibling <a> links over one long line ending in a break',
      (n) => `${fill('<a>x</a><a>1 ', n - 2)}\ny`,
    ],
    ['<a> links before an element over breaks throughout', (n) => fill('<a>x</a><b>y  \r\n', n)],
    [
      '<b> elements then <a> links over one long line ending in a break',
      (n) => `${fill('<b>x</b><a>y</a>', n - 2)}\ny`,
    ],
    ['<b> elements then <a> links over breaks throughout', (n) => fill('<b>x</b><a>y  \r\n', n)],
    [
      '<a> links through end tags over one long line ending in a break',
      (n) => `${fill('<span><a>x</a></span><span><a>y</a></span>', n - 2)}\ny`,
    ],
    [
      '<a> links through end tags over breaks throughout',
      (n) => fill('<span><a>x</a></span><span><a>y  \r\n', n),
    ],
    [
      'end tags before <sup>, <a>, and <sub> in turn over one long line ending in a break',
      (n) => `${fill('<b>x</b><sup>1</sup><a>y</a><sub>2</sub>', n - 2)}\ny`,
    ],
    [
      'end tags before <sup>, <a>, and <sub> in turn over breaks throughout',
      (n) => fill('<b>x</b><sup>1</sup><a>y</a><sub>2  \r\n', n),
    ],
    ['runs of styled spans', (n) => fill('<span style="color:red;display:inline">x</span>', n)],
    ['runs of hidden spans', (n) => fill('<span hidden>x</span>y', n)],
    [
      'nested hidden spans, then their end tags',
      (n) => `${fill('<span hidden>', n / 2)}${fill('</span>', n / 2)}`,
    ],
    ['nested hidden spans never closed', (n) => fill('<span hidden>', n)],
    [
      'unclosed display:none spans, one per line',
      (n) => fill('<span style="display:none">x<br>', n),
    ],
    [
      'spans opened inside one hidden span, then closed',
      (n) => `<span hidden>${fill('<span>', n / 2)}${fill('</span>', n / 2)}`,
    ],
    ['one hidden span holding unclosed <b> runs', (n) => `<span hidden>${fill('<b>', n - 13)}`],
    [
      'distinct names opened inside one hidden span',
      (n) => {
        let html = '<span hidden>';
        for (let i = 0; html.length < n; i++) html += `<x${i.toString(36)}>`;
        return html.slice(0, n);
      },
    ],
    ['stray end tags after hidden spans', (n) => fill('<span hidden>x</b>', n)],
    [
      'one hidden span over one long line ending in a break',
      (n) => `<span hidden>${fill('§1 x', n - 15)}\ny`,
    ],
    ['one hidden span over breaks throughout', (n) => `<span hidden>${fill('  \r\n', n - 13)}`],
    [
      'one long style value',
      (n) => `<span style="${fill('color:red;', n - 31)}display:none">x</span>y`,
    ],
    [
      'one style of display declarations',
      (n) => `<span style="${fill('display:none !important;display:inline;', n - 16)}">x</span>`,
    ],
    ['one style with an unclosed comment', (n) => `<span style="/*${fill('x', n - 18)}">x</span>`],
    ['one style of comments', (n) => `<span style="${fill('/*/', n - 16)}">x</span>`],
    ['one style of bangs', (n) => `<span style="display:${fill('!', n - 29)}none">x</span>`],
    ['one style of references', (n) => `<span style="${fill('&#58;', n - 16)}">x</span>`],
    [
      'one style value over one long line ending in a break',
      (n) => `<span style="${fill('§1 x', n - 18)}\ny">x</span>`,
    ],
    [
      'one style value over breaks throughout',
      (n) => `<span style="${fill('  \r\n', n - 16)}">x</span>`,
    ],
    ['one hidden attribute value', (n) => `<span hidden="${fill('x', n - 17)}">x</span>`],
    ['one span with many attributes', (n) => `<span${fill(' a=b', n - 13)}>x</span>`],
    ['one span whose quoted style never closes', (n) => `<span style="${fill('x', n - 13)}`],
    ['<span style= openers before one >', (n) => `${fill('<span style=', n - 1)}>`],
    ['unclosed <template> runs', (n) => fill('<template>', n)],
    [
      'one unclosed <template> holding tags',
      (n) => `<template>${fill('x<p></td></span><a href=y>', n - 10)}`,
    ],
    [
      'nested templates, then their end tags',
      (n) => `${fill('<template>', n / 2)}${fill('</template>', n / 2)}`,
    ],
    [
      'one <template> over one long line ending in a break',
      (n) => `<template>${fill('§1 x', n - 12)}\ny`,
    ],
    ['one <template> over breaks throughout', (n) => `<template>${fill('  \r\n', n - 10)}`],
    ...RULE_CASES,
  ];

  /** CPU ceiling per call: 1 µs per character, about 14× the slowest shape measured (23 ms at 320k). */
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
    ['links inside hidden spans', (n) => fill('<span hidden><a href=x>y</a></span>', n)],
    ['runs of hidden <a href>', (n) => fill('<a hidden href=x>y', n)],
    ['links inside one unclosed <template>', (n) => `<template>${fill('<a href=x>y', n - 10)}`],
    ['<base href> inside hidden spans', (n) => fill('<span hidden><base href=x>', n)],
    [
      'links inside declarative shadow roots',
      (n) => fill('<template shadowrootmode=open><a href=x>y</a></template>', n),
    ],
    [
      'links after templates inside <textarea>',
      (n) => fill('<textarea><template></textarea><a href=x>y', n),
    ],
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
      [anchor('1', 0, 'one'), anchor('2', 3, 'two')],
    ],
    ['a label that changes style partway', '<a href=x><b>H</b>ello</a>', [anchor('x', 0, 'Hello')]],
    [
      'an <a> without href: no link, but it closes the open one',
      '<a href=1>one<a name=x>two</a>',
      [anchor('1', 0, 'one')],
    ],
    ['stray </a> tags', 'a</a><a href=1>b</a></a>c', [anchor('1', 1, 'b')]],
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
      'sibling links',
      '<a href=1>esp</a><a href=2>ame</a>',
      'esp ame',
      [anchor('1', 0, 'esp'), anchor('2', 4, 'ame')],
    ],
    [
      'a link, then a link inside an inline element',
      '<a href=1>x</a><b><a href=2>y</a></b>',
      'x y',
      [anchor('1', 0, 'x'), anchor('2', 2, 'y')],
    ],
    [
      'a link, then an empty link, then a word',
      '<a href=1>x</a><a href=2></a><b>y</b>',
      'x y',
      [anchor('1', 0, 'x'), anchor('2', 1, '')],
    ],
    [
      'two links with a hidden element between them',
      '<a href=1>x</a><span hidden>h</span><a href=2>y</a>',
      'x y',
      [anchor('1', 0, 'x'), anchor('2', 2, 'y')],
    ],
    ['an element, then a link', '<b>x</b><a href=1>y</a>', 'x y', [anchor('1', 2, 'y')]],
    [
      'links whose ends reach the next element through an end tag',
      '<span><a href=1>x</a></span><span><a href=2>y</a></span>',
      'x y',
      [anchor('1', 0, 'x'), anchor('2', 2, 'y')],
    ],
  ])(
    'keeps the space kept after %s out of every link’s text and offset (#75)',
    (_name, html, text, anchors) => {
      const page = htmlToTextAndAnchors(html);
      expect(page.text).toBe(text);
      expect(page.anchors).toEqual(anchors);
      expect(htmlToText(html)).toBe(text);
    },
  );

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

describe('htmlToText hidden elements (#76)', () => {
  const anchor = (href: string, offset: number, text: string): PageAnchor => ({
    href,
    offset,
    text,
  });

  it.each([
    ['hidden', '<span hidden>'],
    ['hidden=""', '<span hidden="">'],
    ['hidden="hidden"', '<span hidden="hidden">'],
    ['HIDDEN', '<span HIDDEN>'],
    ['hidden="false"', '<span hidden="false">'],
    ['hidden=" until-found", which is not until-found', '<span hidden=" until-found">'],
    ['hidden after other attributes', '<span class="a>b" id=c hidden>'],
    ['hidden with a style that sets no display', '<span hidden style="color:red">'],
    ['hidden with a style whose display declaration is empty', '<span hidden style="display:">'],
    ['display:none', '<span style="display:none">'],
    ['DISPLAY : NONE', '<span style="DISPLAY : NONE">'],
    ['color:red; display:none', '<span style="color:red; display:none">'],
    ['display:inline; display:none', '<span style="display:inline; display:none">'],
    [
      'display:none !important; display:inline',
      '<span style="display:none !important; display:inline">',
    ],
    ['display:none!important', '<span style="display:none!important">'],
    ['display: none ! IMPORTANT', '<span style="display: none ! IMPORTANT">'],
    ['a comment inside the declaration', '<span style="display:/* x */none">'],
    ['an unclosed comment after it', '<span style="display:none /* x">'],
    ['an empty display declaration after it', '<span style="display:none; display:">'],
    ['a character reference in the style', '<span style="display&#58;none">'],
    ['a single-quoted style', "<span style='display:none'>"],
    ['an unquoted style', '<span style=display:none>'],
    ['display:none over hidden="until-found"', '<span hidden="until-found" style="display:none">'],
    ['display:n\\one, a CSS escape', '<span style="display:n\\one">'],
    ['display:\\6e one, a hex escape and the space ending it', '<span style="display:\\6e one">'],
    [
      'display:\\6e&#13;&#10;one, a hex escape and the CRLF ending it as one character',
      '<span style="display:\\6e&#13;&#10;one">',
    ],
    ['disp\\lay:none, an escape in the property name', '<span style="disp\\lay:none">'],
    [
      'display:none !imp\\ortant over a later display',
      '<span style="display:none !imp\\ortant; display:inline">',
    ],
    ['display:none after a quoted /*', '<span style="content:\'/*\';display:none">'],
    ['display:none after a string a line break ends', '<span style="x:\'a\n;display:none">'],
    [
      'hidden with a quoted string holding another display',
      '<span hidden style="x:\'a;display:inline\'">',
    ],
    [
      'hidden with a url() holding another display',
      '<span hidden style="background:url(a;display:inline)">',
    ],
    [
      'hidden with an escaped ; before another display',
      '<span hidden style="x:a\\;display:inline">',
    ],
  ])('leaves out the content of a <span> hidden by %s', (_name, startTag) => {
    expect(htmlToText(`a ${startTag}x</span> b`)).toBe('a b');
  });

  it.each([
    ['hidden="until-found"', '<span hidden="until-found">'],
    ['hidden="UNTIL-FOUND"', '<span hidden="UNTIL-FOUND">'],
    ['hidden="until&#45;found"', '<span hidden="until&#45;found">'],
    ['hidden with a style that sets another display', '<span hidden style="display:inline">'],
    ['hidden with display:block', '<span hidden style="display:block">'],
    ['display:none; display:inline', '<span style="display:none; display:inline">'],
    [
      'display:inline !important; display:none',
      '<span style="display:inline !important; display:none">',
    ],
    ['/*display:none*/', '<span style="/*display:none*/">'],
    ['a comment splitting the property name', '<span style="disp/**/lay:none">'],
    ['visibility:hidden', '<span style="visibility:hidden">'],
    ['aria-hidden="true"', '<span aria-hidden="true">'],
    ['class="hidden"', '<span class="hidden">'],
    ['data-hidden', '<span data-hidden>'],
    ['hidden inside another attribute’s value', '<span title=" hidden style=display:none">'],
    ['a second style attribute', '<span style="color:red" style="display:none">'],
    ['a second hidden attribute', '<span hidden="until-found" hidden>'],
    ['display:none inside a quoted string', '<span style="font-family:\'x;display:none;\'">'],
    ['display:none inside a double-quoted string', '<span style=\'content:"a;display:none;"\'>'],
    ['an escaped quote inside a string', "<span style=\"content:'\\';display:none;'\">"],
    ['display:none inside url()', '<span style="background:url(a;display:none;)">'],
    ['display:none inside brackets', '<span style="x:[a;display:none;]">'],
    ['display:none inside braces', '<span style="x:{a;display:none;}">'],
    ['display:none inside parentheses a ] does not close', '<span style="x:(a];display:none;)">'],
    [
      'display:none\\ at the end of the style, read as none and U+FFFD',
      '<span style="display:none\\">',
    ],
    ['an escaped ; before display:none', '<span style="x:a\\;display:none">'],
    ['display:none\\20, an escaped space', '<span style="display:none\\20">'],
    ['display:\\00A0none, an escaped no-break space', '<span style="display:\\00A0none">'],
    ['display:\u00a0none, a no-break space CSS does not skip', '<span style="display:\u00a0none">'],
  ])('reads the content of a <span> with %s', (_name, startTag) => {
    expect(htmlToText(`a ${startTag}x</span> b`)).toBe('a x b');
  });

  it.each([
    ...[
      'a',
      'abbr',
      'acronym',
      'b',
      'bdi',
      'bdo',
      'big',
      'blink',
      'cite',
      'code',
      'data',
      'del',
      'dfn',
      'em',
      'font',
      'i',
      'ins',
      'kbd',
      'label',
      'mark',
      'nobr',
      'output',
      'q',
      'rb',
      'ruby',
      's',
      'samp',
      'small',
      'span',
      'strike',
      'strong',
      'sub',
      'sup',
      'time',
      'tt',
      'u',
      'var',
    ].map((name) => [name, 'ab', 'a b'] as const),
    ...[
      'audio',
      'button',
      'canvas',
      'datalist',
      'iframe',
      'map',
      'math',
      'meter',
      'noscript',
      'object',
      'picture',
      'progress',
      'rp',
      'rt',
      'rtc',
      'select',
      'slot',
      'svg',
      'textarea',
      'video',
    ].map((name) => [name, 'a b', 'a b'] as const),
  ])(
    'leaves out the content of a hidden <%s>, its start tag read as any of its name',
    (name, joined, spaced) => {
      expect(htmlToText(`a<${name} hidden>x</${name}>b`)).toBe(joined);
      expect(htmlToText(`a <${name} style="display:none">x</${name}> b`)).toBe(spaced);
    },
  );

  it.each([
    ['a <div hidden>', 'a<div hidden>x</div>b', 'a\nx\nb'],
    ['a <p hidden>', 'a<p hidden>x</p>b', 'a\nx\nb'],
    ['a <ul style="display:none">', 'a<ul style="display:none"><li>x</li></ul>b', 'a\nx\nb'],
    ['a <td hidden>', '<tr><td>a</td><td hidden>x</td></tr>', 'a\tx'],
    [
      'a <table style="display:none">',
      '<table style="display:none"><tr><td>x</td></tr></table>',
      'x',
    ],
    ['an <option hidden>', 'a <option hidden>x</option> b', 'a x b'],
    ['a custom element', 'a <my-el hidden>x</my-el> b', 'a x b'],
    ['an <img hidden>, which holds nothing', 'a <img hidden>x b', 'a x b'],
    ['an <input style="display:none">', 'a <input style="display:none">x b', 'a x b'],
    ['a <br hidden>, which still breaks the line', 'a<br hidden>x', 'a\nx'],
    [
      'a <span hidden> inside a <textarea>',
      'a<textarea><span hidden>t</span></textarea>b',
      'a t b',
    ],
    ['a <span hidden> inside a <title>', '<title>a<span hidden>t</span></title>b', 'at b'],
  ])('reads the content of %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it.each([
    ['a text-level element', 'a<span hidden>x</span>b', 'ab'],
    ['whitespace around it', 'a <span hidden>x</span> b', 'a b'],
    ['a <button>, whose start tag reads as a space', 'a<button hidden>x</button>b', 'a b'],
    ['a <wbr>, which holds nothing', 'a<wbr hidden>b', 'ab'],
  ])('reads a hidden element as its start tag alone: %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it.each([
    ['its own end tag', 'a<span hidden>x</span>b', 'ab'],
    ['its own end tag, written in upper case', 'a<span hidden>x</SPAN\n>b', 'ab'],
    [
      'its own end tag, a span opened inside it counted',
      'a<span hidden>x<span>y</span>z</span>b',
      'ab',
    ],
    [
      'its own end tag, spans opened two deep inside it counted',
      'a<span hidden>x<span>y<span>z</span></span>w</span>b',
      'ab',
    ],
    ['its own end tag, other names opened inside it', 'a<b hidden>x<i>y<b>z</b></i>w</b>c', 'ac'],
    [
      'its own end tag, a hidden span inside it',
      'a<span hidden>x<span hidden>y</span>z</span>b',
      'ab',
    ],
    [
      'its own end tag, inside a visible element of the same name',
      'a<span>b<span hidden>x</span>c</span>d',
      'abcd',
    ],
    ['the end of the page', 'a <span hidden>x', 'a'],
    [
      'the end of the page, nested hidden spans never closed',
      'a <span hidden>x<span hidden>y<b>z',
      'a',
    ],
    ['an end tag of an element it did not open', 'a <span hidden>x</b>y</span> z', 'a y z'],
    ['an end tag of its parent', '<b>a<span hidden>x</b>c', 'ac'],
    ['an end tag of an ancestor, spans open inside it', '<i><b>a<span hidden>x<span>y</i>z', 'az'],
    ['a <br>', 'a<span hidden>x<br>b', 'a\nb'],
    ['a </br>', 'a<span hidden>x</br>b', 'a\nb'],
    ['a block start tag', 'a<span hidden>x<div>b', 'a\nb'],
    ['a block end tag', '<div>a<span hidden>x</div>b', 'a\nb'],
    ['a block start tag, spans open inside it', 'a<span hidden>x<span><b>y<p>b', 'a\nb'],
    [
      'an unclosed span before a paragraph end',
      '<p>intro <span style="display:none">never closed</p><p>next</p>',
      'intro\nnext',
    ],
    ['a cell end tag', '<td>a<span hidden>x</td><td>b</td>', 'a\tb'],
    ['a cell start tag', '<tr><td>a<span hidden>x<td>b', 'a\tb'],
    ['a header cell start tag', '<tr><th>a<span hidden>x<th>b</tr>', 'a\tb'],
    ['a row start tag', '<td>a<span hidden>x<tr><td>b', 'a\nb'],
    ['a <pre>', 'a<span hidden>x<pre>  b</pre>', 'a\n  b'],
    ['an <a> start tag, for a hidden <a>', '<a hidden href=1>x<a href=2>y</a>z', 'yz'],
    [
      'an <a> start tag, for a hidden part opened inside an <a>',
      '<a href=1>one<span hidden>x<a href=2>two</a>y</span>z</a>w',
      'onetwoyzw',
    ],
    [
      'an <a> start tag, for a hidden part opened two elements deep inside an <a>',
      '<a href=1>one<b><span hidden>x<i><a href=2>two</a></i>y</span></b>z</a>',
      'onetwoyz',
    ],
  ])('ends a hidden part at %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it.each([
    ['a comment holding its end tag', 'a<span hidden>x<!-- </span> -->y</span>b', 'ab'],
    ['a script holding its end tag', 'a<span hidden><script>"</span><p>"</script>y</span>b', 'ab'],
    [
      'a <template> holding a block',
      'a<span hidden>x<template><div>t</div></template>y</span>b',
      'ab',
    ],
    ['text inside <pre>, line breaks included', '<pre>a <span hidden>b\n c</span> d</pre>', 'a  d'],
  ])('leaves out %s inside a hidden part', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it.each([
    [
      'a link inside a hidden span',
      '<span hidden><a href="http://x.example/">x</a></span><a href="http://y.example/">y</a>',
      'y',
      [anchor('http://y.example/', 0, 'y')],
    ],
    [
      'a link two elements deep inside a hidden span',
      '<span hidden><b><a href=1>x<i>y</i></a></b>z</span>w',
      'w',
      [],
    ],
    [
      'a hidden part inside a link',
      '<a href=1>vis<span hidden>hid</span>ible</a>',
      'visible',
      [anchor('1', 0, 'visible')],
    ],
    [
      'a hidden part ending at the link’s end tag',
      '<a href=1>a<span hidden>x</a>b',
      'ab',
      [anchor('1', 0, 'a')],
    ],
    [
      'a hidden <a>, which closes the open anchor',
      '<a href=1>one<a hidden href=2>two</a>three',
      'onethree',
      [anchor('1', 0, 'one')],
    ],
    [
      'a link after a hidden <a>, which ends it',
      '<a hidden href=1>x<a href=2>y</a>z',
      'yz',
      [anchor('2', 0, 'y')],
    ],
    [
      'a link that ends a hidden part opened inside the link before it',
      '<a href=1>one<span hidden>x<a href=2>two</a>y</span>z</a>w',
      'onetwoyzw',
      [anchor('1', 0, 'one'), anchor('2', 3, 'two')],
    ],
    [
      'two links inside a hidden part opened outside any link',
      '<span hidden><a href=1>x<a href=2>y</a></span>z',
      'z',
      [],
    ],
    [
      'a link inside a hidden part opened after a link closed',
      '<a href=1>a</a><span hidden>x<a href=2>y</a>z</span>w',
      'a w',
      [anchor('1', 0, 'a')],
    ],
    [
      'a link inside a hidden part opened after a hidden <a> closed at its own end tag',
      '<a hidden href=1>a</a><span hidden>x<a href=2>y</a>z</span><a href=3>w</a>',
      'w',
      [anchor('3', 0, 'w')],
    ],
  ])('lists no link inside a hidden part: %s', (_name, html, text, anchors) => {
    const page = htmlToTextAndAnchors(html);
    expect(page.text).toBe(text);
    expect(page.anchors).toEqual(anchors);
  });

  it('reads a <base href> inside a hidden part', () => {
    expect(htmlToTextAndAnchors('<span hidden><base href=b1></span><base href=b2>').baseHref).toBe(
      'b1',
    );
  });

  /** Mulberry32: the same pages on every run. */
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const HIDING = [
    ' hidden',
    ' hidden=""',
    ' HIDDEN',
    ' hidden="hidden"',
    ' style="display:none"',
    ' style="color:red; DISPLAY : none"',
    ' style="display:inline;display:none"',
    ' hidden style="display:none"',
  ];
  const SHOWING = [
    '',
    '',
    ' class="hidden"',
    ' hidden="until-found"',
    ' hidden style="display:inline"',
    ' style="display:none; display:inline"',
    ' style="/*display:none*/"',
    ' style="visibility:hidden"',
    ' aria-hidden="true"',
  ];
  /** Markup inside a `<template>`, none of which may reach the text or end a hidden part. */
  const TEMPLATE_CONTENT = [
    '<p>',
    '</div>',
    '<td>',
    '</span>',
    '</b>',
    '<a href="t">',
    '</a>',
    '<br>',
    'w ',
  ];

  /**
   * A page of unique words inside text-level elements nested up to six deep, some hidden
   * by their own start tag at any depth, some links (never one inside another), and
   * `<template>` elements holding markup; with its text and links read from how it was built.
   */
  const page = (next: () => number) => {
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
    const words: string[] = [];
    const built: { href: string; words: string[]; before: string | undefined }[] = [];
    let html = '';
    let id = 0;
    const template = (depth: number) => {
      html += '<template>';
      for (let n = Math.floor(next() * 4); n > 0; n--) {
        if (depth < 3 && next() < 0.2) template(depth + 1);
        else html += pick(TEMPLATE_CONTENT);
      }
      html += '</template>';
    };
    const content = (
      depth: number,
      hidden: boolean,
      inLink: boolean,
      link: (typeof built)[number] | undefined,
    ) => {
      for (let n = 1 + Math.floor(next() * 3); n > 0; n--) {
        const r = next();
        if (depth < 6 && r < 0.45) {
          const name = pick(inLink ? ['span', 'b', 'i', 'em'] : ['span', 'b', 'i', 'em', 'a']);
          const hides = next() < 0.3;
          const attributes = hides ? pick(HIDING) : pick(SHOWING);
          let inner = link;
          if (name === 'a') {
            const href = `u${id++}`;
            html += `<a href="${href}"${attributes}>`;
            inner = undefined;
            if (!hidden && !hides) {
              inner = { href, words: [], before: words.at(-1) };
              built.push(inner);
            }
          } else {
            html += `<${name}${attributes}>`;
          }
          content(depth + 1, hidden || hides, inLink || name === 'a', inner);
          html += `</${name}>`;
        } else if (r < 0.55) {
          template(0);
        } else {
          const word = `w${String(id++).padStart(4, '0')}`;
          html += `${word} `;
          if (!hidden) {
            words.push(word);
            link?.words.push(word);
          }
        }
      }
    };
    content(0, false, false, undefined);
    return { html, text: words.join(' '), built };
  };

  it('reads the words outside hidden parts and templates, and the links outside hidden parts, at any depth', () => {
    const next = prng(76);
    for (let i = 0; i < 2_000; i++) {
      const { html, text, built } = page(next);
      const want = built.map(({ href, words, before }) => {
        const [first] = words;
        if (first !== undefined) return anchor(href, text.indexOf(first), words.join(' '));
        return anchor(href, before === undefined ? 0 : text.indexOf(before) + before.length, '');
      });
      const got = htmlToTextAndAnchors(html);
      expect(got.text, JSON.stringify(html)).toBe(text);
      expect(got.anchors, JSON.stringify(html)).toEqual(want);
    }
  });
});

describe('htmlToText <template>', () => {
  it.each([
    ['its content', '<template><p>t</p></template>z', 'z'],
    ['its content, its start tag read as a space', 'a<template>t</template>b', 'a b'],
    ['a template nested in it', 'a<template>x<template>y</template>z</template>b', 'a b'],
    [
      'templates nested two deep',
      'a<template>x<template>y<template>z</template></template>w</template>b',
      'a b',
    ],
    [
      'end tags of elements it did not open',
      'a<template>x</p></td></span></a>y</template>b',
      'a b',
    ],
    ['a table inside it', 'a<template><table><tr><td>x</td></tr></table></template>b', 'a b'],
    ['the rest of the page, when it never closes', 'a<template>x<p>y', 'a'],
    ['a comment holding its end tag', 'a<template><!-- </template> -->x</template>b', 'a b'],
    [
      'a script holding its end tag',
      'a<template><script>"</template>"</script>x</template>b',
      'a b',
    ],
    ['tags in upper case and with attributes', 'a<TEMPLATE id=t>x</Template\n>b', 'a b'],
    ['text inside <pre>', '<pre>a<template>  x  </template>b</pre>', 'ab'],
    ['a hidden span inside it', 'a<template><span hidden>x</template>b', 'a b'],
    [
      'cells inside it, between two cells',
      '<tr><td>a</td><template><td>x</td></template><td>b</td></tr>',
      'a\tb',
    ],
    [
      'a cell inside it, before its row’s first cell',
      '<tr><template><td>x</td></template><td>a</td><td>b</td></tr>',
      'a\tb',
    ],
    [
      'a template after a closed <textarea>',
      '<textarea>t</textarea><template>x</template>y',
      't y',
    ],
    [
      'a template whose shadowrootmode is neither open nor closed',
      'a<template shadowrootmode=bogus>x</template>b',
      'a b',
    ],
    [
      'a template with the legacy shadowroot attribute',
      'a<template shadowroot=open>x</template>b',
      'a b',
    ],
    [
      'a declarative shadow root inside a template',
      '<template><template shadowrootmode=open>x</template>y</template>z',
      'z',
    ],
  ])('leaves out %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it.each([
    ['a </template> with no opener', 'a</template>b', 'a b'],
    ['a <templates>, which is no template', 'a<templates>x</templates>b', 'a x b'],
    ['a <template> inside a <textarea>', 'a<textarea><template></textarea>b<p>c', 'a b\nc'],
    ['a <template> inside a <title>', '<title>My <template> page</title><p>body', 'My page\nbody'],
    ...['an <xmp>', 'an <iframe>', 'a <noembed>', 'a <noframes>'].map((element) => {
      const name = element.slice(element.indexOf('<') + 1, -1);
      return [`a <template> inside ${element}`, `a<${name}><template></${name}>b`, 'a b'] as const;
    }),
  ])('reads %s as its tag', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it.each([
    [
      'shadowrootmode="open"',
      '<div><template shadowrootmode="open"><p>shadow</p></template>light</div>after',
      'shadow\nlight\nafter',
    ],
    [
      'shadowrootmode=closed',
      '<div><template shadowrootmode=closed>shadow</template></div>after',
      'shadow\nafter',
    ],
    ['SHADOWROOTMODE="OPEN"', 'a<template SHADOWROOTMODE="OPEN">b</template>c', 'a b c'],
    ['a referenced shadowrootmode', 'a<template shadowrootmode="&#111;pen">b</template>c', 'a b c'],
    [
      'a template nested in it',
      'a<template shadowrootmode=open>b<template>x</template>c</template>d',
      'a b c d',
    ],
  ])('reads the content of a declarative shadow root with %s', (_name, html, want) => {
    expect(htmlToText(html)).toBe(want);
  });

  it('lists the links inside a declarative shadow root', () => {
    const page = htmlToTextAndAnchors(
      '<template shadowrootmode=open><a href=1>x</a></template><a href=2>y</a>',
    );
    expect(page.text).toBe('x y');
    expect(page.anchors).toEqual([
      { href: '1', offset: 0, text: 'x' },
      { href: '2', offset: 2, text: 'y' },
    ]);
  });

  it('lists no link and reads no <base href> inside a template', () => {
    const page = htmlToTextAndAnchors(
      '<template><base href=b1><a href=1>x</a></template><base href=b2><a href=2>y</a>',
    );
    expect(page.text).toBe('y');
    expect(page.anchors).toEqual([{ href: '2', offset: 0, text: 'y' }]);
    expect(page.baseHref).toBe('b2');
  });

  it('leaves out a template of the 2023-01-01 github.com/torvalds/linux capture', () => {
    const html =
      '<p>Branches</p><template data-target="ref-selector.fetchFailedTemplate">\n              <div class="SelectMenu-message" data-index="{{ index }}">Could not load branches</div>\n            </template><p>Tags</p>';
    expect(htmlToText(html)).toBe('Branches\nTags');
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
    ['<img>', 'a<img src="x">b'],
    ['<td>', 'a<td>b'],
    ['a comment', 'a<!-- x -->b'],
  ])('reads %s as a space, not a line break', (_name, html) => {
    expect(descriptionToText(html)).toBe('a b');
  });

  it.each([
    ['<abbr>', 'a<abbr>b'],
    ['<span>', 'a<span>b'],
    ['<b>', 'a<b>b'],
    ['</i>', 'a</i>b'],
    ['<wbr>', 'a<wbr>b'],
    ['<SUP class="x>y">', 'a<SUP class="x>y">b'],
  ])('reads %s as nothing, not a line break (#75)', (_name, html) => {
    expect(descriptionToText(html)).toBe('ab');
  });

  it.each([
    ['an emphasised word before a comma', 'Recorded <i>live</i>, 1977.', 'Recorded live, 1977.'],
    ['a word that changes style partway', '<b>H</b>ello', 'Hello'],
    [
      'text-level tags across lines',
      '<p><b>Side</b> A</p><p><em>Track</em>s:</p>',
      'Side A\nTracks:',
    ],
  ])('joins %s (#75)', (_name, html, want) => {
    expect(descriptionToText(html)).toBe(want);
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
    [
      'a label that changes style partway',
      '<a href="http://example.com/"><b>H</b>ello</a>',
      'Hello (http://example.com/)',
    ],
    ['an anchor with no href as its label', '<a name="top">Top</a> of page', 'Top of page'],
    ['an anchor with an empty href as its label', '<a href=" ">Top</a>', 'Top'],
    ['</a> with no opener as nothing', 'a</a>b</a >', 'ab'],
    [
      'sibling links apart, before each label and its URL',
      '<a href="http://example.com/1">esp</a><a href="http://example.com/2">ame</a>',
      'esp (http://example.com/1) ame (http://example.com/2)',
    ],
    [
      'sibling links whose labels are their URLs apart',
      '<a href="http://example.com/1">http://example.com/1</a><a href="http://example.com/2">http://example.com/2</a>',
      'http://example.com/1 http://example.com/2',
    ],
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
    ['runs of <b></b>', (n) => fill('<b></b>', n)],
    ['runs of <wbr>', (n) => fill('<wbr>', n)],
    ['runs of <span>x</span>', (n) => fill('<span>x</span>', n)],
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
    ...RULE_CASES,
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
