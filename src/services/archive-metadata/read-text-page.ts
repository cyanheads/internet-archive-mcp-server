/**
 * @fileoverview Bounded UTF-8 paging with byte checkpoints at WHATWG decoding units.
 * @module services/archive-metadata/read-text-page
 */

/** A restartable byte position, including the high surrogate already delivered to a caller. */
export interface TextCheckpoint {
  byteOffset: number;
  skip: number;
}

/** Decode one UTF-16 page, retaining no prefix and at most one scalar of lookahead. */
export async function readTextPage(
  response: Response,
  charOffset: number,
  maxChars: number,
  start: TextCheckpoint = { byteOffset: 0, skip: 0 },
): Promise<{ bytesRead: number; hasMore: boolean; text: string; checkpoint: TextCheckpoint }> {
  const reader = response.body?.getReader();
  let byteOffset = start.byteOffset;
  let unitStart = byteOffset;
  let remaining = 0;
  let scalar = 0;
  let lower = 0x80;
  let upper = 0xbf;
  let decoded = -start.skip;
  let bytesRead = 0;
  let text = '';
  let checkpoint: TextCheckpoint = start;
  const end = charOffset + maxChars;
  let hasMore = false;
  const asciiDecoder = new TextDecoder();

  const emit = (value: number, from: number, to: number) => {
    // Response.text strips a BOM only at the absolute start of the representation.
    if (from === 0 && value === 0xfeff) return;
    const unitEnd = decoded + (value <= 0xffff ? 1 : 2);
    if (unitEnd > charOffset && decoded < end) {
      const unit = String.fromCodePoint(value);
      text += unit.slice(Math.max(0, charOffset - decoded), end - decoded);
    }
    if (decoded <= end && unitEnd >= end) {
      checkpoint =
        unitEnd === end ? { byteOffset: to, skip: 0 } : { byteOffset: from, skip: end - decoded };
    }
    decoded = unitEnd;
    hasMore = decoded > end;
  };

  if (!reader) return { bytesRead, hasMore, text, checkpoint };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      if (remaining > 0) emit(0xfffd, unitStart, byteOffset);
      return { bytesRead, hasMore, text, checkpoint };
    }
    bytesRead += value.byteLength;
    for (let i = 0; i < value.length && !hasMore; ) {
      const byte = value[i] as number;
      // Most OCR is ASCII. Count its byte-identical UTF-16 run without allocating a string per scalar.
      if (remaining === 0 && byte <= 0x7f) {
        const runStart = i;
        const limit = Math.min(value.length, i + end - decoded + 1);
        while (i < limit && (value[i] as number) <= 0x7f) i++;
        const count = i - runStart;
        const runEnd = decoded + count;
        if (runEnd > charOffset && decoded < end) {
          text += asciiDecoder.decode(
            value.subarray(
              runStart + Math.max(0, charOffset - decoded),
              runStart + Math.min(count, end - decoded),
            ),
          );
        }
        if (decoded <= end && runEnd >= end)
          checkpoint = { byteOffset: byteOffset + end - decoded, skip: 0 };
        byteOffset += count;
        decoded = runEnd;
        hasMore = decoded > end;
        continue;
      }
      if (remaining > 0) {
        if (byte < lower || byte > upper) {
          remaining = 0;
          lower = 0x80;
          upper = 0xbf;
          emit(0xfffd, unitStart, byteOffset);
          continue; // WHATWG reconsumes the offending byte as a new decoding unit.
        }
        lower = 0x80;
        upper = 0xbf;
        scalar = (scalar << 6) | (byte & 0x3f);
        remaining--;
        byteOffset++;
        i++;
        if (remaining === 0) emit(scalar, unitStart, byteOffset);
      } else {
        unitStart = byteOffset++;
        i++;
        if (byte >= 0xc2 && byte <= 0xdf) {
          scalar = byte & 0x1f;
          remaining = 1;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          scalar = byte & 0x0f;
          remaining = 2;
          if (byte === 0xe0) lower = 0xa0;
          if (byte === 0xed) upper = 0x9f;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          scalar = byte & 7;
          remaining = 3;
          if (byte === 0xf0) lower = 0x90;
          if (byte === 0xf4) upper = 0x8f;
        } else emit(0xfffd, unitStart, byteOffset);
      }
    }
    if (hasMore) {
      await reader.cancel();
      return { bytesRead, hasMore, text, checkpoint };
    }
  }
}
