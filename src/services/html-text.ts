/**
 * @fileoverview Plain-text extraction from HTML: one left-to-right markup scan, then one
 * left-to-right character-reference decode, then whitespace handling. `htmlToText` reads
 * an archived page as one run of words; `descriptionToText` reads an item description —
 * HTML from the Archive's upload editor, or plain text — as lines. The result is plain
 * text for a model to read — it is never rendered as HTML.
 *
 * The markup scan is plain index arithmetic rather than a regular expression. Every
 * step moves forward, so its cost is linear in the input length on any input and in
 * any engine. An archived page is content anyone can publish through Save Page Now, and
 * an item description is whatever its uploader typed; a backtracking pattern over either
 * can stall the event loop on crafted input.
 * @module services/html-text
 */

import { NAMED_CHARACTER_REFERENCES } from './html-entities.js';

/** Elements whose body is raw text: nothing inside is markup until their end tag. */
const RAW_TEXT_ELEMENTS = ['script', 'style'] as const;

/** Elements whose start or end tag begins a new line of a description. */
const BLOCK_ELEMENTS = ['p', 'div', 'li'] as const;

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

/** The page with every markup construct replaced by a space, so adjacent cells stay separate words. */
function stripMarkup(html: string): string {
  const parts: string[] = [];
  scanMarkup(
    html,
    (run) => parts.push(run),
    () => parts.push(' '),
  );
  return parts.join('');
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

/** Readable plain text of an HTML document: markup removed, references decoded once, whitespace collapsed. */
export function htmlToText(html: string): string {
  return collapseSpace(decodeReferences(stripMarkup(html)));
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
 * The raw `href` value of the start tag whose attributes run from `from` to `to`, or
 * `undefined` when it has none. Attributes are read as `tagEnd` reads them — a quote
 * opens a value only right after `=` — and never past `to`.
 */
function hrefOf(html: string, from: number, to: number): string | undefined {
  let i = from;
  while (i < to) {
    const code = html.charCodeAt(i);
    if (code === 0x3e) return undefined;
    if (isSpace(code) || code === 0x2f) {
      i++;
      continue;
    }
    // The first character belongs to the name even when it is `=`, as in a browser.
    const nameStart = i++;
    while (i < to && !endsAttributeName(html.charCodeAt(i))) i++;
    const isHref = i - nameStart === 4 && html.slice(nameStart, i).toLowerCase() === 'href';
    let valueStart = i;
    while (valueStart < to && isSpace(html.charCodeAt(valueStart))) valueStart++;
    if (valueStart >= to || html.charCodeAt(valueStart) !== 0x3d) {
      i = valueStart;
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
      if (isHref) return html.slice(valueStart + 1, valueEnd);
    } else {
      while (valueEnd < to && !isSpace(html.charCodeAt(valueEnd)) && html[valueEnd] !== '>') {
        valueEnd++;
      }
      i = valueEnd;
      if (isHref) return html.slice(valueStart, valueEnd);
    }
  }
  return undefined;
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
 * `label (URL)`, or the URL alone when the label is empty or is that URL. Any other
 * markup construct reads as a space.
 */
export function descriptionToText(html: string): string {
  const lines = new DescriptionLines();
  scanMarkup(
    html,
    (run) => lines.text(run),
    (start, end) => {
      const nameAt = html[start + 1] === '/' ? start + 2 : start + 1;
      if (tagNameIs(html, nameAt, 'br')) lines.lineBreak();
      else if (BLOCK_ELEMENTS.some((name) => tagNameIs(html, nameAt, name))) lines.blockBoundary();
      else if (!tagNameIs(html, nameAt, 'a')) lines.text(' ');
      else if (nameAt === start + 1) lines.openLink(hrefOf(html, nameAt + 1, end));
      else lines.closeLink();
    },
  );
  return lines.finish();
}
