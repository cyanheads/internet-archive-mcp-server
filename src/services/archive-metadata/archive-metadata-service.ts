/**
 * @fileoverview Archive Metadata service wrapping the Internet Archive Metadata and download APIs.
 * @module services/archive-metadata/archive-metadata-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
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
import type { ArchiveFile, ArchiveItem, ArchiveItemMetadata, TextContent } from './types.js';

const METADATA_BASE = 'https://archive.org/metadata';
const DOWNLOAD_BASE = 'https://archive.org/download';

/** Text file formats preferred for text extraction, in priority order. */
const TEXT_FORMATS_PRIORITY = ['DjVuTXT', 'Text', 'Plain Text'];

export class ArchiveMetadataService {
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: AppConfig, _storage: StorageService) {
    this.headers = { 'User-Agent': getUserAgent(config.mcpServerVersion) };
    this.timeoutMs = getServerConfig().requestTimeoutMs;
  }

  /**
   * Retrieve full metadata and file manifest for an Archive item.
   * Throws `item_not_found` when the API returns `{}`.
   */
  getItem(identifier: string, ctx: Context): Promise<ArchiveItem> {
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(
          `${METADATA_BASE}/${encodeURIComponent(identifier)}`,
          this.timeoutMs,
          ctx as unknown as Parameters<typeof fetchWithTimeout>[2],
          { headers: this.headers, signal: ctx.signal },
        );

        const text = await response.text();
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw serviceUnavailable('Metadata API returned unparseable response.', { identifier });
        }

        // Empty object = not found (API returns HTTP 200 with `{}` for unknown identifiers)
        if (Object.keys(raw).length === 0) {
          throw notFound(`Item "${identifier}" not found in the Internet Archive.`, {
            reason: 'item_not_found',
            identifier,
          });
        }

        // Dark/restricted items return HTTP 200 with routing fields but no metadata or files.
        // is_dark: true means the item has been removed or restricted — treat as not found.
        if (raw.is_dark === true) {
          throw notFound(`Item "${identifier}" is dark (restricted) in the Internet Archive.`, {
            reason: 'item_not_found',
            identifier,
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
          ...(meta?.language ? { language: meta.language as string } : {}),
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
      },
      {
        operation: 'ArchiveMetadataService.getItem',
        // biome-ignore lint/suspicious/noExplicitAny: framework withRetry context type mismatch
        context: ctx as any,
        baseDelayMs: 1_000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Retrieve readable text content for a text item.
   * Throws `item_not_found`, `no_text_file`, or `download_forbidden`.
   */
  async getTextContent(
    identifier: string,
    maxChars: number,
    charOffset: number,
    ctx: Context,
  ): Promise<TextContent> {
    // Step 1: locate the text file
    const item = await this.getItem(identifier, ctx);

    const textFile = findBestTextFile(item.files);
    if (!textFile) {
      throw notFound(
        `No readable text file found for item "${identifier}". ` +
          `The item exists but has no DjVuTXT or plain-text file in its manifest.`,
        { reason: 'no_text_file', identifier },
      );
    }

    // Step 2: download the text content
    return withRetry(
      async () => {
        // A 401/403 here is the expected outcome for a restricted item — IA answers
        // 401 for login-required downloads and 403 for limited collections — so both
        // remap to the declared download_forbidden contract and its recovery hint
        // reaches the wire. expectedStatuses drops the fetch's own error-level log
        // to debug; the status-mapped McpError is still thrown, unchanged.
        let response: Response;
        try {
          response = await fetchWithTimeout(
            textFile.downloadUrl,
            this.timeoutMs,
            ctx as unknown as Parameters<typeof fetchWithTimeout>[2],
            { headers: this.headers, signal: ctx.signal, expectedStatuses: [401, 403] },
          );
        } catch (err) {
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
          throw err;
        }

        const fullText = await response.text();
        const totalChars = fullText.length;
        const slice = fullText.slice(charOffset, charOffset + maxChars);

        ctx.log.debug('Text content fetched', {
          identifier,
          file: textFile.name,
          totalChars,
          sliceChars: slice.length,
        });

        return {
          text: slice,
          totalChars,
          charOffset,
          maxChars,
          sourceFile: textFile.name,
        };
      },
      {
        operation: 'ArchiveMetadataService.getTextContent',
        // biome-ignore lint/suspicious/noExplicitAny: framework withRetry context type mismatch
        context: ctx as any,
        baseDelayMs: 1_000,
        signal: ctx.signal,
      },
    );
  }
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
