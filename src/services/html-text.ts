/**
 * @fileoverview Plain-text extraction from HTML: one left-to-right markup scan whose text
 * runs and tags feed a line builder, with each character reference decoded once.
 * `htmlToText` reads an archived page as lines, the way a browser lays it out: block
 * elements and `<br>` break lines, table cells are separated by tabs, `<pre>` text keeps
 * its spacing, the tags of text-level elements (`a`, `b`, `span`, `sup`, …) add no
 * separator unless a link and the element beside it meet between two words, and what the
 * page's own markup leaves unrendered — a `<template>` that declares no
 * shadow root, or a phrasing element its start tag hides — reads as nothing;
 * `htmlToTextAndAnchors` also returns, from the same scan, where each rendered `<a href>`
 * sits in that text and the page's first `<base href>`. `descriptionToText` reads an item
 * description — HTML from the Archive's upload editor, or plain text — as lines by its own
 * rules. The result is plain text for a model to read — it is never rendered as HTML.
 *
 * The markup scan is plain index arithmetic rather than a regular expression. Every
 * step moves forward, so its cost is linear in the input length on any input and in
 * any engine. The page's line builder keeps only counters, flags, and the separator waiting
 * for the next text as the scan passes each tag, and reads back no further than the last
 * character it wrote; the unrendered parts keep only a depth, a count per element name, and
 * the open anchor and text-content element. Neither looks ahead for an end tag; reading a
 * start tag's attributes or an inline style walks it forward, inside its own span. An
 * archived page is content anyone can publish through Save Page Now, and an item
 * description is whatever its uploader typed; a backtracking pattern over either can stall
 * the event loop on crafted input.
 * @module services/html-text
 */

import { NAMED_CHARACTER_REFERENCES } from './html-entities.js';

/** Elements whose body is raw text: nothing inside is markup until their end tag. */
const RAW_TEXT_ELEMENTS = ['script', 'style'] as const;

/** Elements whose start or end tag begins a new line of a description. */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set(['p', 'div', 'li']);

/**
 * Elements whose start or end tag begins a new line of a page: the blocks, list items,
 * and table rows and row groups of the HTML Rendering section.
 */
const PAGE_BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
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
]);

/** Elements whose start or end tag ends a table row, so the next cell is its row's first. */
const ROW_BOUNDARY_ELEMENTS: ReadonlySet<string> = new Set(['tr', 'tbody', 'thead', 'tfoot']);

/**
 * Text-level elements: the phrasing elements that only hold text, and the obsolete inline
 * elements of the HTML Rendering section. Their start and end tags add no separator, as in
 * a browser's text, so the punctuation after a link stays on it and a word that changes
 * style partway stays one word; `PageLines` keeps one space where a link and the element
 * beside it meet between two words. Replaced elements and widgets (`img`, `input`,
 * `button`, `svg`, …) and a ruby reading (`rt`, `rp`) are boxes a reader sees apart, so
 * their tags keep a space.
 */
const INLINE_ELEMENTS: ReadonlySet<string> = new Set([
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
]);

/**
 * Phrasing elements that hold content — HTML phrasing content, the obsolete inline
 * elements, and the ruby parts, less the void elements, `script`, and `template` — whose
 * own start tag can hide that content. A block's hidden content is left in: pages hide
 * blocks to reveal them on a click or by script (carousels, menus, collapsed lists).
 */
const HIDEABLE_ELEMENTS: ReadonlySet<string> = new Set([
  ...[...INLINE_ELEMENTS].filter((name) => name !== 'wbr'),
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
]);

/**
 * Elements whose content the HTML parser reads as text up to their end tag, besides the
 * `script` and `style` bodies the scan skips. The scan still reads the tags written inside
 * them as it always has, but no template or hidden part opens there.
 */
const TEXT_CONTENT_ELEMENTS: ReadonlySet<string> = new Set([
  'iframe',
  'noembed',
  'noframes',
  'textarea',
  'title',
  'xmp',
]);

/** Length of the longest element name the page rules read (`blockquote`, `figcaption`). */
const LONGEST_ELEMENT_NAME = 10;

/** A `;`-terminated decimal, hexadecimal, or named character reference. */
const REFERENCE = /&(?:#(\d+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9]*));/g;

/**
 * Windows-1252 code points for numeric references 0x80–0x9F, indexed from 0x80, per the
 * WHATWG parser. The five positions Windows-1252 leaves undefined keep their own value.
 */
const WINDOWS_1252_C1 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152,
  0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122,
  0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/**
 * A letter or digit at the start of the string tested, outside the scripts written without
 * spaces between words: Han, Hiragana, Katakana, Hangul, CJK Symbols and Punctuation, and
 * the Halfwidth and Fullwidth Forms.
 */
const WORD_START =
  /^(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯])[\p{L}\p{N}]/u;

/**
 * Whether `before` ends and `after` starts with a `WORD_START` character, each read as a
 * whole code point; only the last two code units of `before` and the first two of `after`
 * are read.
 */
function wordsMeet(before: string | undefined, after: string): boolean {
  if (before === undefined || !WORD_START.test(after.slice(0, 2))) return false;
  const last = before.length - 1;
  const pairStart = last > 0 && (before.codePointAt(last - 1) ?? 0) > 0xffff;
  return WORD_START.test(before.slice(pairStart ? last - 1 : last));
}

/** HTML whitespace: tab, line feed, form feed, carriage return, space. */
const isSpace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;

/** ASCII A–Z or a–z — the only characters that can start a tag name. */
const isAsciiLetter = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

/** Whether a tag name that stopped at `at` has ended there: end of page, whitespace, `/`, or `>`. */
const tagNameEndsAt = (html: string, at: number): boolean => {
  if (at >= html.length) return true;
  const code = html.charCodeAt(at);
  return isSpace(code) || code === 0x2f || code === 0x3e;
};

/** Whether the tag name starting at `at` is `name` (given in lower case), in any case. */
const tagNameIs = (html: string, at: number, name: string): boolean =>
  html.slice(at, at + name.length).toLowerCase() === name && tagNameEndsAt(html, at + name.length);

/**
 * The tag name starting at `at`, in lower case as the HTML parser folds it (ASCII only),
 * or `''` when it cannot be a name the page rules read: longer than any of them, or
 * holding a character other than an ASCII letter or digit.
 */
function elementName(html: string, at: number): string {
  let name = '';
  for (let i = at; !tagNameEndsAt(html, i); i++) {
    const code = html.charCodeAt(i);
    const lower = code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
    const isNameChar = (lower >= 0x61 && lower <= 0x7a) || (lower >= 0x30 && lower <= 0x39);
    if (!isNameChar || name.length === LONGEST_ELEMENT_NAME) return '';
    name += String.fromCharCode(lower);
  }
  return name;
}

/**
 * Whitespace as a regular expression's `\s` reads it — HTML whitespace plus vertical tab,
 * no-break and other Unicode spaces, line and paragraph separators, and the byte order
 * mark — the characters `collapseSpace` folds into one space.
 */
function isWhitespace(code: number): boolean {
  if (code < 0xa0) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Whitespace that stays on its line: any but a line feed or carriage return. */
const isSameLineSpace = (code: number): boolean =>
  code !== 0x0a && code !== 0x0d && isWhitespace(code);

/**
 * Index just past the `>` that closes the tag whose attributes start at `from`, or the
 * page length when nothing closes it. As in a browser, a quote opens a value only right
 * after `=` (and optional whitespace), and that value may hold `>`; a quote anywhere
 * else is an ordinary character.
 */
function tagEnd(html: string, from: number): number {
  for (let i = from; i < html.length; i++) {
    const char = html[i];
    if (char === '>') return i + 1;
    if (char !== '=') continue;
    let valueStart = i + 1;
    while (valueStart < html.length && isSpace(html.charCodeAt(valueStart))) valueStart++;
    const quote = html[valueStart];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, valueStart + 1);
      if (close < 0) return html.length;
      i = close;
    } else {
      i = valueStart - 1;
    }
  }
  return html.length;
}

/** Index just past the comment whose body starts at `from` (after `<!--`), or the page length. */
function commentEnd(html: string, from: number): number {
  if (html.startsWith('>', from)) return from + 1;
  if (html.startsWith('->', from)) return from + 2;
  for (
    let dashes = html.indexOf('--', from);
    dashes >= 0;
    dashes = html.indexOf('--', dashes + 1)
  ) {
    if (html[dashes + 2] === '>') return dashes + 3;
    if (html[dashes + 2] === '!' && html[dashes + 3] === '>') return dashes + 4;
  }
  return html.length;
}

/** Index just past the `name` end tag at or after `from` — `</name` then whitespace, `/`, or `>` — or the page length. */
function rawTextEnd(html: string, from: number, name: string): number {
  for (let open = html.indexOf('</', from); open >= 0; open = html.indexOf('</', open + 2)) {
    if (tagNameIs(html, open + 2, name)) return tagEnd(html, open + 2 + name.length);
  }
  return html.length;
}

/**
 * Index just past the markup construct opened by the `<` at `lt`, or `lt` itself when
 * that `<` is text: a comment, a script or style element with its body, or any other
 * tag, declaration, or processing instruction (`<` then a letter, `/`, `!`, or `?`).
 * An unclosed construct runs to the end of the page.
 */
function markupEnd(html: string, lt: number): number {
  if (html.startsWith('<!--', lt)) return commentEnd(html, lt + 4);
  const next = html.charCodeAt(lt + 1);
  if (!isAsciiLetter(next) && next !== 0x2f && next !== 0x21 && next !== 0x3f) return lt;

  const startTagEnd = tagEnd(html, lt + 1);
  const rawText = RAW_TEXT_ELEMENTS.find((name) => tagNameIs(html, lt + 1, name));
  return rawText ? rawTextEnd(html, startTagEnd, rawText) : startTagEnd;
}

/**
 * Walks `html` left to right, handing each run of text between markup constructs to
 * `text` (an empty run included) and each construct to `markup` as the span from its
 * `<` to just past its end.
 */
function scanMarkup(
  html: string,
  text: (run: string) => void,
  markup: (start: number, end: number) => void,
): void {
  let textStart = 0;
  for (let lt = html.indexOf('<'); lt >= 0; ) {
    const end = markupEnd(html, lt);
    if (end === lt) {
      lt = html.indexOf('<', lt + 1);
      continue;
    }
    text(html.slice(textStart, lt));
    markup(lt, end);
    textStart = end;
    lt = html.indexOf('<', end);
  }
  text(html.slice(textStart));
}

/**
 * The text a reference stands for, or the reference itself when it names nothing: an
 * unknown name, U+0000, a surrogate, or a code point beyond U+10FFFF.
 */
function decodeReference(
  reference: string,
  decimal: string | undefined,
  hex: string | undefined,
  name: string | undefined,
): string {
  if (name !== undefined) return NAMED_CHARACTER_REFERENCES.get(name) ?? reference;
  const codePoint =
    decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16);
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return reference;
  }
  const remapped =
    codePoint >= 0x80 && codePoint <= 0x9f ? WINDOWS_1252_C1[codePoint - 0x80] : undefined;
  return String.fromCodePoint(remapped ?? codePoint);
}

/** `text` with each character reference in it decoded once. */
const decodeReferences = (text: string): string => text.replace(REFERENCE, decodeReference);

/** `text` with each whitespace run made one space, trimmed. */
const collapseSpace = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * A page's text as lines, built as the markup scan passes each text run and tag. Every
 * separator — line breaks, a cell's tabs, a space, whitespace inside `<pre>` — waits
 * until text follows it, and a line break or block boundary drops the tabs and spaces
 * waiting before it, so none is written at either end of the page or at the end of a line.
 * Outside `<pre>`, where only text-level tags stand between two runs of text, one space
 * stays between a letter or digit on each side outside CJK when, among those tags, an end
 * tag comes directly before a start tag other than `<sup>` or `<sub>` and a link tag comes
 * (an `</a>` that ends a link, or an `<a>` start tag): a link and the element on either side
 * of it are separate items a stylesheet spaces apart, while elements that meet with no link
 * among them (a word that changes style partway, letters in sibling spans), a note marker,
 * and CJK text join as written.
 */
class PageLines {
  private readonly parts: string[] = [];
  /** UTF-16 length of the text written so far; the scan reads it to place a page's anchors. */
  length = 0;
  /** Line breaks waiting before the next text: at most two outside `<pre>`, so blank lines collapse to one. */
  private lines = 0;
  /** Tabs waiting before the next text, one for each cell started on its line after its row's first. */
  private tabs = 0;
  /** Same-line whitespace waiting before the next text: a space outside `<pre>`, the whitespace as written inside. */
  private gap = '';
  /** Open `<pre>` elements. */
  private preDepth = 0;
  /** Nothing has come since a `<pre>` start tag, so a line feed that comes next is dropped. */
  private afterPreStartTag = false;
  /** Cells started in the current row. */
  private cells = 0;
  /** The cell count of each enclosing table's row, restored when a nested table ends. */
  private readonly tableCells: number[] = [];
  /** The last markup was an end tag outside `<pre>`, with no text since. */
  private afterEndTag = false;
  /** Since the last text, an end tag came directly before a start tag other than `<sup>` or `<sub>`. */
  private elementsMeet = false;
  /** Since the last text, an `</a>` that ended a link or an `<a>` start tag came outside `<pre>`. */
  private atLink = false;

  text(run: string): void {
    if (run === '') return;
    const text = decodeReferences(run);
    if (this.preDepth > 0) this.preText(text);
    else this.flowText(text);
  }

  /**
   * A markup construct, by its element name (`''` for a comment or a name the rules don't
   * read); `endsLink` when it is an `</a>` that closes an open `<a>`. An `</a>` with no `<a>`
   * open is one the HTML parser drops, so it leaves the two tags beside it meeting.
   */
  markup(name: string, isEndTag: boolean, endsLink: boolean): void {
    this.afterPreStartTag = false;
    if (name !== 'a' || !isEndTag || endsLink) {
      if (this.afterEndTag && !isEndTag && name !== 'sup' && name !== 'sub') {
        this.elementsMeet = true;
      }
      if (name === 'a' && this.preDepth === 0) this.atLink = true;
      this.afterEndTag = isEndTag && this.preDepth === 0;
    }
    if (name === 'br') {
      this.breakLine();
    } else if ((name === 'td' || name === 'th') && !isEndTag) {
      this.startCell();
    } else if (PAGE_BLOCK_ELEMENTS.has(name)) {
      this.startLine();
      if (name === 'pre') {
        if (!isEndTag) {
          this.preDepth++;
          this.afterPreStartTag = true;
        } else if (this.preDepth > 0) {
          this.preDepth--;
        }
      } else if (name === 'table') {
        if (isEndTag) {
          this.cells = this.tableCells.pop() ?? 0;
        } else {
          this.tableCells.push(this.cells);
          this.cells = 0;
        }
      } else if (ROW_BOUNDARY_ELEMENTS.has(name)) {
        this.cells = 0;
      }
    } else if (this.preDepth === 0 && !INLINE_ELEMENTS.has(name)) {
      this.space();
    }
  }

  /** The text written; separators still waiting are dropped. */
  finish(): string {
    return this.parts.join('');
  }

  /** Text outside `<pre>`: each whitespace run reads as one space. */
  private flowText(text: string): void {
    for (let i = 0; i < text.length; ) {
      const inSpace = isWhitespace(text.charCodeAt(i));
      let end = i + 1;
      while (end < text.length && isWhitespace(text.charCodeAt(end)) === inSpace) end++;
      if (inSpace) this.space();
      else this.write(text.slice(i, end));
      i = end;
    }
  }

  /** Text inside `<pre>`, as written: a CR, LF, or CRLF breaks the line, other whitespace waits for the text after it. */
  private preText(text: string): void {
    let i = 0;
    if (this.afterPreStartTag) {
      this.afterPreStartTag = false;
      if (text.startsWith('\r\n')) i = 2;
      else if (text[0] === '\n' || text[0] === '\r') i = 1;
    }
    while (i < text.length) {
      const code = text.charCodeAt(i);
      let end = i + 1;
      if (code === 0x0a || code === 0x0d) {
        if (code === 0x0d && text.charCodeAt(end) === 0x0a) end++;
        this.breakLine();
      } else if (isWhitespace(code)) {
        while (end < text.length && isSameLineSpace(text.charCodeAt(end))) end++;
        this.gap += text.slice(i, end);
      } else {
        while (end < text.length && !isWhitespace(text.charCodeAt(end))) end++;
        this.write(text.slice(i, end));
      }
      i = end;
    }
  }

  /** A `<br>`, or a line break inside `<pre>`: one more line break, past two only inside `<pre>`. */
  private breakLine(): void {
    if (this.length > 0 && (this.lines < 2 || this.preDepth > 0)) this.lines++;
    this.tabs = 0;
    this.gap = '';
  }

  /** A block element's start or end tag: a new line, unless one has just started. */
  private startLine(): void {
    if (this.length > 0 && this.lines === 0) this.lines = 1;
    this.tabs = 0;
    this.gap = '';
  }

  /** A `<td>` or `<th>` start tag: a tab, unless it opens its row, where it is any other markup. */
  private startCell(): void {
    if (this.cells > 0) {
      this.tabs++;
      this.gap = '';
    } else if (this.preDepth === 0) {
      this.space();
    }
    this.cells++;
  }

  /** Whitespace, or markup other than a text-level tag, outside `<pre>`: a space, unless it starts the page or a line or sits beside a tab. */
  private space(): void {
    if (this.length > 0 && this.lines === 0 && this.tabs === 0) this.gap = ' ';
  }

  /**
   * Writes `text`, which holds no whitespace, after the separators waiting before it, or after
   * one space where a link and the element beside it met and two words meet (`wordsMeet`
   * reads the last text written, the last of `parts`).
   */
  private write(text: string): void {
    let separator = this.gap;
    if (this.tabs > 0) separator = '\t'.repeat(this.tabs) + separator;
    if (this.lines > 0 && this.length > 0) separator = '\n'.repeat(this.lines) + separator;
    if (
      separator === '' &&
      this.elementsMeet &&
      this.atLink &&
      wordsMeet(this.parts.at(-1), text)
    ) {
      separator = ' ';
    }
    if (separator !== '') this.parts.push(separator);
    this.parts.push(text);
    this.length += separator.length + text.length;
    this.lines = 0;
    this.tabs = 0;
    this.gap = '';
    this.afterEndTag = false;
    this.elementsMeet = false;
    this.atLink = false;
  }
}

/** An `<a href>` element of a page, as the page's text reads it. */
export interface PageAnchor {
  /** The `href` attribute's value, character references decoded. */
  href: string;
  /**
   * UTF-16 offset in the page text where the anchor's text starts; for an anchor with no
   * text, the length of the page text written before its end.
   */
  offset: number;
  /** The anchor's text as the page text reads it, each whitespace run one space; empty when it has none, as an image-only link. */
  text: string;
}

/** A page's text with its `<a href>` elements and the `href` of its first `<base href>`. */
export interface AnchoredText {
  /** The page's `<a href>` elements in document order. */
  anchors: PageAnchor[];
  /** The `href` of the first `<base>` element that has one, character references decoded. */
  baseHref: string | undefined;
  /** The page text, exactly as `htmlToText` reads it. */
  text: string;
}

/**
 * A page's `<a href>` elements and first `<base href>`, recorded as the scan passes their
 * tags by the length of the page text written at each. An anchor holds the text written
 * between its start tag and its end tag, the next `<a>` start tag (which closes it, as in a
 * browser), or the end of the page.
 */
class PageAnchors {
  private readonly spans: { href: string; from: number; to: number }[] = [];
  /** The anchor whose end has not come yet, and the text length at its start tag. */
  private open: { href: string; from: number } | undefined;
  private baseHref: string | undefined;

  /** An `<a>` start tag: it closes the open anchor, and opens one when it has an `href`. */
  start(href: string | undefined, at: number): void {
    this.end(at);
    if (href !== undefined) this.open = { href, from: at };
  }

  /** An `</a>` end tag. */
  end(at: number): void {
    if (!this.open) return;
    this.spans.push({ ...this.open, to: at });
    this.open = undefined;
  }

  /** A `<base>` start tag's `href`; the first one given stands. */
  base(href: string | undefined): void {
    this.baseHref ??= href;
  }

  /**
   * The anchors in `text`, the page text the scan wrote, an open one ending with it. Text
   * written after a start tag begins with the separators that waited before it, so an
   * anchor's text starts at its first character that is not whitespace.
   */
  finish(text: string): AnchoredText {
    this.end(text.length);
    const anchors = this.spans.map(({ href, from, to }) => {
      let offset = from;
      while (offset < to && isWhitespace(text.charCodeAt(offset))) offset++;
      return { href: decodeReferences(href), offset, text: collapseSpace(text.slice(offset, to)) };
    });
    const baseHref = this.baseHref === undefined ? undefined : decodeReferences(this.baseHref);
    return { anchors, baseHref, text };
  }
}

/** Whether a markup construct is a start tag or an end tag; a comment, declaration, or processing instruction is neither. */
type TagKind = 'start' | 'end';

/** A hidden part: the element whose start tag hides it, how many elements of each name are open inside it, and whether an `<a>` start tag ends it. */
interface HiddenPart {
  /** The part is a hidden `<a>`'s content or was opened inside an open `<a>`, so the next `<a>` start tag, which closes that anchor and what was opened in it, ends it. */
  endsAtAnchor: boolean;
  name: string;
  opened: Map<string, number>;
}

/**
 * The parts of a page its own markup leaves unrendered, tracked as the scan passes each
 * tag. A `<template>`'s content runs to its matching end tag, templates nested in it
 * counted and every other tag ignored, as the HTML parser reads it; unclosed, it runs to
 * the end of the page, as an unclosed `<script>` or `<style>` body does. A template that
 * declares a shadow root (`shadowrootmode` `open` or `closed`) is rendered, so it is no
 * such part. A hidden part is the content of a phrasing element its own start tag hides
 * (`hidesContent`). It ends at that element's end tag, elements of its name opened inside
 * it counted; at an end tag of an element it did not open; at the next `<br>`, block, or
 * cell tag, so an unclosed one leaves out at most the rest of its line; or, inside a hidden
 * `<a>` or a hidden part opened inside an `<a>`, at the next `<a>` start tag, which closes
 * that anchor and what was opened in it, as in a browser. Inside an element whose content
 * is text (`TEXT_CONTENT_ELEMENTS`), no part opens.
 */
class UnrenderedParts {
  /** Open `<template>` elements. */
  private templateDepth = 0;
  /** The open hidden part. */
  private hidden: HiddenPart | undefined;
  /** An `<a>` start tag the page renders has come with no `</a>` since, as the page's anchors read it. */
  private anchorOpen = false;
  /** The open element whose content is text, by name. */
  private textElement: string | undefined;

  /** The scan is inside a `<template>`, whose content is not part of the page. */
  get inTemplate(): boolean {
    return this.templateDepth > 0;
  }

  /** An `<a>` is open, so an `</a>` the page renders now closes it. */
  get inAnchor(): boolean {
    return this.anchorOpen;
  }

  /** The text and markup the scan passes now read as nothing. */
  get skips(): boolean {
    return this.templateDepth > 0 || this.hidden !== undefined;
  }

  /**
   * A markup construct, by its element name and kind, with the span of a start tag's
   * attributes: whether it reads as the page's markup. A start tag that opens a template
   * or hides its content reads as any tag of its name, and what follows it reads as
   * nothing until its part ends. The tag that ends a part reads as nothing when it is the
   * template's or hidden element's own end tag, and as its tag otherwise.
   */
  tag(
    html: string,
    name: string,
    kind: TagKind | undefined,
    attributesFrom: number,
    attributesTo: number,
  ): boolean {
    if (this.templateDepth > 0) {
      if (name === 'template' && kind === 'start') this.templateDepth++;
      else if (name === 'template' && kind === 'end') this.templateDepth--;
      return false;
    }
    if (this.hidden) {
      if (kind === undefined) return false;
      const stand = this.passHidden(this.hidden, name, kind);
      if (stand === 'inside') return false;
      this.hidden = undefined;
      if (stand === 'own end tag') {
        if (name === 'a') this.anchorOpen = false;
        return false;
      }
    }
    if (this.textElement !== undefined) {
      if (kind === 'end' && name === this.textElement) this.textElement = undefined;
    } else if (kind === 'start') {
      this.openPart(html, name, attributesFrom, attributesTo);
    }
    if (name === 'a' && kind !== undefined) this.anchorOpen = kind === 'start';
    return true;
  }

  /** A start tag the page renders, outside any element whose content is text: the part it opens, if any. */
  private openPart(html: string, name: string, attributesFrom: number, attributesTo: number): void {
    if (name === 'template') {
      if (!declaresShadowRoot(html, attributesFrom, attributesTo)) this.templateDepth = 1;
    } else if (HIDEABLE_ELEMENTS.has(name) && hidesContent(html, attributesFrom, attributesTo)) {
      this.hidden = { name, opened: new Map(), endsAtAnchor: name === 'a' || this.anchorOpen };
    } else if (TEXT_CONTENT_ELEMENTS.has(name)) {
      this.textElement = name;
    }
  }

  /** Where a tag stands against the open hidden part: inside it, its own end tag, or a tag that ends it. */
  private passHidden(
    hidden: HiddenPart,
    name: string,
    kind: TagKind,
  ): 'inside' | 'own end tag' | 'ends it' {
    if (name === 'br' || name === 'td' || name === 'th' || PAGE_BLOCK_ELEMENTS.has(name)) {
      return 'ends it';
    }
    if (kind === 'start') {
      if (name === 'a' && hidden.endsAtAnchor) return 'ends it';
      if (name === 'template') this.templateDepth = 1;
      else hidden.opened.set(name, (hidden.opened.get(name) ?? 0) + 1);
      return 'inside';
    }
    const opened = hidden.opened.get(name) ?? 0;
    if (opened > 0) {
      hidden.opened.set(name, opened - 1);
      return 'inside';
    }
    return name === hidden.name ? 'own end tag' : 'ends it';
  }
}

/** A page's text, built by one scan that also hands its `<a>` and `<base>` tags to `anchors` when given. */
function pageText(html: string, anchors?: PageAnchors): string {
  const lines = new PageLines();
  const unrendered = new UnrenderedParts();
  scanMarkup(
    html,
    (run) => {
      if (!unrendered.skips) lines.text(run);
    },
    (start, end) => {
      const isEndTag = html[start + 1] === '/';
      const nameAt = isEndTag ? start + 2 : start + 1;
      const name = elementName(html, nameAt);
      const isTag = isAsciiLetter(html.charCodeAt(nameAt));
      const kind = isTag ? (isEndTag ? 'end' : 'start') : undefined;
      // Hiding an element changes how it renders, not the page's base URL; a template's content is not in the page.
      if (anchors && name === 'base' && kind === 'start' && !unrendered.inTemplate) {
        anchors.base(hrefOf(html, nameAt + 4, end));
      }
      // An `</a>` with no `<a>` open is one the HTML parser drops, so it ends no link.
      const endsLink = kind === 'end' && name === 'a' && unrendered.inAnchor;
      if (!unrendered.tag(html, name, kind, nameAt + name.length, end)) return;
      if (anchors && name === 'a') {
        if (isEndTag) anchors.end(lines.length);
        // A hidden `<a>` still closes the open anchor, but is no link itself.
        else
          anchors.start(unrendered.skips ? undefined : hrefOf(html, nameAt + 1, end), lines.length);
      }
      lines.markup(name, isEndTag, endsLink);
    },
  );
  return lines.finish();
}

/**
 * Readable plain text of an HTML page, as lines: markup removed by one scan, and each
 * character reference decoded once within its text run. The start or end tag of a block
 * element starts a new line and a `<br>` breaks one; outside `<pre>`, blank lines collapse
 * to one. Each `<td>` or `<th>` after its row's first starts with a tab, empty cells
 * included. Inside `<pre>`, text keeps its spacing and line breaks (as line feeds), except
 * a line feed directly after the start tag, and any other markup reads as nothing.
 * Elsewhere each whitespace run reads as one space, a text-level element's tag (`a`, `b`,
 * `span`, `sup`, `wbr`, …) as nothing, and any other markup as one space. Where only
 * text-level tags stand between two words, a link and the element beside it keep one space
 * between them when each side is a letter or digit outside CJK (Han, kana, Hangul, CJK
 * punctuation, fullwidth forms): among those tags, an end tag comes directly before a start
 * tag other than `<sup>` or `<sub>`, and an `</a>` that closes an open `<a>` or an `<a>`
 * start tag comes. An `</a>` with no `<a>` open, which the HTML parser drops, counts as no
 * tag. A space or tab is written only before text on its line, and no line break starts the
 * text.
 *
 * What the page's markup does not render reads as nothing: a `<template>`'s content, to
 * its matching end tag or the end of the page, unless the template declares a shadow root
 * (`shadowrootmode` `open` or `closed`); and the content of a phrasing element its own
 * start tag hides — a `hidden` attribute in any state but `until-found` that its inline
 * style does not override with another `display`, or an inline style whose winning
 * `display` is `none`, read as CSS reads it (comments, strings, brackets, and escapes
 * included). Only those attributes are read: a class, a stylesheet, `visibility`, or
 * `aria-hidden` hides nothing, and neither does a hidden block. Such an element reads as
 * its start tag alone; its hidden part ends at its own end tag (elements of its name opened
 * inside it counted), at an end tag of an element it did not open, at the next `<br>`,
 * block, or cell tag, or, for a hidden `<a>` or a hidden part opened inside an `<a>`, at
 * the next `<a>` start tag. A template or hiding start tag inside an element whose content
 * a browser reads as text (`textarea`, `title`, `xmp`, `iframe`, `noembed`, `noframes`)
 * opens nothing.
 */
export function htmlToText(html: string): string {
  return pageText(html);
}

/**
 * The text `htmlToText` reads from a page, with the page's `<a href>` elements (each
 * anchor's `href`, where its text starts, and that text on one line) and the `href` of its
 * first `<base href>`, from the same scan. An `<a>` without an `href` is no link, but its
 * start tag still closes an open one; a hidden `<a>` closes the open one and is no link.
 * An `<a>` inside a comment or a script or style body is not markup, and one inside a
 * `<template>` or a hidden element's content is not rendered, so neither is a link; one
 * inside a declarative shadow root is rendered and is a link. A `<base>` inside a template
 * is not read either.
 */
export function htmlToTextAndAnchors(html: string): AnchoredText {
  const anchors = new PageAnchors();
  return anchors.finish(pageText(html, anchors));
}

/** A character that is not whitespace. */
const VISIBLE = /\S/;

/** A character that is not whitespace, or a line break. */
const VISIBLE_OR_BREAK = /[\S\r\n]/;

/** A line break: CRLF, CR, or LF. */
const LINE_BREAK = /\r\n?|\n/;

/** Whether `code` ends an attribute name: whitespace, `/`, `>`, or `=`. */
const endsAttributeName = (code: number): boolean =>
  isSpace(code) || code === 0x2f || code === 0x3e || code === 0x3d;

/**
 * Hands `visit` each attribute of the start tag whose attributes run from `from` to `to`,
 * in order, until it returns `true`: the span of its name, and the span of its value
 * inside any quotes, or `-1` for both value ends when it is written without one.
 * Attributes are read as `tagEnd` reads them — a quote opens a value only right after
 * `=` — and never past `to`.
 */
function readAttributes(
  html: string,
  from: number,
  to: number,
  visit: (nameStart: number, nameEnd: number, valueStart: number, valueEnd: number) => boolean,
): void {
  let i = from;
  while (i < to) {
    const code = html.charCodeAt(i);
    if (code === 0x3e) return;
    if (isSpace(code) || code === 0x2f) {
      i++;
      continue;
    }
    // The first character belongs to the name even when it is `=`, as in a browser.
    const nameStart = i++;
    while (i < to && !endsAttributeName(html.charCodeAt(i))) i++;
    const nameEnd = i;
    let valueStart = i;
    while (valueStart < to && isSpace(html.charCodeAt(valueStart))) valueStart++;
    if (valueStart >= to || html.charCodeAt(valueStart) !== 0x3d) {
      i = valueStart;
      if (visit(nameStart, nameEnd, -1, -1)) return;
      continue;
    }
    valueStart++;
    while (valueStart < to && isSpace(html.charCodeAt(valueStart))) valueStart++;
    const quote = html[valueStart];
    let valueEnd = valueStart;
    if (quote === '"' || quote === "'") {
      valueEnd++;
      while (valueEnd < to && html[valueEnd] !== quote) valueEnd++;
      i = valueEnd + 1;
      if (visit(nameStart, nameEnd, valueStart + 1, valueEnd)) return;
    } else {
      while (valueEnd < to && !isSpace(html.charCodeAt(valueEnd)) && html[valueEnd] !== '>') {
        valueEnd++;
      }
      i = valueEnd;
      if (visit(nameStart, nameEnd, valueStart, valueEnd)) return;
    }
  }
}

/** Whether the attribute name spanning `start` to `end` is `name` (given in lower case), in any case. */
const attributeNameIs = (html: string, start: number, end: number, name: string): boolean =>
  end - start === name.length && html.slice(start, end).toLowerCase() === name;

/**
 * The raw value of the first `href` written with a value in the start tag whose attributes
 * run from `from` to `to`, or `undefined` when it has none.
 */
function hrefOf(html: string, from: number, to: number): string | undefined {
  let href: string | undefined;
  readAttributes(html, from, to, (nameStart, nameEnd, valueStart, valueEnd) => {
    if (valueStart < 0 || !attributeNameIs(html, nameStart, nameEnd, 'href')) return false;
    href = html.slice(valueStart, valueEnd);
    return true;
  });
  return href;
}

/**
 * Whether the start tag whose attributes run from `from` to `to` hides its element's
 * content: the first `style` attribute's winning `display` is `none`, or, when that
 * declares no `display`, the first `hidden` attribute is in the hidden state — any value,
 * empty included, but `until-found` in any ASCII case. Attribute values are read with
 * their character references decoded, as a browser reads them.
 */
function hidesContent(html: string, from: number, to: number): boolean {
  let hidden: string | undefined;
  let style: string | undefined;
  readAttributes(html, from, to, (nameStart, nameEnd, valueStart, valueEnd) => {
    if (hidden === undefined && attributeNameIs(html, nameStart, nameEnd, 'hidden')) {
      hidden = valueStart < 0 ? '' : html.slice(valueStart, valueEnd);
    } else if (style === undefined && attributeNameIs(html, nameStart, nameEnd, 'style')) {
      style = valueStart < 0 ? '' : html.slice(valueStart, valueEnd);
    }
    return hidden !== undefined && style !== undefined;
  });
  const display = style === undefined ? undefined : displayOf(decodeReferences(style));
  if (display !== undefined) return display === 'none';
  return hidden !== undefined && decodeReferences(hidden).toLowerCase() !== 'until-found';
}

/**
 * Whether the `<template>` start tag whose attributes run from `from` to `to` declares a
 * shadow root, which a browser renders where the template stands: its first
 * `shadowrootmode` attribute is `open` or `closed` in any ASCII case, character references
 * decoded.
 */
function declaresShadowRoot(html: string, from: number, to: number): boolean {
  let mode: string | undefined;
  readAttributes(html, from, to, (nameStart, nameEnd, valueStart, valueEnd) => {
    if (!attributeNameIs(html, nameStart, nameEnd, 'shadowrootmode')) return false;
    mode = valueStart < 0 ? '' : decodeReferences(html.slice(valueStart, valueEnd)).toLowerCase();
    return true;
  });
  return mode === 'open' || mode === 'closed';
}

/**
 * The `display` value an inline `style` declares, in lower case without `!important`, or
 * `undefined` when it declares none: the last `display` declaration, unless an earlier one
 * is `!important` and it is not. A declaration with no value is dropped, as CSS drops an
 * invalid one.
 */
function displayOf(style: string): string | undefined {
  let display: string | undefined;
  let important = false;
  readDeclarations(style, (name, value, isImportant) => {
    if (name.toLowerCase() !== 'display' || value === '' || (important && !isImportant)) return;
    display = value.toLowerCase();
    important = isImportant;
  });
  return display;
}

/** A CSS newline: line feed, form feed, or carriage return. */
const isCssNewline = (code: number): boolean => code === 0x0a || code === 0x0c || code === 0x0d;

/** An ASCII hex digit. */
const isHexDigit = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x46) ||
  (code >= 0x61 && code <= 0x66);

/** `text` without the CSS whitespace (HTML whitespace's five characters) at either end. */
function trimCssSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text.charCodeAt(start))) start++;
  while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

/**
 * The character the CSS escape whose `\` sits just before `at` decodes to, and the index
 * just past the escape: one to six hex digits, and one whitespace character after them
 * (CRLF counting as one), name a code point — U+FFFD for zero, a surrogate, or one past
 * U+10FFFF; any other character stands for itself; the end of the style decodes to U+FFFD.
 */
function cssEscape(style: string, at: number): [char: string, end: number] {
  if (at >= style.length) return ['�', at];
  let end = at;
  while (end < at + 6 && end < style.length && isHexDigit(style.charCodeAt(end))) end++;
  if (end === at) {
    const char = String.fromCodePoint(style.codePointAt(at) ?? 0xfffd);
    return [char, at + char.length];
  }
  const codePoint = Number.parseInt(style.slice(at, end), 16);
  if (style.startsWith('\r\n', end)) end += 2;
  else if (end < style.length && isSpace(style.charCodeAt(end))) end++;
  const named =
    codePoint !== 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
  return [named ? String.fromCodePoint(codePoint) : '�', end];
}

/**
 * Hands `visit` each declaration of an inline `style` that has a `:`, in order: its property
 * name and its value without a final `!important`, each trimmed of CSS whitespace, and
 * whether it was `!important`. The style is read as CSS tokenizes a declaration list. A
 * comment reads as whitespace, an unclosed one running to the end. An escape is decoded and
 * is never punctuation; one CSS would read as whitespace is read as U+FFFD, which no
 * property name or keyword holds, so trimming leaves it in. A `;` ends a declaration, the
 * first `:` its name, and a `!` its value before `important`, only outside strings,
 * parentheses, brackets, and braces; a line break ends an unclosed string, and the end of
 * the style ends whatever is still open.
 */
function readDeclarations(
  style: string,
  visit: (name: string, value: string, important: boolean) => void,
): void {
  /** The declaration read so far, escapes decoded and comments as spaces, up to `from`. */
  let text = '';
  /** Where in `text` the value starts, after the `:` that ends the name; `-1` before one. */
  let colon = -1;
  /** Where in `text` the value's last `!` outside strings and brackets sits; `-1` for none. */
  let bang = -1;
  /** The closing character of each parenthesis, bracket, or brace open around the read. */
  const closers: number[] = [];
  /** The quote of the open string, or 0 outside one. */
  let quote = 0;
  /** Where the part of `style` not yet added to `text` starts. */
  let from = 0;
  const endDeclaration = (to: number) => {
    text += style.slice(from, to);
    if (colon >= 0) {
      const important =
        bang >= 0 && trimCssSpace(text.slice(bang + 1)).toLowerCase() === 'important';
      const value = text.slice(colon, important ? bang : text.length);
      visit(trimCssSpace(text.slice(0, colon)), trimCssSpace(value), important);
    }
    text = '';
    colon = -1;
    bang = -1;
  };
  let i = 0;
  while (i < style.length) {
    const code = style.charCodeAt(i);
    if (quote !== 0) {
      // An escape keeps the character after it, a quote or a line break included, in the string.
      if (code === 0x5c) {
        i += style.startsWith('\r\n', i + 1) ? 3 : 2;
        continue;
      }
      if (code === quote || isCssNewline(code)) quote = 0;
    } else if (code === 0x5c && !isCssNewline(style.charCodeAt(i + 1))) {
      const [char, end] = cssEscape(style, i + 1);
      text += style.slice(from, i) + (isSpace(char.charCodeAt(0)) ? '�' : char);
      i = from = end;
      continue;
    } else if (code === 0x2f && style.charCodeAt(i + 1) === 0x2a) {
      text += `${style.slice(from, i)} `;
      const close = style.indexOf('*/', i + 2);
      i = from = close < 0 ? style.length : close + 2;
      continue;
    } else if (code === 0x22 || code === 0x27) {
      quote = code;
    } else if (code === 0x28) {
      closers.push(0x29);
    } else if (code === 0x5b) {
      closers.push(0x5d);
    } else if (code === 0x7b) {
      closers.push(0x7d);
    } else if (closers.length > 0) {
      if (code === closers[closers.length - 1]) closers.pop();
    } else if (code === 0x3b) {
      endDeclaration(i);
      from = i + 1;
    } else if (code === 0x3a && colon < 0) {
      text += style.slice(from, i);
      colon = text.length;
      from = i + 1;
    } else if (code === 0x21 && colon >= 0) {
      // The `!` stays in the value unless `important` follows it.
      text += style.slice(from, i);
      bang = text.length;
      from = i;
    }
    i++;
  }
  endDeclaration(style.length);
}

/**
 * A description's raw text, character references still encoded, with the line structure
 * its tags imply. A block boundary waits until text follows on its line, so a line break
 * already in the value right after it serves as its break rather than adding a blank line.
 */
class DescriptionLines {
  private readonly parts: string[] = [];
  /** The current line holds a character that is not whitespace. */
  private lineHasText = false;
  /** A block boundary wants a line break before the next text on this line. */
  private breakPending = false;
  /** The open link: its URL and the index in `parts` where its label starts. */
  private link: { url: string; labelStart: number } | undefined;

  text(run: string): void {
    if (run === '') return;
    if (this.breakPending) {
      const first = run.search(VISIBLE_OR_BREAK);
      if (first < 0) {
        this.parts.push(run);
        return;
      }
      this.breakPending = false;
      if (run[first] !== '\n' && run[first] !== '\r') {
        this.parts.push('\n');
        this.lineHasText = false;
      }
    }
    this.parts.push(run);
    const lastBreak = Math.max(run.lastIndexOf('\n'), run.lastIndexOf('\r'));
    if (lastBreak >= 0) this.lineHasText = VISIBLE.test(run.slice(lastBreak + 1));
    else if (!this.lineHasText) this.lineHasText = VISIBLE.test(run);
  }

  /** A start or end tag of a block element: a new line, unless one has just started. */
  blockBoundary(): void {
    if (this.lineHasText) this.breakPending = true;
  }

  /** A `<br>`: always a line break, after the one a pending block boundary wants. */
  lineBreak(): void {
    this.parts.push(this.breakPending ? '\n\n' : '\n');
    this.breakPending = false;
    this.lineHasText = false;
  }

  /** An `<a>` start tag, which closes any open link as a browser does. */
  openLink(href: string | undefined): void {
    this.closeLink();
    this.text(' ');
    // A URL parser drops tabs and line breaks and trims the ends.
    const url = href?.replace(/[\t\n\r]/g, '').trim();
    if (url) this.link = { url, labelStart: this.parts.length };
  }

  /** An `</a>` end tag: the label followed by ` (URL)`, or the URL alone when the label is empty or is the URL. */
  closeLink(): void {
    if (!this.link) return;
    const { url, labelStart } = this.link;
    this.link = undefined;
    const label = collapseSpace(decodeReferences(this.parts.slice(labelStart).join('')));
    if (label === '') this.text(url);
    else if (label !== decodeReferences(url)) this.text(` (${url})`);
  }

  /** The lines: references decoded once, whitespace collapsed and trimmed per line, blank lines dropped at both ends. */
  finish(): string {
    this.closeLink();
    const lines = decodeReferences(this.parts.join('')).split(LINE_BREAK).map(collapseSpace);
    let first = 0;
    while (first < lines.length && lines[first] === '') first++;
    let end = lines.length;
    while (end > first && lines[end - 1] === '') end--;
    return lines.slice(first, end).join('\n');
  }
}

/**
 * Plain-text lines of an item description, which the Archive stores as HTML or plain
 * text: markup removed by the scan `htmlToText` uses and references decoded once, with
 * line structure kept. A `<br>` is a line break; a start or end tag of `p`, `div`, or `li`
 * starts a new line unless one has just started; line breaks already in the value stay.
 * Spaces, tabs, and non-breaking spaces collapse within a line and are trimmed at its
 * ends, and blank lines at either end are dropped. `<a href="URL">label</a>` reads
 * `label (URL)`, or the URL alone when the label is empty or is that URL. Any other tag of
 * a text-level element (`b`, `i`, `span`, `sup`, …) reads as nothing, as in a page, and any
 * other markup construct as a space.
 */
export function descriptionToText(html: string): string {
  const lines = new DescriptionLines();
  scanMarkup(
    html,
    (run) => lines.text(run),
    (start, end) => {
      const nameAt = html[start + 1] === '/' ? start + 2 : start + 1;
      const name = elementName(html, nameAt);
      if (name === 'br') lines.lineBreak();
      else if (BLOCK_ELEMENTS.has(name)) lines.blockBoundary();
      else if (name === 'a' && nameAt === start + 1) lines.openLink(hrefOf(html, nameAt + 1, end));
      else if (name === 'a') lines.closeLink();
      else if (!INLINE_ELEMENTS.has(name)) lines.text(' ');
    },
  );
  return lines.finish();
}
