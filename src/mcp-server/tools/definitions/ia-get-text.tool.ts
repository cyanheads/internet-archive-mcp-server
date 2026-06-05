/**
 * @fileoverview Tool for retrieving readable text content from an Internet Archive text item.
 * @module mcp-server/tools/definitions/ia-get-text
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

export const iaGetText = tool('ia_get_text', {
  title: 'Get Internet Archive Item Text',
  description:
    'Retrieve the readable text content of a text item (OCR DjVuTXT or plain-text file) from the ' +
    'Internet Archive, with length-aware truncation and a continuation pointer for pagination. ' +
    'Suited for public-domain books, documents, scanned periodicals, and transcripts. ' +
    'Use max_chars and char_offset to page through long documents. Use ia_get_item first to confirm ' +
    'the item has a text file and to find its mediatype.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    identifier: z
      .string()
      .describe(
        'Internet Archive item identifier, e.g. "pg1342" (Pride and Prejudice). ' +
          'Obtain from ia_search_items results.',
      ),
    max_chars: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Maximum number of characters to return in this response. Defaults to the server-configured ' +
          'maximum (IA_MAX_SNAPSHOT_CHARS, typically 50 000). Lower values reduce token usage.',
      ),
    char_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Character offset to start reading from (default 0). ' +
          'To read the next page, add max_chars to the previous char_offset.',
      ),
  }),

  output: z.object({
    text: z.string().describe('The text slice starting at char_offset up to max_chars characters.'),
    total_chars: z.number().describe('Total character count of the full text file.'),
    char_offset: z.number().describe('Character offset used for this response.'),
    max_chars: z.number().describe('Maximum characters returned in this response.'),
    has_more: z
      .boolean()
      .describe(
        'True when there is more text beyond this slice. Increment char_offset by max_chars to read the next page.',
      ),
    source_file: z.string().describe('Filename of the source text file fetched from the item.'),
  }),

  errors: [
    {
      reason: 'item_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The identifier does not exist in the Internet Archive.',
      recovery:
        'Verify the identifier using ia_search_items or check the Internet Archive website.',
    },
    {
      reason: 'no_text_file',
      code: JsonRpcErrorCode.NotFound,
      when: 'The item exists but contains no readable text file (DjVuTXT or plain-text).',
      recovery:
        'Use ia_get_item to review the file manifest and find an alternative format for download.',
    },
    {
      reason: 'download_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Access to this item is restricted — it is in a login-required or limited collection.',
      recovery:
        'This item requires login or is in a restricted collection; access via the Archive website directly.',
    },
  ],

  async handler(input, ctx) {
    const svc = getArchiveMetadataService();
    const cfg = getServerConfig();
    const maxChars = input.max_chars ?? cfg.maxSnapshotChars;
    const charOffset = input.char_offset;

    const result = await svc.getTextContent(input.identifier.trim(), maxChars, charOffset, ctx);

    ctx.log.info('Text content retrieved', {
      identifier: input.identifier,
      sourceFile: result.sourceFile,
      totalChars: result.totalChars,
      sliceChars: result.text.length,
    });

    const hasMore = charOffset + maxChars < result.totalChars;

    return {
      text: result.text,
      total_chars: result.totalChars,
      char_offset: charOffset,
      max_chars: maxChars,
      has_more: hasMore,
      source_file: result.sourceFile,
    };
  },

  format: (result) => {
    const nextOffset = result.char_offset + result.max_chars;
    const lines: string[] = [
      `**Source:** ${result.source_file}`,
      `**Max Chars:** ${result.max_chars.toLocaleString()} | **Offset:** ${result.char_offset.toLocaleString()} / ${result.total_chars.toLocaleString()} chars${result.has_more ? ` — more follows (next offset: ${nextOffset.toLocaleString()})` : ' — end of document'}`,
      '',
      '---',
      '',
      result.text,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
