/**
 * @fileoverview Literal phrase matching for `ia_get_text`'s `find`. Letters compare under Unicode
 * simple case folding, one code point to one, so every offset stays an offset in the file's own
 * text; a White_Space run in the phrase matches any run of one or more White_Space characters in the
 * text; every other character matches itself. Text streams through a Knuth–Morris–Pratt matcher
 * over those tokens, whose time is linear in the text for any phrase and whose state is
 * proportional to the phrase. No regular expression is built from the phrase.
 * @module services/archive-metadata/phrase-matcher
 */

/** The token a White_Space run becomes, in the phrase and in the text. */
const RUN = -1;

/** U+3000 IDEOGRAPHIC SPACE, the last White_Space code point (a test checks the whole range). */
const LAST_WHITE_SPACE = 0x3000;

/** The Unicode White_Space property by code point, as the regex engine's `\p{White_Space}` reports it. */
const WHITE_SPACE = (() => {
  const table = new Uint8Array(LAST_WHITE_SPACE + 1);
  const property = /^\p{White_Space}$/u;
  for (let cp = 0; cp <= LAST_WHITE_SPACE; cp++) {
    if (property.test(String.fromCodePoint(cp))) table[cp] = 1;
  }
  return table;
})();

/** Whether `cp` has the Unicode White_Space property. */
export const isWhiteSpace = (cp: number): boolean =>
  cp <= LAST_WHITE_SPACE && WHITE_SPACE[cp] === 1;

/** Past this no code point has a case mapping on either runtime (a test checks the whole range). */
const CASED_LIMIT = 0x20000;

let foldTable: Map<number, number> | undefined;

/**
 * Every cased code point that is not the least of its case class, mapped to that least one. The
 * classes are the `iu` regex flags' — simple case folding, CaseFolding.txt statuses C and S, from
 * the runtime's own Unicode data — read from the regex engine itself, because no
 * `toLowerCase`/`toUpperCase` composition reproduces them: `lower(upper(ı))` is `i`, which simple
 * folding keeps apart, and the S-only pairs `ﬅ`/`ﬆ`, `ΐ`/`ΐ`, `ΰ`/`ΰ` share no single-code-point
 * mapping. Built on first use, in about 20 ms.
 */
function buildFoldTable(): Map<number, number> {
  const cased: number[] = [];
  for (let cp = 0; cp < CASED_LIMIT; cp++) {
    if (cp === 0xd800) cp = 0xe000;
    const c = String.fromCodePoint(cp);
    if (c.toLowerCase() !== c || c.toUpperCase() !== c) cased.push(cp);
  }
  const all = String.fromCodePoint(...cased);
  const table = new Map<number, number>();
  const seen = new Set<number>();
  // Ascending order, so the first member of a class reached is its least.
  for (const cp of cased) {
    if (seen.has(cp)) continue;
    for (const [member] of all.matchAll(new RegExp(`\\u{${cp.toString(16)}}`, 'giu'))) {
      const equal = member.codePointAt(0) as number;
      seen.add(equal);
      if (equal !== cp) table.set(equal, cp);
    }
  }
  return table;
}

/**
 * `cp` under simple case folding: the least code point the `iu` regex flags treat as the same
 * letter (`ſ`, `s`, and `S` are all `S`; `ß` and `ẞ` are `ß`; `İ` and `ı` stay themselves).
 */
export function foldCodePoint(cp: number): number {
  if (cp < 0x80) return cp >= 0x61 && cp <= 0x7a ? cp - 0x20 : cp;
  foldTable ??= buildFoldTable();
  return foldTable.get(cp) ?? cp;
}

/** A compiled `find` phrase. */
export interface Phrase {
  /** Knuth–Morris–Pratt failure table: `fail[i]` is the longest proper border of `tokens[0..i]`. */
  readonly fail: Int32Array;
  /** UTF-16 length of the phrase from its first to its last non-White_Space character. */
  readonly length: number;
  /** Folded code points, and `RUN` for each White_Space run; never begins or ends with a run. */
  readonly tokens: Int32Array;
}

/** `find` as a phrase, or `undefined` when it holds nothing but White_Space. */
export function compilePhrase(find: string): Phrase | undefined {
  const tokens: number[] = [];
  let first = -1;
  let end = 0;
  let offset = 0;
  for (const ch of find) {
    const cp = ch.codePointAt(0) as number;
    if (!isWhiteSpace(cp)) {
      tokens.push(foldCodePoint(cp));
      if (first < 0) first = offset;
      end = offset + ch.length;
    } else if (tokens.length > 0 && tokens.at(-1) !== RUN) {
      tokens.push(RUN);
    }
    offset += ch.length;
  }
  if (tokens.at(-1) === RUN) tokens.pop();
  if (tokens.length === 0) return undefined;
  const fail = new Int32Array(tokens.length);
  for (let i = 1, k = 0; i < tokens.length; i++) {
    while (k > 0 && tokens[i] !== tokens[k]) k = fail[k - 1] as number;
    if (tokens[i] === tokens[k]) k++;
    fail[i] = k;
  }
  return { tokens: Int32Array.from(tokens), fail, length: end - first };
}

/**
 * Streams the text's code points through a phrase and reports when its first match completes. A
 * White_Space run is one token, every other code point one folded token. Work per code point is
 * amortized constant whatever the phrase, and the only state besides the phrase is, for each of
 * its tokens, the UTF-16 offset and byte offset where the text's token began.
 */
export class PhraseMatcher {
  private readonly bytes: Float64Array;
  private fed = 0;
  private inRun = false;
  private matched = 0;
  private readonly offsets: Float64Array;
  private readonly phrase: Phrase;

  constructor(phrase: Phrase) {
    this.phrase = phrase;
    this.offsets = new Float64Array(phrase.tokens.length);
    this.bytes = new Float64Array(phrase.tokens.length);
  }

  /**
   * Tokens in the longest partial match still live — every other live one is a suffix of it, so
   * token 0 of this one is the earliest place a match can still begin — or in the match once
   * `push` has returned true; 0 when none is live.
   */
  get length(): number {
    return this.matched;
  }

  /** Byte offset where token `i` (below `length`) of the live or completed match begins. */
  byteOf(i: number): number {
    return this.bytes[this.slot(i)] as number;
  }

  /** Whether token `i` of the live or completed match is a White_Space run. */
  isRun(i: number): boolean {
    return this.phrase.tokens[i] === RUN;
  }

  /** UTF-16 offset where token `i` (below `length`) of the live or completed match begins. */
  offsetOf(i: number): number {
    return this.offsets[this.slot(i)] as number;
  }

  /**
   * Feed the code point at UTF-16 `offset` whose encoding begins at byte `byte`, in text order.
   * Returns true when it completes a match, which then spans tokens 0 through `length - 1`.
   */
  push(cp: number, offset: number, byte: number): boolean {
    let token: number;
    if (isWhiteSpace(cp)) {
      if (this.inRun) return false;
      this.inRun = true;
      token = RUN;
    } else {
      this.inRun = false;
      token = foldCodePoint(cp);
    }
    const { tokens, fail } = this.phrase;
    const slot = this.fed++ % tokens.length;
    this.offsets[slot] = offset;
    this.bytes[slot] = byte;
    let q = this.matched;
    while (q > 0 && tokens[q] !== token) q = fail[q - 1] as number;
    if (tokens[q] === token) q++;
    this.matched = q;
    return q === tokens.length;
  }

  private slot(i: number): number {
    return (this.fed - this.matched + i) % this.phrase.tokens.length;
  }
}
