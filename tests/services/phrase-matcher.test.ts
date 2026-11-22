/**
 * @fileoverview Tests for the `find` phrase matcher: simple case folding against the `iu` regex
 * flags as oracle, the White_Space property, phrase compilation, the matching rules, the earliest
 * match among overlapping candidates against a brute-force search, the token offsets a caller
 * reads back, and linear time over adversarial inputs.
 * @module tests/services/phrase-matcher.test
 */

import { describe, expect, it } from 'vitest';
import {
  compilePhrase,
  foldCodePoint,
  isWhiteSpace,
  PhraseMatcher,
} from '@/services/archive-metadata/phrase-matcher.js';
import { expectLinearDoubling } from '../helpers/cpu-time.js';

/** Whether the `iu` flags treat code points `a` and `b` as one letter. */
const sameUnderIu = (a: number, b: number): boolean =>
  new RegExp(`^\\u{${a.toString(16)}}$`, 'iu').test(String.fromCodePoint(b));

/**
 * The UTF-16 offset where `find`'s first match in `text` begins, feeding one code point at a time;
 * each code point's byte offset is fed as its UTF-16 offset × 10, so `byteOf` can be read back.
 */
const firstMatch = (text: string, find: string): number | undefined => {
  const phrase = compilePhrase(find);
  if (!phrase) throw new Error(`blank phrase ${JSON.stringify(find)}`);
  const matcher = new PhraseMatcher(phrase);
  let offset = 0;
  for (const ch of text) {
    if (matcher.push(ch.codePointAt(0) as number, offset, offset * 10)) return matcher.offsetOf(0);
    offset += ch.length;
  }
  return undefined;
};

/** Every scalar value, surrogates skipped. */
function* allCodePoints(from = 0): Generator<number> {
  for (let cp = from; cp <= 0x10ffff; cp++) {
    if (cp === 0xd800) cp = 0xe000;
    yield cp;
  }
}

describe('foldCodePoint', () => {
  it.each([
    ['ſ', 's', true],
    ['ſ', 'S', true],
    ['ß', 'ẞ', true],
    ['K', 'k', true],
    ['ς', 'σ', true],
    ['Ω', 'ω', true],
    ['ﬅ', 'ﬆ', true],
    ['ΐ', 'ΐ', true],
    ['ΰ', 'ΰ', true],
    ['ͅ', 'ι', true],
    ['ẛ', 'ṡ', true],
    ['ꭰ', 'Ꭰ', true],
    ['İ', 'i', false],
    ['İ', 'I', false],
    ['ı', 'i', false],
    ['ı', 'I', false],
    ['é', 'e', false],
  ])('folds %s and %s together: %s, as the iu flags do', (a, b, together) => {
    const [x, y] = [a.codePointAt(0) as number, b.codePointAt(0) as number];
    expect(sameUnderIu(x, y)).toBe(together);
    expect(foldCodePoint(x) === foldCodePoint(y)).toBe(together);
  });

  it('leaves every code point at or past U+20000 without a case mapping', () => {
    for (const cp of allCodePoints(0x20000)) {
      const c = String.fromCodePoint(cp);
      if (c.toLowerCase() !== c || c.toUpperCase() !== c) throw new Error(`U+${cp.toString(16)}`);
    }
  });

  it('partitions the cased code points exactly as the iu flags do, and folds every other code point to itself', () => {
    const cased: number[] = [];
    for (const cp of allCodePoints()) {
      const c = String.fromCodePoint(cp);
      if (c.toLowerCase() !== c || c.toUpperCase() !== c) cased.push(cp);
    }
    const all = String.fromCodePoint(...cased);
    const byFold = new Map<number, number[]>();
    for (const cp of cased) {
      const key = foldCodePoint(cp);
      byFold.set(key, [...(byFold.get(key) ?? []), cp]);
    }
    for (const cp of cased) {
      const underIu = [...all.matchAll(new RegExp(`\\u{${cp.toString(16)}}`, 'giu'))].map(
        ([m]) => m.codePointAt(0) as number,
      );
      expect(byFold.get(foldCodePoint(cp)), `U+${cp.toString(16)}`).toEqual(underIu);
    }

    const anyCased = new RegExp(`[${cased.map((cp) => `\\u{${cp.toString(16)}}`).join('')}]`, 'iu');
    const casedSet = new Set(cased);
    for (const cp of allCodePoints()) {
      if (casedSet.has(cp)) continue;
      if (anyCased.test(String.fromCodePoint(cp)) || foldCodePoint(cp) !== cp) {
        throw new Error(`U+${cp.toString(16)} shares a case class`);
      }
    }
  });
});

describe('isWhiteSpace', () => {
  it('is the Unicode White_Space property over every code point', () => {
    const property = /^\p{White_Space}$/u;
    let count = 0;
    for (const cp of allCodePoints()) {
      const expected = property.test(String.fromCodePoint(cp));
      if (isWhiteSpace(cp) !== expected) throw new Error(`U+${cp.toString(16)}`);
      if (expected) count++;
    }
    expect(count).toBe(25);
    expect(isWhiteSpace(0x85)).toBe(true);
    expect(isWhiteSpace(0xfeff)).toBe(false);
  });
});

describe('compilePhrase', () => {
  it.each(['', ' ', '\n\t ', '　', '\u0085', '   '])(
    'reads %j, holding only White_Space, as no phrase',
    (find) => {
      expect(compilePhrase(find)).toBeUndefined();
    },
  );

  it('trims the phrase and collapses each internal run to one token', () => {
    const plain = compilePhrase('Mr. Darcy');
    expect(compilePhrase(' \n Mr.   \n Darcy\t')?.tokens).toEqual(plain?.tokens);
    expect(plain?.tokens.length).toBe(9);
  });

  it('measures the phrase in UTF-16 units from its first to its last non-White_Space character', () => {
    expect(compilePhrase('  a  b ')?.length).toBe(4);
    expect(compilePhrase('𝄞 x')?.length).toBe(4);
  });

  it('builds the failure table of a self-overlapping phrase', () => {
    expect([...(compilePhrase('abab')?.fail ?? [])]).toEqual([0, 0, 1, 2]);
    expect([...(compilePhrase('a a')?.fail ?? [])]).toEqual([0, 0, 1]);
  });
});

describe('PhraseMatcher matching rules', () => {
  it.each([
    ['PEMBERLEY', 'without  Pemberley  as', 9],
    ['pemberley', 'without  Pemberley  as', 9],
    ['Mr. Darcy', 'when  Mr.  Darcy \n"', 6],
    ['Mr. Darcy', 'Mr.\n   Darcy', 0],
    ['Mr. Darcy', 'Mr.　Darcy', 0],
    ['Mr.    Darcy', 'Mr. Darcy', 0],
    ['ſun', 'the Sun', 4],
    ['sun', 'ſun', 0],
    ['ß', 'STRAẞE', 4],
    ['(x', 'f(x)', 1],
    ['a*', 'aaa a*', 4],
    ['a.c', 'abc a.c', 4],
    ['\\d', 'd \\d', 2],
    ['aab', 'aaab', 1],
    ['abab', 'abaabab', 3],
  ])('matches %j in %j at %i', (find, text, offset) => {
    expect(firstMatch(text, find)).toBe(offset);
  });

  it.each([
    ['Mr. Darcy', 'Mr.Darcy'],
    ['Pemberley', 'grounds  of \nP  ember  ley.'],
    ['Pemberley', 'reaching  Pem- \nberley  ;'],
    ['ss', 'Straße'],
    ['ß', 'strasse'],
    ['fi', 'ﬁnd'],
    ['i', 'İ ı'],
    ['é', 'é'],
    ['a.c', 'abc'],
    ['a b', 'a'],
  ])('does not match %j in %j', (find, text) => {
    expect(firstMatch(text, find)).toBeUndefined();
  });

  it('reports the match at its offset in the text as stored after İ, ß, ﬁ, and an astral character', () => {
    const text = 'İß ﬁ 𝄞 Straße — and then Pemberley.';
    expect(firstMatch(text, 'PEMBERLEY')).toBe(text.indexOf('Pemberley'));
    expect(firstMatch(text, 'STRAẞE')).toBe(text.indexOf('Straße'));
  });

  it('reads back each token of a completed match with the offsets it was fed', () => {
    const phrase = compilePhrase('Mr. 𝄞 x') as NonNullable<ReturnType<typeof compilePhrase>>;
    const matcher = new PhraseMatcher(phrase);
    const text = 'so Mr.  \n𝄞   x!';
    let offset = 0;
    let done = false;
    for (const ch of text) {
      done ||= matcher.push(ch.codePointAt(0) as number, offset, offset * 10);
      if (done) break;
      offset += ch.length;
    }
    expect(done).toBe(true);
    const tokens = Array.from({ length: matcher.length }, (_, i) => [
      matcher.offsetOf(i),
      matcher.byteOf(i),
      matcher.isRun(i),
    ]);
    expect(tokens).toEqual([
      [3, 30, false],
      [4, 40, false],
      [5, 50, false],
      [6, 60, true],
      [9, 90, false],
      [11, 110, true],
      [14, 140, false],
    ]);
  });

  it('tracks the earliest live candidate as partial matches fail', () => {
    const matcher = new PhraseMatcher(
      compilePhrase('aaab') as NonNullable<ReturnType<typeof compilePhrase>>,
    );
    const starts: number[] = [];
    [...'aaaab'].forEach((ch, i) => {
      matcher.push(ch.codePointAt(0) as number, i, i);
      starts.push(matcher.length > 0 ? matcher.offsetOf(0) : -1);
    });
    expect(starts).toEqual([0, 0, 0, 1, 1]);
  });
});

describe('PhraseMatcher against a brute-force search', () => {
  /** Seeded PRNG (mulberry32) so the sweep is reproducible. */
  const seededRandom = (seed: number): (() => number) => {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  };

  const property = /^\p{White_Space}$/u;
  const isRun = (ch: string) => property.test(ch);

  /** Restart at every code point: White_Space in the phrase takes one maximal run, a letter one letter equal under `iu`. */
  const bruteForce = (text: string, find: string): number | undefined => {
    const pieces = find.trim().split(/\p{White_Space}+/u);
    const phrase = pieces.flatMap((piece, k) => [...(k > 0 ? [' '] : []), ...piece]);
    const chars = [...text];
    for (let i = 0, offset = 0; i < chars.length; offset += (chars[i] as string).length, i++) {
      let j = i;
      let k = 0;
      for (; k < phrase.length && j < chars.length; k++) {
        const want = phrase[k] as string;
        const have = chars[j] as string;
        if (want === ' ') {
          if (!isRun(have)) break;
          while (j < chars.length && isRun(chars[j] as string)) j++;
        } else {
          if (
            isRun(have) ||
            !sameUnderIu(want.codePointAt(0) as number, have.codePointAt(0) as number)
          )
            break;
          j++;
        }
      }
      if (k === phrase.length) return offset;
    }
    return undefined;
  };

  it('finds the same first match over seeded texts and self-overlapping phrases', () => {
    const random = seededRandom(70);
    const alphabet = [
      'a',
      'A',
      'b',
      'ſ',
      's',
      'S',
      'ß',
      'ẞ',
      'ı',
      'İ',
      'i',
      '𝄞',
      ' ',
      '  ',
      '\n',
      '　',
    ];
    const pick = () => alphabet[Math.floor(random() * alphabet.length)] as string;
    let matched = 0;
    for (let round = 0; round < 1_500; round++) {
      const text = Array.from({ length: 5 + Math.floor(random() * 60) }, pick).join('');
      const chars = [...text];
      const from = Math.floor(random() * chars.length);
      const slice = chars.slice(from, from + 1 + Math.floor(random() * 8)).join('');
      // A slice of the text, perturbed half the time, so most phrases occur and many nearly do.
      const find = random() < 0.5 ? slice : `${slice}${pick()}`;
      if (!compilePhrase(find)) continue;
      const expected = bruteForce(text, find);
      if (expected !== undefined) matched++;
      expect(firstMatch(text, find), `${JSON.stringify(find)} in ${JSON.stringify(text)}`).toBe(
        expected,
      );
    }
    expect(matched).toBeGreaterThan(500);
  });
});

describe('PhraseMatcher time', () => {
  /** CPU ceiling per call: 1 µs per character. */
  const MAX_CPU_MS_PER_CHAR = 0.001;

  /** The phrase grows with the input, doubling with it to the 500-character limit at 320k. */
  const phraseLength = (n: number) => Math.min(500, Math.floor(n / 640));

  const WORST_CASES: [string, (n: number) => { text: string; find: string }][] = [
    [
      'one letter repeated, then another, against a run of the first',
      (n) => ({ text: 'a'.repeat(n), find: `${'a'.repeat(phraseLength(n) - 1)}b` }),
    ],
    [
      'single letters separated by spaces against those letters separated by blank lines',
      (n) => ({
        text: 'a\n\n'.repeat(Math.ceil(n / 3)),
        find: `${'a '.repeat(Math.floor(phraseLength(n) / 2) - 1)}b`,
      }),
    ],
    [
      'one long line ending in a break',
      (n) => ({
        text: `${'§1 x'.repeat(Math.ceil(n / 4))}\ny`,
        find: `${'§1 x'.repeat(Math.floor(phraseLength(n) / 4) - 1)}§1 y`,
      }),
    ],
    [
      'breaks throughout',
      (n) => ({
        text: '  \r\n'.repeat(Math.ceil(n / 4)),
        find: `${'x '.repeat(Math.floor(phraseLength(n) / 2) - 1)}y`,
      }),
    ],
  ];

  it.each(WORST_CASES)(
    'scans %s in linear time',
    async (_name, build) => {
      await expectLinearDoubling(
        (n) => {
          const { text, find } = build(n);
          return () => firstMatch(text, find);
        },
        MAX_CPU_MS_PER_CHAR,
        (large) => expect(large()).toBeUndefined(),
      );
    },
    0,
  );
});
