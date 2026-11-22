/**
 * @fileoverview Archive Metadata service wrapping the Internet Archive Metadata and download APIs.
 * @module services/archive-metadata/archive-metadata-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  forbidden,
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getUserAgent } from '@/config/server-config.js';
import type { CallDeadline } from '../call-deadline.js';
import { descriptionToText } from '../html-text.js';
import { stringOrList } from '../string-or-list.js';
import {
  bodyReadError,
  isHtmlPage,
  isRetriedFailure,
  rateLimitError,
  statusOf,
  transportError,
  transportFailure,
} from '../upstream-errors.js';
import { compilePhrase } from './phrase-matcher.js';
import { findTextPage, readTextPage, type TextCheckpoint } from './read-text-page.js';
import type { ArchiveFile, ArchiveItem, ArchiveItemMetadata, TextContent } from './types.js';

/** Cursor lifetime in seconds; records contain identity and decoder positions, never text. */
const CURSOR_TTL = 3_600;
const TextCursorSchema = z.object({
  version: z.literal(1),
  identifier: z.string(),
  file: z.string(),
  md5: z.string().optional(),
  size: z.string().optional(),
  etag: z.string(),
  totalBytes: z.number().int().nonnegative(),
  nextCharOffset: z.number().int().nonnegative(),
  checkpoint: z.object({
    byteOffset: z.number().int().nonnegative(),
    skip: z.number().int().min(0).max(1),
  }),
  expiresAt: z.number(),
});
type TextCursor = z.infer<typeof TextCursorSchema>;

const storageUnavailable = (err: unknown): boolean =>
  err instanceof McpError &&
  (err.code === JsonRpcErrorCode.ServiceUnavailable || err.code === JsonRpcErrorCode.Timeout);

const continuationError = (
  reason: 'invalid_continuation' | 'range_unavailable',
  charOffset: number,
) =>
  new McpError(
    JsonRpcErrorCode.ValidationError,
    reason === 'invalid_continuation'
      ? 'The continuation is expired, unavailable, or no longer matches this file.'
      : 'The text download did not honor the conditional identity byte range.',
    {
      reason,
      retryable: false,
      char_offset: charOffset,
      recovery: {
        hint: `Omit continuation and retry with char_offset ${charOffset}; restart from char_offset 0 if the file changed.`,
      },
    },
  );

/** A cursor's fields besides its version and expiry. */
type CursorFields = Omit<TextCursor, 'version' | 'expiresAt'>;

/** A download a cursor can resume: its strong validator and its length in bytes. */
interface Identity {
  etag: string;
  totalBytes: number;
}

/**
 * Store `fields` as a tenant-scoped cursor for an hour and return its token, or nothing when cursor
 * storage is unreachable or full; any other failure, a cancellation included, propagates.
 */
async function saveCursor(ctx: Context, fields: CursorFields): Promise<string | undefined> {
  const token = crypto.randomUUID();
  const record: TextCursor = { version: 1, ...fields, expiresAt: Date.now() + CURSOR_TTL * 1_000 };
  try {
    await ctx.state.set(`ia-text/${token}`, record, { ttl: CURSOR_TTL });
    return token;
  } catch (err) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (err instanceof Error && err.name === 'AbortError') throw err;
    /**
     * The in-memory provider reports quota exhaustion as InternalError. This seam writes
     * only a generated JSON cursor; schema/programmer failures still propagate.
     */
    if (
      !storageUnavailable(err) &&
      !(err instanceof McpError && err.code === JsonRpcErrorCode.InternalError)
    )
      throw err;
    return;
  }
}

/**
 * How long before the download's own timeout a `find` search stops: 1 s, or a tenth of a shorter
 * timeout, so the search ends with its resume offset rather than as a timeout the retry ladder
 * answers by reading the file again from its first byte.
 */
const FIND_STOP_MARGIN_MS = 1_000;

/** Why a read stores no cursor where one would resume it: the download's identity, or the store. */
const NO_CURSOR_BECAUSE = {
  identity: 'the download lacks a stable identity validator or byte length',
  storage: 'cursor storage could not be reached',
} as const;
type NoCursor = keyof typeof NO_CURSOR_BECAUSE;

/**
 * `find_incomplete`: the search from `searchStart` stopped with no match before `resumeOffset`,
 * the earliest offset where one can still begin — on `unheld`, where the first match does begin,
 * its text let go to keep the call's held text bounded. The hint names the one call that resumes
 * there: the stored cursor's continuation, else `char_offset`, which reads the file from its first
 * byte, so after a time stop it says so and why no cursor was stored.
 */
function findIncomplete(
  file: string,
  searchStart: number,
  { cause, resumeOffset }: { cause: 'time' | 'unheld'; resumeOffset: number },
  resume: { token: string } | { noCursor: NoCursor },
): McpError {
  const cutOff = `The search of "${file}" stopped before the download's request timeout or the call deadline could cut it off`;
  const message =
    cause === 'unheld'
      ? `The first match of find in "${file}" begins at char_offset ${resumeOffset}, but this call could not return the page there: a whitespace run longer than the text one call holds came before the match.`
      : resumeOffset > searchStart
        ? `${cutOff}. No match begins from char_offset ${searchStart} up to char_offset ${resumeOffset}, where the search resumes.`
        : `${cutOff}, before ruling out a match at char_offset ${searchStart}.`;
  const byOffset = `Call again with the same find and char_offset ${resumeOffset}.`;
  return timeout(message, {
    reason: 'find_incomplete',
    char_offset: resumeOffset,
    ...('token' in resume && { next_continuation: resume.token }),
    recovery: {
      hint:
        'token' in resume
          ? `Call again with the same find and continuation ${resume.token}.`
          : cause === 'unheld'
            ? byOffset
            : `${byOffset} That call reads the file from its first byte, so it searches past char_offset ${resumeOffset} only if the download runs faster than this one did; no continuation is available because ${NO_CURSOR_BECAUSE[resume.noCursor]}.`,
    },
  });
}

/**
 * A `find` search that stopped without getting past `searchStart`, where any call it named would
 * repeat this read: `archive_unavailable`, as a read without `find` fails when its download
 * cannot reach `char_offset` in time, with no offset or continuation to resume from.
 */
function searchStalled(file: string, searchStart: number, ctx: Context): McpError {
  return serviceUnavailable(
    `The download of "${file}" was too slow to search past char_offset ${searchStart} before its request timeout or the call deadline would have cut it off.`,
    unavailable(ctx),
  );
}

const METADATA_BASE = 'https://archive.org/metadata';
const DOWNLOAD_BASE = 'https://archive.org/download';

/** Readable text formats, lowercased, in the order the default pick prefers them. */
const TEXT_FORMATS_PRIORITY = ['djvutxt', 'text', 'plain text'];

/** Which file `getTextContent` reads, and from where. */
export interface TextSelection {
  /** A `next_continuation` from an earlier page; its cursor names the file. */
  continuation?: string | undefined;
  /** A file name exactly as the manifest lists it; omitted, the default pick. */
  file?: string | undefined;
  /**
   * A phrase to start the page at: its first match at or after the read's start (`charOffset`,
   * or the continuation's position). Holding only White_Space, it reads as omitted.
   */
  find?: string | undefined;
}

/** An item's readable text files, when the default pick chose among more than one. */
export interface TextFileSummary {
  /** Readable text files in the manifest. */
  count: number;
  /** Distinct `format` values of those files, in manifest order; each lists some with ia_get_item. */
  formats: string[];
  /** Readable files that list no format, so no `format` filter finds them. */
  unformatted: number;
}

/** A page of text, with `textFiles` when no file was named and the item has several. */
export type TextPage = TextContent & { textFiles?: TextFileSummary };

/**
 * An upstream request: how error messages name it, and what a caller can check when it
 * refuses the request with a 4xx that no retry fixes.
 */
interface Upstream {
  name: string;
  refusalCheck: string;
}

const METADATA_API: Upstream = {
  name: 'The Internet Archive Metadata API',
  refusalCheck: 'verify the identifier with ia_search_items',
};

/** The download of one text file from an item. */
const textDownload = (file: string): Upstream => ({
  name: `The download of "${file}"`,
  refusalCheck: "list the item's files with ia_get_item to find another text file",
});

export class ArchiveMetadataService {
  private readonly headers: Record<string, string>;

  constructor(config: AppConfig, _storage: StorageService) {
    this.headers = { 'User-Agent': getUserAgent(config.mcpServerVersion) };
  }

  /**
   * Retrieve full metadata and the complete file manifest for an Archive item —
   * `ia_get_text` scans every file, so paging stays in the `ia_get_item` handler.
   * Each metadata field is read through `stringOrList`: a string or a list of strings is kept,
   * any other value is left out. Each description value is then converted from the HTML the
   * Archive stores to plain-text lines (`descriptionToText`); a value left with no text is
   * dropped, and a description left with none is omitted. Every other kept value is relayed as
   * received. Each manifest entry is read through `manifestFile`: an entry with no file name is
   * left out, and each other field is kept only as a non-empty string; a `files` value that is
   * not a list reads as no files. Throws `item_not_found` (with the caller's recovery hint)
   * when the API returns `{}`, the item is dark, or the body holds neither metadata nor
   * a file list — the `error` or `result` the API answers for an identifier with a `/`
   * in it. Any other failure is `archive_unavailable` (see `retry` and `statusError`),
   * the call's `deadline` running out included.
   */
  getItem(identifier: string, ctx: Context, deadline: CallDeadline): Promise<ArchiveItem> {
    return this.retry(METADATA_API, ctx, deadline, async (signal) => {
      const response = await fetchWithTimeout(
        `${METADATA_BASE}/${encodeURIComponent(identifier)}`,
        deadline.nextTimeoutMs(),
        ctx,
        { headers: this.headers, signal },
      ).catch((err: unknown) => {
        throw statusError(err, METADATA_API, ctx);
      });
      const text = await response.text().catch((err: unknown) => {
        throw bodyReadError(err, METADATA_API.name);
      });
      const raw = readItemBody(text, ctx);

      // Dark/restricted items return HTTP 200 with routing fields but no metadata or files.
      // is_dark: true means the item has been removed or restricted — treat as not found.
      if (raw.is_dark === true) {
        throw notFound(`Item "${identifier}" is dark (restricted) in the Internet Archive.`, {
          reason: 'item_not_found',
          identifier,
          ...ctx.recoveryFor('item_not_found'),
        });
      }

      // `{}` is the API's HTTP 200 answer for an unknown identifier.
      if (raw.metadata === undefined && raw.files === undefined) {
        throw notFound(`Item "${identifier}" not found in the Internet Archive.`, {
          reason: 'item_not_found',
          identifier,
          ...ctx.recoveryFor('item_not_found'),
        });
      }

      const meta = raw.metadata as Record<string, unknown> | undefined;
      const storedDescription = stringOrList(meta?.description);
      const description =
        storedDescription === undefined ? undefined : descriptionText(storedDescription);
      const imageCount = isTexts(stringOrList(meta?.mediatype))
        ? wholeNumber(meta?.imagecount)
        : undefined;

      // One line per relayed field, in output order; `relay` leaves out a value of any other shape.
      const metadata: ArchiveItemMetadata = {
        identifier,
        ...relay('title', meta?.title),
        ...relay('creator', meta?.creator),
        ...(description ? { description } : {}),
        ...relay('mediatype', meta?.mediatype),
        ...relay('date', meta?.date),
        ...relay('publicdate', meta?.publicdate),
        ...relay('addeddate', meta?.addeddate),
        ...relay('subject', meta?.subject),
        ...relay('collection', meta?.collection),
        ...relay('licenseurl', meta?.licenseurl),
        ...relay('rights', meta?.rights),
        ...relay('language', meta?.language),
        ...relay('publisher', meta?.publisher),
        ...relay('volume', meta?.volume),
        ...relay('isbn', meta?.isbn),
        ...relay('oclc_id', meta?.['oclc-id']),
        ...relay('lccn', meta?.lccn),
        ...relay('openlibrary_edition', meta?.openlibrary_edition),
        ...relay('openlibrary_work', meta?.openlibrary_work),
        ...relay('runtime', meta?.runtime),
        ...(imageCount !== undefined ? { image_count: imageCount } : {}),
        ...(meta?.['access-restricted-item'] === 'true'
          ? { access_restricted: true as const }
          : {}),
      };

      const files = (Array.isArray(raw.files) ? raw.files : []).flatMap(
        (entry: unknown) => manifestFile(identifier, entry) ?? [],
      );

      ctx.log.debug('Item metadata fetched', { identifier, fileCount: files.length });
      return { metadata, files };
    });
  }

  /**
   * Read one page of a text item's text: `maxChars` UTF-16 code units from `charOffset`.
   * The file is stream-decoded and the upstream read is cancelled once the
   * character after the page has arrived, so memory per call is bounded by the page size
   * and upstream reads stop at the page's end. `hasMore` comes from that one-character
   * lookahead. `sourceFileBytes` is the manifest `size`, omitted when the manifest has none.
   * The file read is the continuation's, found by name in the manifest; else `file`, which
   * must be listed and readable text (`isReadableText`) or the call throws `invalid_file`
   * before any download; else the default pick (`defaultTextFile`), with `textFiles` set when
   * it chose among several. `continuation` resumes a validated representation using a
   * tenant-scoped, one-hour byte checkpoint.
   * With `find`, the same read searches from `charOffset` or the continuation's position and the
   * page starts at the phrase's first match (`matchOffset`, also `charOffset`); text is held from
   * the earliest place a match can still begin, at most `maxChars` + 1 units plus twice the
   * phrase. A miss is an empty page at the search start with `hasMore` false and no
   * `matchOffset`. A search that would outrun the download's request timeout or the call deadline
   * stops first and throws `find_incomplete` with the offset to resume from and, when a cursor
   * could be stored, a continuation there — never retried, so no byte it scanned is read again
   * in the call; so does a first match whose text the bound let go. A stopped search with no
   * call to name that reads past where it began — no advance past its start, and no cursor that
   * skips the bytes before it — throws `archive_unavailable` instead, also unretried.
   * Throws `invalid_continuation` (a `file` other than the continuation's included) or
   * `range_unavailable` for an unusable resume, plus `item_not_found`, `invalid_file`,
   * `no_text_file`, `download_forbidden`, or `archive_unavailable`; the metadata request and
   * the download share the call's `deadline`, and each retries a first timeout once while
   * time remains (see `retry`).
   */
  async getTextContent(
    identifier: string,
    maxChars: number,
    charOffset: number,
    ctx: Context,
    deadline: CallDeadline,
    { continuation, file, find }: TextSelection = {},
  ): Promise<TextPage> {
    const phrase = find === undefined ? undefined : compilePhrase(find);
    let cursor: TextCursor | undefined;
    if (continuation) {
      if (!/^[0-9a-f-]{36}$/.test(continuation)) throw continuationError('invalid_continuation', 0);
      try {
        cursor = (await ctx.state.get(`ia-text/${continuation}`, TextCursorSchema)) ?? undefined;
      } catch (err) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        if (err instanceof Error && err.name === 'AbortError') throw err;
        if (!storageUnavailable(err)) throw err;
        throw continuationError('invalid_continuation', 0);
      }
      if (
        cursor?.version !== 1 ||
        cursor.identifier !== identifier ||
        cursor.expiresAt <= Date.now()
      ) {
        throw continuationError(
          'invalid_continuation',
          cursor?.identifier === identifier ? cursor.nextCharOffset : 0,
        );
      }
      if (file !== undefined && file !== cursor.file) {
        throw new McpError(
          JsonRpcErrorCode.ValidationError,
          `The continuation reads "${cursor.file}", but this call names "${file}".`,
          {
            reason: 'invalid_continuation',
            retryable: false,
            char_offset: 0,
            file: cursor.file,
            ...ctx.recoveryFor('invalid_continuation'),
            recovery: {
              hint: `Keep the identifier and file the continuation came from, or omit continuation and pass char_offset 0 to read "${file}".`,
            },
          },
        );
      }
      charOffset = cursor.nextCharOffset;
    }
    // Step 1: locate the text file
    const item = await this.getItem(identifier, ctx, deadline);

    const name = cursor?.file ?? file;
    const readable = name === undefined ? item.files.filter(isReadableText) : undefined;
    const textFile = readable ? defaultTextFile(readable) : item.files.find((f) => f.name === name);
    if (!textFile) {
      if (cursor) throw continuationError('invalid_continuation', charOffset);
      if (name !== undefined) throw invalidFile(ctx, identifier, name);
      throw notFound(
        `Item "${identifier}" has no readable text file: its manifest lists no DjVuTXT, Text, or Plain Text file and no .txt file other than Metadata sidecars.`,
        { reason: 'no_text_file', identifier, ...ctx.recoveryFor('no_text_file') },
      );
    }
    if (!cursor && name !== undefined && !isReadableText(textFile)) {
      throw invalidFile(ctx, identifier, name, textFile);
    }

    const size = Number(textFile.size);
    const sourceFileBytes = Number.isSafeInteger(size) && size >= 0 ? size : undefined;
    // The continuation's file was found by name; a changed checksum or size means it changed.
    if (cursor && (cursor.md5 !== textFile.md5 || cursor.size !== textFile.size)) {
      throw continuationError('invalid_continuation', charOffset);
    }

    /** A cursor resuming this file at `nextCharOffset` from `checkpoint`, in a representation it can resume. */
    const cursorFields = (
      identity: Identity,
      nextCharOffset: number,
      checkpoint: TextCheckpoint,
    ): CursorFields => ({
      identifier,
      file: textFile.name,
      ...(textFile.md5 !== undefined && { md5: textFile.md5 }),
      ...(textFile.size !== undefined && { size: textFile.size }),
      ...identity,
      nextCharOffset,
      checkpoint,
    });

    // Step 2: stream the page out of the text file
    const download = textDownload(textFile.name);
    const read = await this.retry(download, ctx, deadline, async (signal) => {
      // A 401/403 here is the expected outcome for a restricted item — IA answers
      // 401 for login-required downloads and 403 for limited collections — so both
      // remap to the declared download_forbidden contract and its recovery hint
      // reaches the wire. expectedStatuses drops the fetch's own error-level log
      // to debug; the status-mapped McpError is still thrown, unchanged.
      let response: Response;
      const timeoutMs = deadline.nextTimeoutMs();
      const stopAt = Date.now() + timeoutMs - Math.min(FIND_STOP_MARGIN_MS, timeoutMs / 10);
      try {
        response = await fetchWithTimeout(textFile.downloadUrl, timeoutMs, ctx, {
          headers: {
            ...this.headers,
            'Accept-Encoding': 'identity',
            ...(cursor && {
              Range: `bytes=${cursor.checkpoint.byteOffset}-`,
              'If-Range': cursor.etag,
            }),
          },
          signal,
          expectedStatuses: [401, 403],
        });
      } catch (err) {
        if (cursor && statusOf(err) === 416)
          throw continuationError('range_unavailable', charOffset);
        if (
          err instanceof McpError &&
          (err.code === JsonRpcErrorCode.Forbidden || err.code === JsonRpcErrorCode.Unauthorized)
        ) {
          throw forbidden(
            `Access to item "${identifier}" is restricted — the file is in a login-required or limited collection.`,
            {
              reason: 'download_forbidden',
              identifier,
              file: textFile.name,
              ...ctx.recoveryFor('download_forbidden'),
            },
          );
        }
        throw statusError(err, download, ctx);
      }

      const etag = response.headers.get('etag');
      const encoding = response.headers.get('content-encoding');
      let totalBytes = Number(response.headers.get('content-length'));
      if (cursor) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get('content-range') ?? '',
        );
        const valid =
          response.status === 206 &&
          (!encoding || encoding === 'identity') &&
          range &&
          Number(range[1]) === cursor.checkpoint.byteOffset &&
          Number(range[3]) === cursor.totalBytes &&
          Number(range[2]) === cursor.totalBytes - 1 &&
          (response.headers.get('content-length') === null ||
            totalBytes === cursor.totalBytes - cursor.checkpoint.byteOffset);
        if (etag !== cursor.etag || (range && Number(range[3]) !== cursor.totalBytes)) {
          await response.body?.cancel();
          throw continuationError('invalid_continuation', charOffset);
        }
        if (!valid) {
          await response.body?.cancel();
          throw continuationError('range_unavailable', charOffset);
        }
        totalBytes = cursor.totalBytes;
      }
      if (response.headers.get('content-length') === null && !cursor)
        totalBytes = sourceFileBytes ?? NaN;
      // The representation a cursor can resume: a strong validator over identity bytes of known length.
      const identity: Identity | undefined =
        etag &&
        /^"[^"\r\n]*"$/.test(etag) &&
        (!encoding || encoding === 'identity') &&
        Number.isSafeInteger(totalBytes) &&
        totalBytes >= 0 &&
        (cursor !== undefined || response.status === 200)
          ? { etag, totalBytes }
          : undefined;
      // Offsets the page and search report count from the read's start: the cursor's position, or 0.
      const base = cursor ? charOffset : 0;

      const bodyRead = (err: unknown): never => {
        throw bodyReadError(err, download.name);
      };
      let page: Awaited<ReturnType<typeof readTextPage>>;
      let matchOffset: number | undefined;
      if (!phrase) {
        page = await readTextPage(
          response,
          cursor ? 0 : charOffset,
          maxChars,
          cursor?.checkpoint,
        ).catch(bodyRead);
      } else {
        const found = await findTextPage(
          response,
          phrase,
          cursor ? 0 : charOffset,
          maxChars,
          cursor?.checkpoint,
          stopAt,
        ).catch(bodyRead);
        // A caller cancellation stays one, never a miss or an incomplete search.
        if (ctx.signal.aborted) throw ctx.signal.reason;
        if (found.kind === 'incomplete') {
          ctx.log.debug('Text search stopped', {
            identifier,
            file: textFile.name,
            bytesRead: found.bytesRead,
            cause: found.cause,
          });
          // Returned, not thrown, so the retry ladder never reads the file again for it.
          return { stopped: { ...found, resumeOffset: base + found.resumeOffset }, identity };
        }
        if (found.kind === 'hit') {
          matchOffset = base + found.matchOffset;
          page = found;
        } else {
          // A miss has no next page: its checkpoint goes unread, as readTextPage's does at the end.
          page = {
            bytesRead: found.bytesRead,
            hasMore: false,
            text: '',
            checkpoint: { byteOffset: 0, skip: 0 },
          };
        }
      }
      const pageOffset = matchOffset ?? charOffset;
      if (
        cursor &&
        !page.hasMore &&
        cursor.checkpoint.byteOffset + page.bytesRead !== cursor.totalBytes
      ) {
        throw continuationError('range_unavailable', charOffset);
      }

      let nextContinuation: string | undefined;
      let continuationNotice: string | undefined;
      if (page.hasMore) {
        const next = pageOffset + maxChars;
        if (!identity) {
          continuationNotice = `Efficient continuation is unavailable because ${NO_CURSOR_BECAUSE.identity}. Continue with char_offset ${next}.`;
        } else {
          nextContinuation = await saveCursor(ctx, cursorFields(identity, next, page.checkpoint));
          if (!nextContinuation)
            continuationNotice = `Efficient continuation is unavailable because ${NO_CURSOR_BECAUSE.storage}. Continue with char_offset ${next}.`;
        }
      }

      ctx.log.debug('Text content fetched', {
        identifier,
        file: textFile.name,
        bytesRead: page.bytesRead,
        sourceFileBytes,
        sliceChars: page.text.length,
        hasMore: page.hasMore,
        ...(phrase && { matchOffset }),
      });

      return {
        text: page.text,
        hasMore: page.hasMore,
        charOffset: pageOffset,
        maxChars,
        sourceFile: textFile.name,
        ...(matchOffset !== undefined && { matchOffset }),
        ...(nextContinuation && { nextContinuation }),
        ...(continuationNotice && { continuationNotice }),
        ...(sourceFileBytes !== undefined && { sourceFileBytes }),
        ...(readable && readable.length > 1 && { textFiles: textFileSummary(readable) }),
      };
    });
    if (!('stopped' in read)) return read;

    const { stopped, identity } = read;
    const advanced = stopped.resumeOffset > charOffset;
    /**
     * The call the error names must read past where this one began, or it repeats this read. A
     * cursor decodes from its byte checkpoint, which is past this read's first byte once the
     * search advanced, or when this read decoded from byte 0 up to a later search start.
     */
    const token =
      identity && stopped.resumeCheckpoint && (advanced || (!cursor && charOffset > 0))
        ? await saveCursor(
            ctx,
            cursorFields(identity, stopped.resumeOffset, stopped.resumeCheckpoint),
          )
        : undefined;
    if (token) throw findIncomplete(textFile.name, charOffset, stopped, { token });
    // No cursor that skips ahead, and char_offset at the search start would read from byte 0 again.
    if (!advanced) throw searchStalled(textFile.name, charOffset, ctx);
    throw findIncomplete(textFile.name, charOffset, stopped, {
      noCursor: identity ? 'storage' : 'identity',
    });
  }

  /**
   * Run `fn` under the framework retry loop, bound to the request's cancellation signal and to
   * what remains of the call's `deadline`: no attempt is sent once it is spent, and `fn` gets the
   * attempt's signal, which the deadline aborts. A first timeout is retried once —
   * archive.org's metadata and download hosts stall intermittently and usually answer a second
   * request — and a second ends the ladder; a request the deadline cut short is no first
   * timeout. A 429 is not retried; any other failure follows `isRetriedFailure`. A timeout, a
   * network error once its retries are spent, or the deadline running out surfaces as
   * `archive_unavailable` (`transportError`). Everything else leaves as it was thrown. No
   * `operation` label is passed: `withRetry` copies it into an exhausted error's `data`, which
   * reaches the caller, and the message already names `upstream`.
   */
  private retry<T>(
    upstream: Upstream,
    ctx: Context,
    deadline: CallDeadline,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let timeouts = 0;
    return withRetry(
      ({ signal }) => {
        deadline.assertTimeLeft();
        return fn(signal);
      },
      {
        context: ctx,
        baseDelayMs: 1_000,
        signal: ctx.signal,
        deadlineMs: deadline.remainingMs(),
        isTransient: (err) =>
          transportFailure(err) === 'timeout'
            ? !deadline.isExpiry(err) && ++timeouts === 1
            : isRetriedFailure(err),
      },
    ).catch((err: unknown) => {
      throw transportError(err, upstream.name, deadline, unavailable(ctx));
    });
  }
}

/**
 * An upstream non-2xx from `fetchWithTimeout` as `archive_unavailable`, without the upstream
 * body; any other failure, a timeout or a caller cancellation included, is returned as it is.
 * It runs inside the retry closure. A 5xx, 408, or 425 keeps the fields the retry loop reads
 * (`retryAfter`, `retryable`), so it is retried as before. A 429 carries a hint to wait and
 * is answered after one request by the retry predicate. Any other status is a refusal no
 * retry fixes: marked `retryable: false`, with a hint naming what the caller can check.
 */
function statusError(err: unknown, upstream: Upstream, ctx: Context): unknown {
  const status = statusOf(err);
  if (status === undefined) return err;
  const { retryAfter, retryable } = (err as McpError).data ?? {};
  if (status === 429) {
    return rateLimitError(err, upstream.name, 'The Internet Archive', 'archive_unavailable');
  }
  if (status < 500 && status !== 408 && status !== 425) {
    return serviceUnavailable(
      `${upstream.name} returned HTTP ${status}.`,
      {
        reason: 'archive_unavailable',
        status,
        retryable: false,
        recovery: {
          hint: `The Internet Archive refused this request with HTTP ${status}, so repeating it will not help; ${upstream.refusalCheck}.`,
        },
      },
      { cause: err },
    );
  }
  return serviceUnavailable(
    `${upstream.name} returned HTTP ${status}.`,
    {
      ...unavailable(ctx),
      status,
      ...(retryAfter !== undefined && { retryAfter }),
      ...(retryable !== undefined && { retryable }),
    },
    { cause: err },
  );
}

/**
 * A Metadata API body as a JSON object. An HTML page, unparseable text, or a JSON value
 * that is not an object throws `archive_unavailable`, which the retry loop retries like a 5xx.
 */
function readItemBody(text: string, ctx: Context): Record<string, unknown> {
  if (isHtmlPage(text)) {
    throw serviceUnavailable(
      `${METADATA_API.name} returned an HTML page instead of JSON.`,
      unavailable(ctx),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw serviceUnavailable(
      `${METADATA_API.name} returned an unparseable response.`,
      unavailable(ctx),
    );
  }
  return parsed as Record<string, unknown>;
}

/** `{ [name]: value }` when `stringOrList` keeps the value, `{}` otherwise: one relayed field. */
const relay = <K extends keyof ArchiveItemMetadata>(
  name: K,
  value: unknown,
): Partial<Record<K, string | string[]>> => {
  const kept = stringOrList(value);
  // TypeScript types a generic computed key as a string index signature; the key is `name`.
  return kept === undefined ? {} : ({ [name]: kept } as Record<K, string | string[]>);
};

/** A manifest file field as sent when it is a non-empty string; `undefined` for any other value. */
const fileText = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** `{ [name]: value }` when `fileText` keeps the value, `{}` otherwise: one optional file field. */
const fileField = <K extends 'format' | 'size' | 'md5' | 'title' | 'track' | 'length'>(
  name: K,
  value: unknown,
): Partial<Record<K, string>> => {
  const kept = fileText(value);
  // As in `relay`: TypeScript types a generic computed key as a string index signature.
  return kept === undefined ? {} : ({ [name]: kept } as Record<K, string>);
};

/**
 * One manifest entry as an `ArchiveFile`, or `undefined` — the entry left out — when it is not an
 * object or has no file name to build a download URL from. Every other field is read through
 * `fileText`, so the `ia_get_item` format filter and the `ia_get_text` file pick, which read them
 * as strings, never meet another shape.
 */
const manifestFile = (identifier: string, entry: unknown): ArchiveFile | undefined => {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const file = entry as Record<string, unknown>;
  const name = fileText(file.name);
  if (name === undefined) return undefined;
  return {
    name,
    downloadUrl: `${DOWNLOAD_BASE}/${encodeURIComponent(identifier)}/${encodeURIComponent(name)}`,
    ...fileField('format', file.format),
    ...fileField('size', file.size),
    ...fileField('md5', file.md5),
    ...fileField('title', file.title),
    ...fileField('track', file.track),
    ...fileField('length', file.length),
    ...(file.private === 'true' ? { private: true as const } : {}),
  };
};

/** True for a `texts` mediatype: the string, or a non-empty list whose every value is `texts`. */
const isTexts = (mediatype: string | string[] | undefined): boolean => {
  const values = [mediatype ?? []].flat();
  return values.length > 0 && values.every((m) => m === 'texts');
};

/**
 * A count the Metadata API sends as a string of digits, as a number; `undefined` for
 * anything else, a fraction, sign, or unsafe integer included.
 */
const wholeNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
};

/**
 * A description value as plain-text lines, each value of a list converted on its own. A list
 * keeps only the values left holding text; one left with none reads as no description.
 */
const descriptionText = (value: string | string[]): string | string[] | undefined => {
  if (!Array.isArray(value)) return descriptionToText(value);
  const values = value.map((v) => descriptionToText(v)).filter((v) => v !== '');
  return values.length > 0 ? values : undefined;
};

/** `archive_unavailable` with the calling definition's recovery hint, as error `data` fields. */
function unavailable(ctx: Context): Record<string, unknown> {
  return { reason: 'archive_unavailable', ...ctx.recoveryFor('archive_unavailable') };
}

/**
 * A file `ia_get_text` reads: format DjVuTXT, Text, or Plain Text in any case, or a `.txt`
 * name whose format is not Metadata — the `*_meta.txt` sidecars holding the request headers
 * of an upload, which carry none of the item's text.
 */
function isReadableText(file: ArchiveFile): boolean {
  const format = file.format?.toLowerCase();
  return (
    (format !== undefined && TEXT_FORMATS_PRIORITY.includes(format)) ||
    (file.name.endsWith('.txt') && format !== 'metadata')
  );
}

/**
 * The default pick among an item's readable files, in manifest order: the first DjVuTXT, then
 * Text, then Plain Text, then the first other readable `.txt` file.
 */
function defaultTextFile(readable: ArchiveFile[]): ArchiveFile | undefined {
  for (const format of TEXT_FORMATS_PRIORITY) {
    const match = readable.find((f) => f.format?.toLowerCase() === format);
    if (match) return match;
  }
  return readable[0];
}

/** How many readable files the default pick chose among, and the formats that list them. */
function textFileSummary(readable: ArchiveFile[]): TextFileSummary {
  const formats = [...new Set(readable.flatMap((f) => (f.format ? [f.format] : [])))];
  return {
    count: readable.length,
    formats,
    unformatted: readable.filter((f) => !f.format).length,
  };
}

/**
 * `invalid_file` for a requested name: missing from the manifest, or — when `listed` is the
 * file it names — not readable text.
 */
function invalidFile(ctx: Context, identifier: string, name: string, listed?: ArchiveFile) {
  const message = !listed
    ? `Item "${identifier}" lists no file named "${name}".`
    : listed.format
      ? `File "${name}" of item "${identifier}" has format "${listed.format}", which is not readable text.`
      : `File "${name}" of item "${identifier}" lists no format and is not a .txt file, so it is not readable text.`;
  return invalidParams(message, {
    reason: 'invalid_file',
    identifier,
    file: name,
    ...ctx.recoveryFor('invalid_file'),
  });
}

// --- Init/accessor pattern ---

let _service: ArchiveMetadataService | undefined;

export function initArchiveMetadataService(config: AppConfig, storage: StorageService): void {
  _service = new ArchiveMetadataService(config, storage);
}

export function getArchiveMetadataService(): ArchiveMetadataService {
  if (!_service) {
    throw new Error(
      'ArchiveMetadataService not initialized — call initArchiveMetadataService() in setup()',
    );
  }
  return _service;
}
