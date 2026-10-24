/**
 * @fileoverview Tool for retrieving readable text content from an Internet Archive text item.
 * @module mcp-server/tools/definitions/ia-get-text
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { getArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

export const iaGetText = tool('ia_get_text', {
  title: 'Get Internet Archive Item Text',
  description:
    'Retrieve readable OCR DjVuTXT or plain text from an Internet Archive item, including public-domain books, documents, scanned periodicals, and transcripts. Set max_chars for page size, then pass next_continuation as continuation with the same identifier and omit char_offset. Direct char_offset access remains available. To confirm a text file exists, call ia_get_item with format "DjVuTXT".',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    identifier: z
      .string()
      .trim()
      .min(1, 'Must not be blank — provide an item identifier from ia_search_items.')
      .describe(
        'Internet Archive item identifier, e.g. "prideprejudice00aust" (Pride and Prejudice). ' +
          'Obtain from ia_search_items results.',
      ),
    max_chars: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Maximum number of characters to return in this response. Defaults to the server-configured ' +
          'maximum (IA_MAX_SNAPSHOT_CHARS, typically 50 000); a larger value is served at that ' +
          'maximum, with a notice. Lower values reduce token usage.',
      ),
    char_offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Character offset to start reading from (default 0). For sequential pages use next_continuation as continuation instead. Omit char_offset when using continuation.',
      ),
    continuation: z
      .string()
      .trim()
      .optional()
      .describe(
        'Opaque next_continuation from the previous page. Omit char_offset when using it; blank is omitted.',
      ),
  }),

  output: z.object({
    next_continuation: z
      .string()
      .optional()
      .describe(
        'Opaque next-page token; use as continuation with the same identifier and omit char_offset. Expires after one hour.',
      ),
    text: z.string().describe('The text slice starting at char_offset up to max_chars characters.'),
    char_offset: z.number().describe('Character offset used for this response.'),
    max_chars: z
      .number()
      .describe(
        'Maximum characters this response could hold — the requested max_chars, or the server ' +
          'maximum when the request exceeded it.',
      ),
    has_more: z
      .boolean()
      .describe(
        'True when there is more text beyond this slice. Use next_continuation, or add max_chars to char_offset if no token is available.',
      ),
    source_file: z.string().describe('Filename of the source text file fetched from the item.'),
    source_file_bytes: z
      .number()
      .optional()
      .describe(
        'Size of the source text file in bytes, from the item manifest — a byte count, not a ' +
          'character count (non-ASCII text takes several bytes per character). Omitted when the ' +
          'manifest lists no size.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Explains a max_chars clamp or why efficient continuation is unavailable, with the next char_offset or end-of-document status.',
      ),
  },

  errors: [
    {
      reason: 'invalid_continuation',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A continuation is unknown, expired, belongs to another item, or its file changed.',
      recovery:
        'Omit continuation and restart with char_offset 0, or use the offset named in the error.',
      thrownBy: 'service',
    },
    {
      reason: 'range_unavailable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The download ignored or returned an invalid conditional byte range.',
      recovery: 'Omit continuation and retry with the char_offset named in the error.',
      thrownBy: 'service',
    },
    {
      reason: 'ambiguous_pagination',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both a nonblank continuation and char_offset were supplied.',
      recovery: 'Supply continuation alone, or omit continuation and provide char_offset.',
    },
    {
      reason: 'item_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The identifier does not exist in the Internet Archive.',
      recovery:
        'Verify the identifier using ia_search_items or check the Internet Archive website.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'no_text_file',
      code: JsonRpcErrorCode.NotFound,
      when: 'The item exists but contains no readable text file (DjVuTXT or plain-text).',
      recovery:
        'Use ia_get_item to review the file manifest and find an alternative format for download.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'download_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Access to this item is restricted — it is in a login-required or limited collection.',
      recovery:
        'This item requires login or is in a restricted collection; access via the Archive website directly.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'archive_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when:
        'The Internet Archive Metadata API or the text file download did not answer within ' +
        'the request timeout, could not be reached, answered HTTP 5xx after retries, 429, or ' +
        'another 4xx, or the metadata response was unreadable.',
      recovery:
        'The Internet Archive is temporarily unavailable or overloaded; retry in a few minutes. ' +
        'When the message names a download timeout, a retry can time out the same way; the ' +
        'download_url ia_get_item lists for the file serves it whole.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getArchiveMetadataService();
    const ceiling = getServerConfig().maxSnapshotChars;
    // The page size is what bounds a call's memory and upstream read, so it never exceeds the ceiling.
    const maxChars = Math.min(input.max_chars ?? ceiling, ceiling);
    const continuation = input.continuation || undefined;
    if (continuation && input.char_offset !== undefined) throw ctx.fail('ambiguous_pagination');
    const charOffset = input.char_offset ?? 0;

    const result = continuation
      ? await svc.getTextContent(input.identifier, maxChars, charOffset, ctx, continuation)
      : await svc.getTextContent(input.identifier, maxChars, charOffset, ctx);

    ctx.log.info('Text content retrieved', {
      identifier: input.identifier,
      sourceFile: result.sourceFile,
      sourceFileBytes: result.sourceFileBytes,
      sliceChars: result.text.length,
      hasMore: result.hasMore,
    });

    const notices: string[] = [];
    if (result.continuationNotice) notices.push(result.continuationNotice);
    if (input.max_chars !== undefined && input.max_chars > ceiling) {
      notices.push(
        `max_chars ${input.max_chars.toLocaleString('en-US')} is above this server's maximum of ` +
          `${ceiling.toLocaleString('en-US')} characters per call, so this page holds up to ` +
          `${ceiling.toLocaleString('en-US')}. ` +
          (result.hasMore
            ? `Continue from char_offset ${(result.charOffset + maxChars).toLocaleString('en-US')}.`
            : 'This page reaches the end of the document.'),
      );
    }
    if (notices.length) ctx.enrich.notice(notices.join(' '));

    return {
      text: result.text,
      char_offset: result.charOffset,
      max_chars: maxChars,
      has_more: result.hasMore,
      source_file: result.sourceFile,
      ...(result.nextContinuation && { next_continuation: result.nextContinuation }),
      ...(result.sourceFileBytes !== undefined && { source_file_bytes: result.sourceFileBytes }),
    };
  },

  format: (result) => {
    const nextOffset = result.char_offset + result.max_chars;
    const fileSize =
      result.source_file_bytes === undefined
        ? ''
        : ` | **File Size:** ${result.source_file_bytes.toLocaleString()} bytes`;
    const lines: string[] = [
      ...(result.next_continuation ? [`**Next continuation:** ${result.next_continuation}`] : []),
      `**Source:** ${escapeMarkdownInline(result.source_file)}${fileSize}`,
      `**Max Chars:** ${result.max_chars.toLocaleString()} | **Offset:** ${result.char_offset.toLocaleString()}${result.has_more ? ` — more follows (next offset: ${nextOffset.toLocaleString()})` : ' — end of document'}`,
      '',
      '---',
      '',
      escapeMarkdownInline(result.text),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
