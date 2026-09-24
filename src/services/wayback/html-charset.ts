/**
 * @fileoverview Decodes an archived HTML body with the charset it declares, following
 * the WHATWG order: byte-order mark, then the `Content-Type` charset, then a `<meta>`
 * declaration near the top of the document. A body that declares none is kept as UTF-8
 * when it is valid UTF-8; otherwise it is decoded with the charset Wayback guessed for
 * the capture (`x-archive-guessed-charset`) when `TextDecoder` knows the label, else as
 * windows-1252. Labels resolve through `TextDecoder`, so `iso-8859-1` and its aliases
 * decode as windows-1252; a label it does not know falls through to the next source.
 * @module services/wayback/html-charset
 */

/**
 * Bytes searched for a `<meta>` declaration. Larger than the 1024 bytes of the WHATWG
 * prescan because Wayback's replay injects about a kilobyte of banner markup ahead of
 * the archived page's own `<head>`.
 */
const META_SCAN_BYTES = 16_384;

/** Comments (skipped) and `<meta` tags, up to `>` or the end of the scanned window. */
const COMMENT_OR_META = /<!--[\s\S]*?(?:--!?>|$)|<meta\b[^>]*/gi;

/** A `charset=` label inside a `<meta>` tag — the `charset` attribute or the `content` value. */
const META_CHARSET = /charset\s*=\s*["']?([^\s"'/>;]+)/i;

/** A `charset=` parameter of a `Content-Type` header value. */
const HEADER_CHARSET = /;\s*charset\s*=\s*"?([^\s";]+)/i;

/** A decoder for `label`, or undefined when the label is unknown or names the replacement encoding. */
function decoderFor(label: string | undefined): TextDecoder | undefined {
  if (!label) return;
  try {
    const decoder = new TextDecoder(label);
    return decoder.encoding === 'replacement' ? undefined : decoder;
  } catch {
    return;
  }
}

/** The encoding a byte-order mark at the start of `bytes` names. */
function bomEncoding(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  return;
}

/** The charset label of the first `<meta>` declaration in the document head. */
function metaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, META_SCAN_BYTES));
  for (const [tag] of head.matchAll(COMMENT_OR_META)) {
    if (tag.startsWith('<!--')) continue;
    const label = META_CHARSET.exec(tag)?.[1];
    if (label) return label;
  }
  return;
}

/**
 * The decoder for a meta-declared label. The declaration was found by reading the bytes
 * as ASCII, so a UTF-16 label cannot be right and means UTF-8; `x-user-defined` means
 * windows-1252 (WHATWG "prescan a byte stream").
 */
function metaDecoder(label: string | undefined): TextDecoder | undefined {
  const decoder = decoderFor(label);
  if (decoder?.encoding.startsWith('utf-16')) return new TextDecoder('utf-8');
  if (decoder?.encoding === 'x-user-defined') return new TextDecoder('windows-1252');
  return decoder;
}

/** What the replay response says about a body's charset. */
export interface HtmlBodySource {
  /** The `Content-Type` header value. */
  contentType: string | null;
  /** Wayback's `x-archive-guessed-charset` header value. */
  guessedCharset: string | null;
  /** The body was cut short, so a character split at its end is dropped rather than replaced. */
  truncated: boolean;
}

/**
 * Decode an HTML body to text with the charset its bytes, header, or markup declare. An
 * undeclared body stays UTF-8 when it is valid UTF-8, because Wayback's guess is
 * unreliable (a Latin-1 slashdot.org 1999 capture is guessed `ibm852`) and a wrong
 * single-byte guess would turn valid UTF-8 into mojibake. Only bytes that are not UTF-8
 * use the guess, or windows-1252 when the guess names no charset `TextDecoder` knows.
 */
export function decodeHtml(bytes: Uint8Array, source: HtmlBodySource): string {
  const { contentType, guessedCharset, truncated } = source;
  // On a cut body, `stream` drops a character split at the end instead of replacing it,
  // so the split cannot fail the strict UTF-8 check either.
  const options = { stream: truncated };
  const declared =
    decoderFor(bomEncoding(bytes)) ??
    decoderFor(contentType ? HEADER_CHARSET.exec(contentType)?.[1] : undefined) ??
    metaDecoder(metaCharset(bytes));
  if (declared) return declared.decode(bytes, options);

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, options);
  } catch {
    const fallback = decoderFor(guessedCharset?.trim()) ?? new TextDecoder('windows-1252');
    return fallback.decode(bytes, options);
  }
}
