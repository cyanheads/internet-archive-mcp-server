/**
 * @fileoverview Archive Metadata service wrapping the Internet Archive Metadata and download APIs.
 * @module services/archive-metadata/archive-metadata-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  forbidden,
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, getUserAgent } from '@/config/server-config.js';
import {
  bodyReadError,
  isHtmlPage,
  isRetriedFailure,
  rateLimitError,
  statusOf,
  transportError,
  transportFailure,
} from '../upstream-errors.js';
import { readTextPage } from './read-text-page.js';
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
  ctx: Context,
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
      ...ctx.recoveryFor(reason),
      recovery: {
        hint: `Omit continuation and retry with char_offset ${charOffset}; restart from char_offset 0 if the file changed.`,
      },
    },
  );

const METADATA_BASE = 'https://archive.org/metadata';
const DOWNLOAD_BASE = 'https://archive.org/download';

/** Text file formats preferred for text extraction, in priority order. */
const TEXT_FORMATS_PRIORITY = ['DjVuTXT', 'Text', 'Plain Text'];

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
  private readonly timeoutMs: number;

  constructor(config: AppConfig, _storage: StorageService) {
    this.headers = { 'User-Agent': getUserAgent(config.mcpServerVersion) };
    this.timeoutMs = getServerConfig().requestTimeoutMs;
  }

  /**
   * Retrieve full metadata and the complete file manifest for an Archive item —
   * `ia_get_text` scans every file, so paging stays in the `ia_get_item` handler.
   * Throws `item_not_found` (with the caller's recovery hint) when the API returns
   * `{}`, the item is dark, or the body holds neither metadata nor a file list — the
   * `error` or `result` the API answers for an identifier with a `/` in it. Any other
   * failure is `archive_unavailable` (see `retry` and `statusError`).
   */
  getItem(identifier: string, ctx: Context): Promise<ArchiveItem> {
    return this.retry('getItem', METADATA_API, ctx, async () => {
      const response = await fetchWithTimeout(
        `${METADATA_BASE}/${encodeURIComponent(identifier)}`,
        this.timeoutMs,
        ctx,
        { headers: this.headers, signal: ctx.signal },
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
      const rawFiles = (raw.files as unknown[] | undefined) ?? [];

      const metadata: ArchiveItemMetadata = {
        identifier,
        ...(meta?.title ? { title: meta.title as string } : {}),
        ...(meta?.creator ? { creator: meta.creator as string | string[] } : {}),
        ...(meta?.description ? { description: meta.description as string | string[] } : {}),
        ...(meta?.mediatype ? { mediatype: meta.mediatype as string } : {}),
        ...(meta?.date ? { date: meta.date as string } : {}),
        ...(meta?.subject ? { subject: meta.subject as string | string[] } : {}),
        ...(meta?.collection ? { collection: meta.collection as string | string[] } : {}),
        ...(meta?.licenseurl ? { licenseurl: meta.licenseurl as string } : {}),
        ...(meta?.rights ? { rights: meta.rights as string } : {}),
        ...(meta?.language ? { language: meta.language as string | string[] } : {}),
      };

      const files: ArchiveFile[] = rawFiles.map((f) => {
        const file = f as Record<string, unknown>;
        const name = (file.name as string) ?? '';
        return {
          name,
          downloadUrl: `${DOWNLOAD_BASE}/${encodeURIComponent(identifier)}/${encodeURIComponent(name)}`,
          ...(file.format ? { format: file.format as string } : {}),
          ...(file.size ? { size: file.size as string } : {}),
          ...(file.md5 ? { md5: file.md5 as string } : {}),
        };
      });

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
   * `continuation` resumes a validated representation using a tenant-scoped, one-hour byte checkpoint.
   * Throws `invalid_continuation` or `range_unavailable` for an unusable resume, plus
   * `item_not_found`, `no_text_file`, `download_forbidden`, or `archive_unavailable`;
   * the metadata request and the download each retry a first timeout once (see `retry`).
   */
  async getTextContent(
    identifier: string,
    maxChars: number,
    charOffset: number,
    ctx: Context,
    continuation?: string,
  ): Promise<TextContent> {
    let cursor: TextCursor | undefined;
    if (continuation) {
      if (!/^[0-9a-f-]{36}$/.test(continuation))
        throw continuationError(ctx, 'invalid_continuation', 0);
      try {
        cursor = (await ctx.state.get(`ia-text/${continuation}`, TextCursorSchema)) ?? undefined;
      } catch (err) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        if (err instanceof Error && err.name === 'AbortError') throw err;
        if (!storageUnavailable(err)) throw err;
        throw continuationError(ctx, 'invalid_continuation', 0);
      }
      if (
        cursor?.version !== 1 ||
        cursor.identifier !== identifier ||
        cursor.expiresAt <= Date.now()
      ) {
        throw continuationError(
          ctx,
          'invalid_continuation',
          cursor?.identifier === identifier ? cursor.nextCharOffset : 0,
        );
      }
      charOffset = cursor.nextCharOffset;
    }
    // Step 1: locate the text file
    const item = await this.getItem(identifier, ctx);

    const textFile = findBestTextFile(item.files);
    if (!textFile) {
      if (cursor) throw continuationError(ctx, 'invalid_continuation', charOffset);
      throw notFound(
        `No readable text file found for item "${identifier}". ` +
          `The item exists but has no DjVuTXT or plain-text file in its manifest.`,
        { reason: 'no_text_file', identifier, ...ctx.recoveryFor('no_text_file') },
      );
    }

    const size = Number(textFile.size);
    const sourceFileBytes = Number.isSafeInteger(size) && size >= 0 ? size : undefined;
    if (
      cursor &&
      (cursor.file !== textFile.name ||
        cursor.md5 !== textFile.md5 ||
        cursor.size !== textFile.size)
    ) {
      throw continuationError(ctx, 'invalid_continuation', charOffset);
    }

    // Step 2: stream the page out of the text file
    const download = textDownload(textFile.name);
    return this.retry('getTextContent', download, ctx, async () => {
      // A 401/403 here is the expected outcome for a restricted item — IA answers
      // 401 for login-required downloads and 403 for limited collections — so both
      // remap to the declared download_forbidden contract and its recovery hint
      // reaches the wire. expectedStatuses drops the fetch's own error-level log
      // to debug; the status-mapped McpError is still thrown, unchanged.
      let response: Response;
      try {
        response = await fetchWithTimeout(textFile.downloadUrl, this.timeoutMs, ctx, {
          headers: {
            ...this.headers,
            'Accept-Encoding': 'identity',
            ...(cursor && {
              Range: `bytes=${cursor.checkpoint.byteOffset}-`,
              'If-Range': cursor.etag,
            }),
          },
          signal: ctx.signal,
          expectedStatuses: [401, 403],
        });
      } catch (err) {
        if (cursor && statusOf(err) === 416)
          throw continuationError(ctx, 'range_unavailable', charOffset);
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
          throw continuationError(ctx, 'invalid_continuation', charOffset);
        }
        if (!valid) {
          await response.body?.cancel();
          throw continuationError(ctx, 'range_unavailable', charOffset);
        }
        totalBytes = cursor.totalBytes;
      }
      const page = await readTextPage(
        response,
        cursor ? 0 : charOffset,
        maxChars,
        cursor?.checkpoint,
      ).catch((err: unknown) => {
        throw bodyReadError(err, download.name);
      });
      if (
        cursor &&
        !page.hasMore &&
        cursor.checkpoint.byteOffset + page.bytesRead !== cursor.totalBytes
      ) {
        throw continuationError(ctx, 'range_unavailable', charOffset);
      }

      let nextContinuation: string | undefined;
      let continuationNotice: string | undefined;
      if (page.hasMore) {
        if (response.headers.get('content-length') === null && !cursor)
          totalBytes = sourceFileBytes ?? NaN;
        if (
          !etag ||
          !/^"[^"\r\n]*"$/.test(etag) ||
          (encoding && encoding !== 'identity') ||
          !Number.isSafeInteger(totalBytes) ||
          totalBytes < 0 ||
          (!cursor && response.status !== 200)
        ) {
          continuationNotice = `Efficient continuation is unavailable because the download lacks a stable identity validator or byte length. Continue with char_offset ${charOffset + maxChars}.`;
        } else {
          const token = crypto.randomUUID();
          const record: TextCursor = {
            version: 1,
            identifier,
            file: textFile.name,
            ...(textFile.md5 !== undefined && { md5: textFile.md5 }),
            ...(textFile.size !== undefined && { size: textFile.size }),
            etag,
            totalBytes,
            nextCharOffset: charOffset + maxChars,
            checkpoint: page.checkpoint,
            expiresAt: Date.now() + CURSOR_TTL * 1_000,
          };
          try {
            await ctx.state.set(`ia-text/${token}`, record, { ttl: CURSOR_TTL });
            nextContinuation = token;
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
            continuationNotice = `Efficient continuation is unavailable because cursor storage could not be reached. Continue with char_offset ${charOffset + maxChars}.`;
          }
        }
      }

      ctx.log.debug('Text content fetched', {
        identifier,
        file: textFile.name,
        bytesRead: page.bytesRead,
        sourceFileBytes,
        sliceChars: page.text.length,
        hasMore: page.hasMore,
      });

      return {
        text: page.text,
        hasMore: page.hasMore,
        charOffset,
        maxChars,
        sourceFile: textFile.name,
        ...(nextContinuation && { nextContinuation }),
        ...(continuationNotice && { continuationNotice }),
        ...(sourceFileBytes !== undefined && { sourceFileBytes }),
      };
    });
  }

  /**
   * Run `fn` under the framework retry loop, bound to the request's cancellation signal.
   * A first timeout is retried once — archive.org's metadata and download hosts stall
   * intermittently and usually answer a second request — and a second ends the call, so a
   * call waits at most two request timeouts on them. A 429 is not retried; any other failure
   * follows `isRetriedFailure`. A timeout, or a network error once its retries are spent,
   * surfaces as `archive_unavailable`. Everything else leaves as it was thrown.
   */
  private retry<T>(
    operation: string,
    upstream: Upstream,
    ctx: Context,
    fn: () => Promise<T>,
  ): Promise<T> {
    let timeouts = 0;
    return withRetry(fn, {
      operation: `ArchiveMetadataService.${operation}`,
      context: ctx,
      baseDelayMs: 1_000,
      signal: ctx.signal,
      isTransient: (err) =>
        transportFailure(err) === 'timeout' ? ++timeouts === 1 : isRetriedFailure(err),
    }).catch((err: unknown) => {
      throw transportError(err, upstream.name, this.timeoutMs, unavailable(ctx));
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

/** `archive_unavailable` with the calling definition's recovery hint, as error `data` fields. */
function unavailable(ctx: Context): Record<string, unknown> {
  return { reason: 'archive_unavailable', ...ctx.recoveryFor('archive_unavailable') };
}

/** Find the best text file from the manifest, preferring DjVuTXT then plain text. */
function findBestTextFile(files: ArchiveFile[]): ArchiveFile | undefined {
  for (const preferredFormat of TEXT_FORMATS_PRIORITY) {
    const match = files.find((f) => f.format?.toLowerCase() === preferredFormat.toLowerCase());
    if (match) return match;
  }
  // Fallback: any .txt file
  return files.find((f) => f.name.endsWith('.txt'));
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
