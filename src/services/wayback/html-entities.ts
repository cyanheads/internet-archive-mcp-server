/**
 * @fileoverview Named character references decoded in archived page text: HTML 4.01's
 * 252 entities plus `apos` and the WHATWG upper-case aliases `AMP` `LT` `GT` `QUOT`
 * `COPY` `REG`. Code points follow the WHATWG table, which differs from HTML 4.01 only
 * for `lang`/`rang` (U+27E8/U+27E9, where HTML 4.01 had U+2329/U+232A).
 * @module services/wayback/html-entities
 */

/** Whitespace-separated words of a table literal. */
const words = (table: string): string[] => table.trim().split(/\s+/);

/** HTML 4.01 Latin-1 entities, one per code point from U+00A0 (`nbsp`) to U+00FF (`yuml`). */
const LATIN_1 = words(`
  nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr
  deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest
  Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml
  ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig
  agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml
  eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml
`);

/** Greek letters, one per code point from U+0391 (`Alpha`) to U+03C9 (`omega`); `-` has no name. */
const GREEK = words(`
  Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi
  Rho - Sigma Tau Upsilon Phi Chi Psi Omega - - - - - - -
  alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi
  rho sigmaf sigma tau upsilon phi chi psi omega
`);

/** The remaining HTML 4.01 symbol and special entities and the WHATWG additions, as `name:hex`. */
const OTHERS = words(`
  quot:22 amp:26 apos:27 lt:3c gt:3e QUOT:22 AMP:26 LT:3c GT:3e COPY:a9 REG:ae
  OElig:152 oelig:153 Scaron:160 scaron:161 Yuml:178 fnof:192 circ:2c6 tilde:2dc
  thetasym:3d1 upsih:3d2 piv:3d6
  ensp:2002 emsp:2003 thinsp:2009 zwnj:200c zwj:200d lrm:200e rlm:200f ndash:2013 mdash:2014
  lsquo:2018 rsquo:2019 sbquo:201a ldquo:201c rdquo:201d bdquo:201e dagger:2020 Dagger:2021
  bull:2022 hellip:2026 permil:2030 prime:2032 Prime:2033 lsaquo:2039 rsaquo:203a oline:203e
  frasl:2044 euro:20ac image:2111 weierp:2118 real:211c trade:2122 alefsym:2135
  larr:2190 uarr:2191 rarr:2192 darr:2193 harr:2194 crarr:21b5
  lArr:21d0 uArr:21d1 rArr:21d2 dArr:21d3 hArr:21d4
  forall:2200 part:2202 exist:2203 empty:2205 nabla:2207 isin:2208 notin:2209 ni:220b
  prod:220f sum:2211 minus:2212 lowast:2217 radic:221a prop:221d infin:221e ang:2220
  and:2227 or:2228 cap:2229 cup:222a int:222b there4:2234 sim:223c cong:2245 asymp:2248
  ne:2260 equiv:2261 le:2264 ge:2265 sub:2282 sup:2283 nsub:2284 sube:2286 supe:2287
  oplus:2295 otimes:2297 perp:22a5 sdot:22c5 lceil:2308 rceil:2309 lfloor:230a rfloor:230b
  lang:27e8 rang:27e9 loz:25ca spades:2660 clubs:2663 hearts:2665 diams:2666
`);

/**
 * Case-sensitive name → replacement text. A `Map`, not an object literal, so a name
 * like `constructor` or `__proto__` never resolves through the prototype chain.
 */
export const NAMED_CHARACTER_REFERENCES: ReadonlyMap<string, string> = new Map([
  ...LATIN_1.map((name, i) => [name, String.fromCodePoint(0xa0 + i)] as const),
  ...GREEK.flatMap((name, i) =>
    name === '-' ? [] : [[name, String.fromCodePoint(0x391 + i)] as const],
  ),
  ...OTHERS.map((entry) => {
    const [name = '', hex = ''] = entry.split(':');
    return [name, String.fromCodePoint(Number.parseInt(hex, 16))] as const;
  }),
]);
