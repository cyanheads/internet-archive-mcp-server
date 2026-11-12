/**
 * @fileoverview Tests for the language spelling table behind the ia_search_items `language`
 * filter.
 * @module tests/services/language-spellings.test
 */

import { describe, expect, it } from 'vitest';
import { languageSpellings } from '@/services/archive-search/language-spellings.js';

/** The spellings of a value's language, compared without order or case. */
const spellingSet = (value: string) =>
  new Set(languageSpellings(value).map((spelling) => spelling.toLowerCase()));

/** Every string of `length` lowercase ASCII letters. */
const allCodes = (length: number): string[] =>
  length === 0
    ? ['']
    : allCodes(length - 1).flatMap((prefix) =>
        Array.from({ length: 26 }, (_, i) => prefix + String.fromCharCode(97 + i)),
      );

/** The 31 codes the MARC Code List for Languages marks obsolete. */
const MARC_OBSOLETE = [
  'ajm',
  'scr',
  'esk',
  'esp',
  'eth',
  'far',
  'fri',
  'gag',
  'gua',
  'int',
  'iri',
  'cam',
  'kus',
  'mla',
  'max',
  'mol',
  'lan',
  'gal',
  'lap',
  'sao',
  'gae',
  'scc',
  'sho',
  'snh',
  'sso',
  'swz',
  'tag',
  'taj',
  'tar',
  'tru',
  'tsw',
];

describe('languageSpellings', () => {
  it.each([
    'eng|en|English',
    'fre|fra|fr|French',
    'hrv|hr|Croatian|scr',
    'pap|Papiamento',
    'gre|ell|el|Greek|Modern Greek',
    'chi|zho|zh|Chinese',
    'spa|es|Spanish|Castilian',
  ])('resolves each of %s, in any case, to all of them', (row) => {
    const expected = new Set(row.toLowerCase().split('|'));
    for (const value of row.split('|')) {
      expect(spellingSet(value)).toEqual(expected);
      expect(spellingSet(value.toUpperCase())).toEqual(expected);
      expect(spellingSet(value.toLowerCase())).toEqual(expected);
    }
  });

  it('puts the value first, as sent', () => {
    expect(languageSpellings('ENGLISH')).toEqual(['ENGLISH', 'eng', 'en']);
    expect(languageSpellings('fr')).toEqual(['fr', 'fre', 'fra', 'French']);
  });

  it.each([
    ['no', 'Norwegian'],
    ['it', 'Italian'],
    ['is', 'Icelandic'],
    ['or', 'Oriya'],
    ['to', 'ton'],
  ])('keeps the English-word code %s out unless it is the value sent', (code, other) => {
    expect(spellingSet(other)).not.toContain(code);
    expect(languageSpellings(code)[0]).toBe(code);
    expect(spellingSet(code)).toContain(other.toLowerCase());
  });

  it.each([
    ['am', 'Amharic'],
    ['an', 'Aragonese'],
    ['as', 'Assamese'],
    ['be', 'Belarusian'],
    ['he', 'Hebrew'],
    ['hi', 'Hindi'],
    ['my', 'Burmese'],
    ['so', 'Somali'],
  ])('leaves the English-word code %s out of the spellings of %s', (code, name) => {
    expect(spellingSet(name)).not.toContain(code);
    expect(spellingSet(code)).toContain(name.toLowerCase());
  });

  it.each([
    ['ga', ['ga']],
    ['Tonga', ['Tonga']],
    ['tog', ['tog']],
    ['gaa', ['gaa']],
  ])('leaves %s, shared by two languages, out of both', (value, expected) => {
    expect(languageSpellings(value)).toEqual(expected);
  });

  it('keeps the shared spellings out of the rows that would carry them', () => {
    expect(spellingSet('gle')).toEqual(new Set(['gle', 'irish', 'iri']));
    expect(spellingSet('ton')).toEqual(new Set(['ton']));
  });

  it.each([
    'Norwegian (Bokmål)',
    'chi_tra',
    'Multiple',
    '__proto__',
    'constructor',
    'hasOwnProperty',
    'toString',
  ])('matches %s, outside the table, alone', (value) => {
    expect(languageSpellings(value)).toEqual([value]);
  });

  it.each([
    ['scr', 'hrv'],
    ['scc', 'srp'],
    ['mol', 'rum'],
    ['iri', 'gle'],
    ['gae', 'gla'],
    ['lan', 'oci'],
    ['kus', 'kos'],
    ['tru', 'chk'],
    ['esp', 'epo'],
  ])('files the discontinued MARC code %s under %s', (obsolete, current) => {
    expect(spellingSet(obsolete)).toEqual(spellingSet(current));
  });

  it.each([
    ['ajm', 'Aljamía'],
    ['esk', 'Eskimo languages'],
  ])('gives %s, which no current code took over, its own row', (code, name) => {
    expect(languageSpellings(code)).toEqual([code, name]);
  });

  it('resolves every discontinued MARC code to more than itself', () => {
    for (const code of MARC_OBSOLETE) expect(languageSpellings(code).length).toBeGreaterThan(1);
  });

  it('puts every spelling in exactly one language, reached from its three-letter code', () => {
    const languages = new Map<string, Set<string>>();
    for (const code of allCodes(3)) {
      const spellings = spellingSet(code);
      if (spellings.size > 1) languages.set([...spellings].sort().join('|'), spellings);
    }
    for (const spellings of languages.values()) {
      for (const spelling of spellings) expect(spellingSet(spelling)).toEqual(spellings);
    }
    /**
     * 486 ISO 639-2 rows and the 2 MARC-only codes, less the 7 rows left with one spelling once
     * a shared or repeated one is dropped, and `ton`, whose other spelling is the English word "to".
     */
    expect(languages.size).toBe(480);
  });

  it.each(['fon', 'gaa', 'luo', 'tiv', 'tog', 'vai', 'yao'])(
    'sends %s, whose name is its code or shared, alone',
    (code) => {
      expect(languageSpellings(code)).toEqual([code]);
    },
  );

  it('resolves 182 ISO 639-1 codes, all but the shared "ga"', () => {
    expect(allCodes(2).filter((code) => languageSpellings(code).length > 1)).toHaveLength(182);
  });
});
