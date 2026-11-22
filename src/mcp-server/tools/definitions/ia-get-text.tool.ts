/**
 * @fileoverview Tool for retrieving readable text content from an Internet Archive text item.
 * @module mcp-server/tools/definitions/ia-get-text
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  getArchiveMetadataService,
  type TextFileSummary,
} from '@/services/archive-metadata/archive-metadata-service.js';
import { requireItemReference } from '@/services/archive-metadata/item-reference.js';
import { compilePhrase } from '@/services/archive-metadata/phrase-matcher.js';
import { startCallDeadline } from '@/services/call-deadline.js';

/** Quoted values as an "or" list: `"a"`, `"a" or "b"`, `"a", "b", or "c"`. */
const orList = (values: string[]): string => {
  const quoted = values.map((v) => `"${v}"`);
  return quoted.length <= 2
    ? quoted.join(' or ')
    : `${quoted.slice(0, -1).join(', ')}, or ${quoted.at(-1)}`;
};

/** How many readable text files the default pick chose among, and how to list and read the rest. */
const textFilesNotice = ({ count, formats, unformatted }: TextFileSummary): string => {
  const lists =
    formats.length === 0
      ? 'The unfiltered ia_get_item manifest lists them'
      : `ia_get_item with format ${orList(formats)} lists them${unformatted > 0 ? `, except ${unformatted} with no format, listed only in the unfiltered manifest` : ''}`;
  return `This item has ${count} readable text files; this page is from the default one, source_file. ${lists}. Pass another one's name as file to read it.`;
};

export const iaGetText = tool('ia_get_text', {
  title: 'Get Internet Archive Item Text',
  description:
    "Retrieve readable OCR DjVuTXT or plain text from an Internet Archive item, including public-domain books, documents, scanned periodicals, and transcripts. Each call reads one text file: the one file names, or by default the first DjVuTXT file (else Text, Plain Text, or another .txt file). An item can hold several, such as one per volume; a notice then gives the count. Set max_chars for page size, then pass next_continuation as continuation with the same identifier and omit char_offset. Direct char_offset access remains available. To jump to a passage, pass find with a phrase: the page starts at its first match at or after char_offset or the continuation's position, and match_offset reports where; that page's next_continuation, passed back with the same find, searches on from the page's end. To list the DjVuTXT files of an item, call ia_get_item with format \"DjVuTXT\".",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    identifier: z
      .string()
      .trim()
      .min(1, 'Must not be blank — provide an item identifier from ia_search_items.')
      .describe(
        'Internet Archive item identifier, e.g. "prideprejudice00aust" (Pride and Prejudice), from ia_search_items results; or an archive.org item URL, such as https://archive.org/details/prideprejudice00aust or its download, stream, metadata, or embed form, read as the identifier it names. A download, stream, or storage-node URL naming a file reads that file when file is omitted.',
      ),
    max_chars: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Maximum number of characters to return in this response. Defaults to the server-configured maximum (IA_MAX_SNAPSHOT_CHARS, typically 50 000); a larger value is served at that maximum, with a notice. Lower values reduce token usage.',
      ),
    char_offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Character offset to start reading from (default 0); with find, where the search starts. For sequential pages use next_continuation as continuation instead. Omit char_offset when using continuation.',
      ),
    continuation: z
      .string()
      .trim()
      .optional()
      .describe(
        'Opaque next_continuation from the previous page. Omit char_offset when using it; blank is omitted.',
      ),
    file: z
      .string()
      .optional()
      .describe(
        'The text file to read, named exactly as ia_get_item lists it, e.g. "Strabo 02 Geography 3-5_djvu.txt". It must be readable text: format DjVuTXT, Text, or Plain Text, or a .txt name whose format is not Metadata. Omit to read the default: the first DjVuTXT file, else Text, else Plain Text, else another .txt file. With continuation, omit it or name the file the continuation reads; blank is omitted.',
      ),
    find: z
      .string()
      .max(500)
      .trim()
      .optional()
      .describe(
        "A literal phrase of at most 500 characters to find in the file read; the page then starts at its first match at or after char_offset or the continuation's position. Letters match regardless of case, one character to one (ß never matches ss); a whitespace run in the phrase matches any whitespace run in the text, line breaks included; every other character matches itself. OCR misreads and words hyphenated across line ends break a phrase, so prefer a short, distinctive one. Blank is omitted.",
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
    char_offset: z
      .number()
      .describe(
        'Character offset used for this response: with find, where its first match begins (equal to match_offset), or where the search started when nothing matched.',
      ),
    match_offset: z
      .number()
      .optional()
      .describe(
        'With find, the character offset where its first match begins, equal to char_offset. Omitted when find matched nothing or was not given.',
      ),
    max_chars: z
      .number()
      .describe(
        'Maximum characters this response could hold — the requested max_chars, or the server maximum when the request exceeded it.',
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
        'Size of the source text file in bytes, from the item manifest — a byte count, not a character count (non-ASCII text takes several bytes per character). Omitted when the manifest lists no size.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Explains a max_chars clamp or why efficient continuation is unavailable, with the next char_offset or end-of-document status; that find matched nothing from char_offset to the end of source_file; or — when file was omitted — how many readable text files the item holds and how to list them.',
      ),
  },

  enrichmentTrailer: {
    notice: { render: (value) => escapeMarkdownInline(String(value)) },
  },

  errors: [
    {
      reason: 'invalid_continuation',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A continuation is unknown, expired, belongs to another item, reads a different file than file names, or its file changed.',
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
      reason: 'find_incomplete',
      code: JsonRpcErrorCode.Timeout,
      when: "With find, the search stopped before the download's request timeout or the call deadline would have cut it off, once past its start, or at a later char_offset it reached with a continuation stored there; or the first match was found past a whitespace run longer than the text one call holds, so the call names the match's char_offset instead of returning its page.",
      recovery:
        'Call again with the same find and the continuation the error names. With no continuation, pass the char_offset it names: that call reads the file from its first byte, so after a stop it searches further only if the download runs faster.',
      thrownBy: 'service',
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
      reason: 'invalid_identifier',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'identifier holds "/" or ":" but is not an archive.org item URL: a URL on another site, a Wayback Machine capture, or an archive.org page that names no item.',
      recovery:
        'Pass a bare identifier from ia_search_items, such as "prideprejudice00aust", or an archive.org item URL that names one, such as https://archive.org/details/prideprejudice00aust or its download, stream, metadata, or embed form.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_file',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'file, or the file a download, stream, or storage-node URL names, is not in the item manifest or is not readable text.',
      recovery:
        'Pass a file name ia_get_item lists with format DjVuTXT, Text, or Plain Text, or a .txt file whose format is not Metadata, or omit file for the default text file; download any other format from its download_url.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'no_text_file',
      code: JsonRpcErrorCode.NotFound,
      when: 'The item exists but lists no readable text file: no DjVuTXT, Text, or Plain Text file, and no .txt file other than Metadata sidecars.',
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
      when: "The Internet Archive Metadata API or the text file download did not answer within the request timeout or the call's 55 s deadline (the request timeout when that is longer), could not be reached, answered HTTP 5xx after retries, 429, or another 4xx, or the metadata response was unreadable; or, with find, the download was too slow for the search to get past its start before then.",
      recovery:
        'The Internet Archive is temporarily unavailable or overloaded; retry in a few minutes. When the message names the download as timed out or cut off by the call deadline, a retry can stall the same way; the download_url ia_get_item lists for the file serves it whole.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const deadline = startCallDeadline(ctx.signal);
    const svc = getArchiveMetadataService();
    // Read before a continuation's identifier is compared, so a URL matches the bare identifier.
    const item = requireItemReference(input.identifier, ctx);
    const ceiling = getServerConfig().maxSnapshotChars;
    // The page size is what bounds a call's memory and upstream read, so it never exceeds the ceiling.
    const maxChars = Math.min(input.max_chars ?? ceiling, ceiling);
    const continuation = input.continuation || undefined;
    if (continuation && input.char_offset !== undefined) throw ctx.fail('ambiguous_pagination');
    const charOffset = input.char_offset ?? 0;
    const file = input.file?.trim() ? input.file : item.file;
    // The service's own test, not the schema's String#trim (which keeps U+0085): only White_Space is blank.
    const find = input.find !== undefined && compilePhrase(input.find) ? input.find : undefined;

    const result = await svc.getTextContent(item.identifier, maxChars, charOffset, ctx, deadline, {
      continuation,
      file,
      find,
    });

    ctx.log.info('Text content retrieved', {
      identifier: item.identifier,
      sourceFile: result.sourceFile,
      sourceFileBytes: result.sourceFileBytes,
      sliceChars: result.text.length,
      hasMore: result.hasMore,
    });

    // One string: a later ctx.enrich.notice() call replaces an earlier one.
    const notices: string[] = [];
    if (find !== undefined && result.matchOffset === undefined) {
      notices.push(
        `No match for find in "${result.sourceFile}" from char_offset ${result.charOffset.toLocaleString('en-US')} to its end. OCR misreads and words hyphenated across line ends break a phrase; a shorter or different phrase may still match.`,
      );
    }
    if (result.continuationNotice) notices.push(result.continuationNotice);
    if (input.max_chars !== undefined && input.max_chars > ceiling) {
      const next = result.hasMore
        ? `Continue from char_offset ${(result.charOffset + maxChars).toLocaleString('en-US')}.`
        : 'This page reaches the end of the document.';
      notices.push(
        `max_chars ${input.max_chars.toLocaleString('en-US')} is above this server's maximum of ${ceiling.toLocaleString('en-US')} characters per call, so this page holds up to ${ceiling.toLocaleString('en-US')}. ${next}`,
      );
    }
    if (result.textFiles) notices.push(textFilesNotice(result.textFiles));
    if (notices.length) ctx.enrich.notice(notices.join(' '));

    return {
      text: result.text,
      char_offset: result.charOffset,
      ...(result.matchOffset !== undefined && { match_offset: result.matchOffset }),
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
    const matchOffset =
      result.match_offset === undefined
        ? ''
        : ` | **Match Offset:** ${result.match_offset.toLocaleString()}`;
    const lines: string[] = [
      ...(result.next_continuation ? [`**Next continuation:** ${result.next_continuation}`] : []),
      `**Source:** ${escapeMarkdownInline(result.source_file)}${fileSize}`,
      `**Max Chars:** ${result.max_chars.toLocaleString()} | **Offset:** ${result.char_offset.toLocaleString()}${result.has_more ? ` — more follows (next offset: ${nextOffset.toLocaleString()})` : ' — end of document'}${matchOffset}`,
      '',
      '---',
      '',
      escapeMarkdownInline(result.text),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
