/**
 * @fileoverview Plain-text extraction from archived HTML: one left-to-right markup scan,
 * then one left-to-right character-reference decode, then whitespace collapse. The
 * result is plain text for a model to read — it is never rendered as HTML.
 *
 * The markup scan is plain index arithmetic rather than a regular expression. Every
 * step moves forward, so its cost is linear in the page length on any input and in
 * any engine. An archived page is content anyone can publish through Save Page Now,
 * and a backtracking pattern over it can stall the event loop on a crafted capture.
 * @module services/wayback/html-text
 */

import { NAMED_CHARACTER_REFERENCES } from './html-entities.js';

/** Elements whose body is raw text: nothing inside is markup until their end tag. */
const RAW_TEXT_ELEMENTS = ['script', 'style'] as const;

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
    const nameEnd = open + 2 + name.length;
    if (html.slice(open + 2, nameEnd).toLowerCase() === name && tagNameEndsAt(html, nameEnd)) {
      return tagEnd(html, nameEnd);
    }
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
  const rawText = RAW_TEXT_ELEMENTS.find(
    (name) =>
      html.slice(lt + 1, lt + 1 + name.length).toLowerCase() === name &&
      tagNameEndsAt(html, lt + 1 + name.length),
  );
  return rawText ? rawTextEnd(html, startTagEnd, rawText) : startTagEnd;
}

/** The page with every markup construct replaced by a space, so adjacent cells stay separate words. */
function stripMarkup(html: string): string {
  const text: string[] = [];
  let textStart = 0;
  for (let lt = html.indexOf('<'); lt >= 0; ) {
    const end = markupEnd(html, lt);
    if (end === lt) {
      lt = html.indexOf('<', lt + 1);
      continue;
    }
    text.push(html.slice(textStart, lt));
    textStart = end;
    lt = html.indexOf('<', end);
  }
  text.push(html.slice(textStart));
  return text.join(' ');
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

/** Readable plain text of an HTML document: markup removed, references decoded once, whitespace collapsed. */
export function htmlToText(html: string): string {
  return stripMarkup(html).replace(REFERENCE, decodeReference).replace(/\s+/g, ' ').trim();
}
