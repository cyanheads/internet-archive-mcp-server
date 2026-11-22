/**
 * @fileoverview Bounded UTF-8 paging with byte checkpoints at WHATWG decoding units: a page read at
 * an offset (`readTextPage`), or at the first match of a phrase (`findTextPage`).
 * @module services/archive-metadata/read-text-page
 */

import { type Phrase, PhraseMatcher } from './phrase-matcher.js';

/** A restartable byte position, including the high surrogate already delivered to a caller. */
export interface TextCheckpoint {
  byteOffset: number;
  skip: number;
}

/** Where a decoded byte stream goes: ASCII runs whole, every other decoding unit as one scalar. */
interface ScalarSink {
  /**
   * Take ASCII bytes from `value[from]` on, the first at byte `byteOffset`, and return how many:
   * at least one, and the whole run unless the sink became done.
   */
  ascii(value: Uint8Array, from: number, byteOffset: number): number;
  /** True once the sink takes no more input. */
  readonly done: boolean;
  /** One scalar decoded from bytes [from, to): U+FFFD for a malformed decoding unit. */
  scalar(value: number, from: number, to: number): void;
}

/** WHATWG UTF-8 decoding with byte positions, carried across chunks. */
class Utf8Decoder {
  /** Byte offset of the next byte to decode. */
  byteOffset: number;
  private lower = 0x80;
  private remaining = 0;
  private scalar = 0;
  private unitStart: number;
  private upper = 0xbf;

  constructor(byteOffset: number) {
    this.byteOffset = byteOffset;
    this.unitStart = byteOffset;
  }

  /** Byte offset where the next scalar begins: before a decoding unit still waiting for bytes. */
  get boundary(): number {
    return this.remaining > 0 ? this.unitStart : this.byteOffset;
  }

  /** Decode `value` into `sink` until it is used up or the sink is done; returns whether it is done. */
  decode(value: Uint8Array, sink: ScalarSink): boolean {
    for (let i = 0; i < value.length && !sink.done; ) {
      const byte = value[i] as number;
      // Most OCR is ASCII, which the sink takes a run at a time.
      if (this.remaining === 0 && byte <= 0x7f) {
        const count = sink.ascii(value, i, this.byteOffset);
        i += count;
        this.byteOffset += count;
        continue;
      }
      if (this.remaining > 0) {
        if (byte < this.lower || byte > this.upper) {
          this.reset();
          this.emit(sink, 0xfffd);
          continue; // WHATWG reconsumes the offending byte as a new decoding unit.
        }
        this.lower = 0x80;
        this.upper = 0xbf;
        this.scalar = (this.scalar << 6) | (byte & 0x3f);
        this.remaining--;
        this.byteOffset++;
        i++;
        if (this.remaining === 0) this.emit(sink, this.scalar);
      } else {
        this.unitStart = this.byteOffset++;
        i++;
        if (byte >= 0xc2 && byte <= 0xdf) {
          this.scalar = byte & 0x1f;
          this.remaining = 1;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          this.scalar = byte & 0x0f;
          this.remaining = 2;
          if (byte === 0xe0) this.lower = 0xa0;
          if (byte === 0xed) this.upper = 0x9f;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          this.scalar = byte & 7;
          this.remaining = 3;
          if (byte === 0xf0) this.lower = 0x90;
          if (byte === 0xf4) this.upper = 0x8f;
        } else this.emit(sink, 0xfffd);
      }
    }
    return sink.done;
  }

  /** The end of the stream: a decoding unit still waiting for bytes decodes as one U+FFFD. */
  finish(sink: ScalarSink): void {
    if (this.remaining === 0) return;
    this.reset();
    this.emit(sink, 0xfffd);
  }

  /** The scalar decoded from `unitStart` up to the current byte. */
  private emit(sink: ScalarSink, value: number): void {
    // Response.text strips a BOM only at the absolute start of the representation.
    if (this.unitStart === 0 && value === 0xfeff) return;
    sink.scalar(value, this.unitStart, this.byteOffset);
  }

  private reset(): void {
    this.remaining = 0;
    this.lower = 0x80;
    this.upper = 0xbf;
  }
}

/**
 * The page of `maxChars` UTF-16 units at `charOffset` in a decoded stream, with one unit of
 * lookahead past it (`hasMore`) and the checkpoint where the next page starts. It holds the page's
 * text and nothing before it.
 */
class PageWindow implements ScalarSink {
  checkpoint: TextCheckpoint;
  hasMore: boolean;
  text: string;
  private readonly asciiDecoder = new TextDecoder();
  private readonly charOffset: number;
  private decoded: number;
  private readonly end: number;

  /**
   * `decoded` is the UTF-16 offset of the next unit the stream delivers. A page that starts
   * mid-stream comes with its text so far, or with all of it and its checkpoint when `decoded` is
   * already past its end.
   */
  constructor(
    charOffset: number,
    maxChars: number,
    decoded: number,
    checkpoint: TextCheckpoint,
    text = '',
  ) {
    this.charOffset = charOffset;
    this.end = charOffset + maxChars;
    this.decoded = decoded;
    this.checkpoint = checkpoint;
    this.text = text;
    this.hasMore = decoded > this.end;
  }

  get done(): boolean {
    return this.hasMore;
  }

  ascii(value: Uint8Array, from: number, byteOffset: number): number {
    const { charOffset, decoded, end } = this;
    // Count the byte-identical UTF-16 run without allocating a string per scalar.
    const limit = Math.min(value.length, from + end - decoded + 1);
    let i = from;
    while (i < limit && (value[i] as number) <= 0x7f) i++;
    const count = i - from;
    const runEnd = decoded + count;
    if (runEnd > charOffset && decoded < end) {
      this.text += this.asciiDecoder.decode(
        value.subarray(
          from + Math.max(0, charOffset - decoded),
          from + Math.min(count, end - decoded),
        ),
      );
    }
    if (decoded <= end && runEnd >= end) {
      this.checkpoint = { byteOffset: byteOffset + end - decoded, skip: 0 };
    }
    this.decoded = runEnd;
    this.hasMore = runEnd > end;
    return count;
  }

  scalar(value: number, from: number, to: number): void {
    const { charOffset, decoded, end } = this;
    const unitEnd = decoded + (value <= 0xffff ? 1 : 2);
    if (unitEnd > charOffset && decoded < end) {
      const unit = String.fromCodePoint(value);
      this.text += unit.slice(Math.max(0, charOffset - decoded), end - decoded);
    }
    if (decoded <= end && unitEnd >= end) {
      this.checkpoint =
        unitEnd === end ? { byteOffset: to, skip: 0 } : { byteOffset: from, skip: end - decoded };
    }
    this.decoded = unitEnd;
    this.hasMore = unitEnd > end;
  }
}

/** A string of UTF-16 units as stored, lone surrogates included. */
const unitString = (units: Uint16Array): string => {
  let text = '';
  for (let k = 0; k < units.length; k += 8_192) {
    text += String.fromCharCode(...units.subarray(k, k + 8_192));
  }
  return text;
};

/**
 * Searches decoded text for a phrase's first match at or after `searchFrom`, then serves the page
 * there. While a match can still begin, it holds the text from the earliest place one can, up to
 * `maxChars` + 1 units plus twice the phrase's length. The slack keeps the page of an overlapping
 * later candidate held, unless whitespace between the two outruns the phrase; a match whose page
 * was let go is reported `unheld`, never served short. Once a match completes, the page continues
 * from the stream.
 */
class PhraseSearch implements ScalarSink {
  /** The page at the match, once one completed with its start held. */
  page: PageWindow | undefined;
  /** True when the first match completed after the text at its start was let go. */
  unheld = false;
  private decoded: number;
  private head = 0;
  private readonly held: Uint16Array;
  private heldEnd = -1;
  /** UTF-16 offset of the first held unit: the earliest place a match can begin, or -1 for none. */
  private heldStart = -1;
  private readonly matcher: PhraseMatcher;
  private readonly maxChars: number;
  private readonly searchFrom: number;
  private size = 0;

  constructor(phrase: Phrase, searchFrom: number, maxChars: number, decoded: number) {
    this.matcher = new PhraseMatcher(phrase);
    this.searchFrom = searchFrom;
    this.maxChars = maxChars;
    this.decoded = decoded;
    this.held = new Uint16Array(maxChars + 1 + 2 * phrase.length);
  }

  get done(): boolean {
    return this.unheld || (this.page?.done ?? false);
  }

  /** Where the match begins, once one completed. */
  get matchOffset(): number {
    return this.matcher.offsetOf(0);
  }

  ascii(value: Uint8Array, from: number, byteOffset: number): number {
    if (this.page) return this.page.ascii(value, from, byteOffset);
    let i = from;
    if (this.decoded < this.searchFrom) {
      const limit = Math.min(value.length, from + this.searchFrom - this.decoded);
      while (i < limit && (value[i] as number) <= 0x7f) i++;
      this.decoded += i - from;
      return i - from;
    }
    while (i < value.length && (value[i] as number) <= 0x7f) {
      const at = byteOffset + i - from;
      this.feed(value[i] as number, at, at + 1);
      i++;
      if (this.page || this.unheld) break;
    }
    return i - from;
  }

  /**
   * The earliest offset where a match can still begin, with the checkpoint to decode it from:
   * token 0 of the live or completed match; else, once the search start is reached, the next unit
   * to decode (at byte `boundary`); before that, the search start, whose checkpoint is known only
   * when it is the read's own `start`.
   */
  resume(boundary: number, start: TextCheckpoint): { checkpoint?: TextCheckpoint; offset: number } {
    if (this.matcher.length > 0) {
      return {
        offset: this.matcher.offsetOf(0),
        checkpoint: { byteOffset: this.matcher.byteOf(0), skip: 0 },
      };
    }
    if (this.decoded >= this.searchFrom) {
      return { offset: this.decoded, checkpoint: { byteOffset: boundary, skip: 0 } };
    }
    return this.searchFrom === 0 ? { offset: 0, checkpoint: start } : { offset: this.searchFrom };
  }

  scalar(value: number, from: number, to: number): void {
    if (this.page) this.page.scalar(value, from, to);
    else this.feed(value, from, to);
  }

  /** The checkpoint at `position`, inside the completed match and inside the held text. */
  private checkpointAt(position: number): TextCheckpoint {
    const { matcher } = this;
    let i = matcher.length - 1;
    while (matcher.offsetOf(i) > position) i--;
    const tokenStart = matcher.offsetOf(i);
    if (!matcher.isRun(i)) return { byteOffset: matcher.byteOf(i), skip: position - tokenStart };
    // Every White_Space character is BMP, and one decoded from the stream arrived as its own encoding.
    let byteOffset = matcher.byteOf(i);
    for (let at = tokenStart; at < position; at++) {
      const unit = this.held[(this.head + at - this.heldStart) % this.held.length] as number;
      byteOffset += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    return { byteOffset, skip: 0 };
  }

  /** Feed one scalar at the next offset; it spans bytes [from, to). */
  private feed(cp: number, from: number, to: number): void {
    const offset = this.decoded;
    const units = cp > 0xffff ? 2 : 1;
    this.decoded += units;
    if (offset < this.searchFrom) return;
    const complete = this.matcher.push(cp, offset, from);
    const start = this.matcher.length > 0 ? this.matcher.offsetOf(0) : -1;
    if (start !== this.heldStart) this.letGo(start);
    // Hold this scalar while the held text runs unbroken up to it and has room.
    if (start >= 0 && this.heldEnd === offset) {
      if (units === 1) this.hold(cp);
      else {
        this.hold(0xd800 + ((cp - 0x10000) >> 10));
        this.hold(0xdc00 + ((cp - 0x10000) & 0x3ff));
      }
    }
    if (complete) this.serve(to);
  }

  private hold(unit: number): void {
    if (this.size === this.held.length) return;
    this.held[(this.head + this.size) % this.held.length] = unit;
    this.size++;
    this.heldEnd++;
  }

  /** The first `count` held units. */
  private heldText(count: number): string {
    const first = Math.min(count, this.held.length - this.head);
    return (
      unitString(this.held.subarray(this.head, this.head + first)) +
      unitString(this.held.subarray(0, count - first))
    );
  }

  /** Start the held text at `start`, the new earliest place a match can begin (-1: none). */
  private letGo(start: number): void {
    if (start < 0 || this.heldStart < 0 || start >= this.heldEnd) {
      this.head = 0;
      this.size = 0;
      this.heldEnd = start;
    } else {
      const drop = start - this.heldStart;
      this.head = (this.head + drop) % this.held.length;
      this.size -= drop;
    }
    this.heldStart = start;
  }

  /** A match completed with the scalar ending at the current offset and at byte `to`. */
  private serve(to: number): void {
    const now = this.decoded;
    const start = this.heldStart;
    const end = start + this.maxChars;
    if (now > end && this.size >= this.maxChars) {
      this.page = new PageWindow(
        start,
        this.maxChars,
        now,
        this.checkpointAt(end),
        this.heldText(this.maxChars),
      );
    } else if (this.heldEnd === now) {
      this.page = new PageWindow(
        start,
        this.maxChars,
        now,
        { byteOffset: to, skip: 0 },
        this.heldText(this.size),
      );
    } else this.unheld = true;
  }
}

/**
 * How a body read ended: the sink took all it needed, the body ended, or `stopAt` came first.
 */
type ReadEnd = 'sink' | 'body' | 'time';

/**
 * Read `response`'s body into `sink` through `decoder` until the body ends or the sink is done,
 * then cancel the rest. With `stopAt` (epoch ms) the read also stops then: checked after each
 * chunk, and a read still waiting for a chunk at that time is cancelled.
 */
async function pump(
  response: Response,
  decoder: Utf8Decoder,
  sink: ScalarSink,
  stopAt = Number.POSITIVE_INFINITY,
): Promise<{ bytesRead: number; end: ReadEnd }> {
  const reader = response.body?.getReader();
  let bytesRead = 0;
  if (!reader) return { bytesRead, end: 'body' };
  let timedOut = false;
  let cancelling: Promise<void> | undefined;
  const timer = Number.isFinite(stopAt)
    ? setTimeout(
        () => {
          timedOut = true;
          cancelling = reader.cancel();
        },
        Math.max(0, stopAt - Date.now()),
      )
    : undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) return { bytesRead, end: 'time' };
      if (done) {
        decoder.finish(sink);
        return { bytesRead, end: 'body' };
      }
      bytesRead += value.byteLength;
      const end: ReadEnd | undefined = decoder.decode(value, sink)
        ? 'sink'
        : Date.now() >= stopAt
          ? 'time'
          : undefined;
      if (end) {
        clearTimeout(timer);
        await reader.cancel();
        return { bytesRead, end };
      }
    }
  } finally {
    clearTimeout(timer);
    await cancelling;
  }
}

/** Decode one UTF-16 page, retaining no prefix and at most one scalar of lookahead. */
export async function readTextPage(
  response: Response,
  charOffset: number,
  maxChars: number,
  start: TextCheckpoint = { byteOffset: 0, skip: 0 },
): Promise<{ bytesRead: number; hasMore: boolean; text: string; checkpoint: TextCheckpoint }> {
  const page = new PageWindow(charOffset, maxChars, -start.skip, start);
  const { bytesRead } = await pump(response, new Utf8Decoder(start.byteOffset), page);
  return { bytesRead, hasMore: page.hasMore, text: page.text, checkpoint: page.checkpoint };
}

/** What a phrase search found. Offsets count UTF-16 units from the read's start, as `readTextPage`'s do. */
export type PhraseSearchResult =
  | {
      bytesRead: number;
      checkpoint: TextCheckpoint;
      hasMore: boolean;
      kind: 'hit';
      /** Where the first match begins, and so the page. */
      matchOffset: number;
      text: string;
    }
  | { bytesRead: number; kind: 'miss' }
  | {
      bytesRead: number;
      /**
       * `time`: the read stopped at `stopAt`. `unheld`: the first match begins at `resumeOffset`,
       * but the text there was let go to keep the held text within its bound.
       */
      cause: 'time' | 'unheld';
      kind: 'incomplete';
      /** Where to decode from to resume at `resumeOffset`; absent while the read had not reached the search start. */
      resumeCheckpoint?: TextCheckpoint;
      /** The earliest offset where a match can still begin: none begins between the search start and it. */
      resumeOffset: number;
    };

/**
 * Search the text from `searchFrom` on for `phrase`'s first match and read the page of `maxChars`
 * units that starts there, as `readTextPage` reads one at an offset: a hit cancels the rest of the
 * body once the unit after the page has arrived. Holds at most `maxChars` + 1 units of text plus
 * twice the phrase's length, whatever the file's size. Stops at `stopAt` (epoch ms) as `incomplete`.
 */
export async function findTextPage(
  response: Response,
  phrase: Phrase,
  searchFrom: number,
  maxChars: number,
  start: TextCheckpoint = { byteOffset: 0, skip: 0 },
  stopAt = Number.POSITIVE_INFINITY,
): Promise<PhraseSearchResult> {
  const decoder = new Utf8Decoder(start.byteOffset);
  const search = new PhraseSearch(phrase, searchFrom, maxChars, -start.skip);
  const { bytesRead, end } = await pump(response, decoder, search, stopAt);
  const { page } = search;
  if (page && (page.done || end === 'body')) {
    return {
      kind: 'hit',
      bytesRead,
      matchOffset: search.matchOffset,
      text: page.text,
      hasMore: page.hasMore,
      checkpoint: page.checkpoint,
    };
  }
  if (!search.unheld && end !== 'time') return { kind: 'miss', bytesRead };
  const resume = search.resume(decoder.boundary, start);
  return {
    kind: 'incomplete',
    bytesRead,
    cause: search.unheld ? 'unheld' : 'time',
    resumeOffset: resume.offset,
    ...(resume.checkpoint && { resumeCheckpoint: resume.checkpoint }),
  };
}
