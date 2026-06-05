/**
 * @fileoverview Tool for retrieving full metadata and file manifest for an Archive item.
 * @module mcp-server/tools/definitions/ia-get-item
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

export const iaGetItem = tool('ia_get_item', {
  title: 'Get Internet Archive Item',
  description:
    'Retrieve full metadata and the complete file manifest for an Internet Archive item by identifier. ' +
    'Returns title, creator, description, subjects, collections, license, language, and every file ' +
    'with its format, size, and direct download URL. The primary tool to act on a search result ' +
    'from ia_search_items. Use ia_get_text to retrieve the readable text of a text item.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    identifier: z
      .string()
      .describe(
        'Internet Archive item identifier, e.g. "pg1342" (Pride and Prejudice) or ' +
          '"UndergraduateMathematics". Obtain from ia_search_items results.',
      ),
  }),

  output: z.object({
    identifier: z.string().describe('The item identifier.'),
    title: z.string().optional().describe('Item title when provided by the metadata.'),
    creator: z
      .union([
        z.string().describe('Single creator name.'),
        z.array(z.string().describe('Creator name.')).describe('Multiple creator names.'),
      ])
      .optional()
      .describe('Creator or author name(s) when provided.'),
    description: z
      .union([
        z.string().describe('Single description string.'),
        z
          .array(z.string().describe('Description string.'))
          .describe('Multiple description strings.'),
      ])
      .optional()
      .describe('Item description when provided.'),
    mediatype: z.string().optional().describe('Media type (texts, audio, movies, etc.).'),
    date: z.string().optional().describe('Publication or upload date when provided.'),
    subject: z
      .union([
        z.string().describe('Single subject tag.'),
        z.array(z.string().describe('Subject tag.')).describe('Multiple subject tags.'),
      ])
      .optional()
      .describe('Subject or topic tag(s) when provided.'),
    collection: z
      .union([
        z.string().describe('Single collection identifier.'),
        z
          .array(z.string().describe('Collection identifier.'))
          .describe('Multiple collection identifiers.'),
      ])
      .optional()
      .describe('Collection(s) this item belongs to when provided.'),
    licenseurl: z.string().optional().describe('License URL when provided.'),
    rights: z.string().optional().describe('Rights statement when provided.'),
    language: z.string().optional().describe('Language when provided.'),
    file_count: z.number().describe('Total number of files in the item manifest.'),
    files: z
      .array(
        z
          .object({
            name: z.string().describe('Filename relative to the item.'),
            format: z.string().optional().describe('File format (e.g., DjVuTXT, MP3, JPEG).'),
            size: z.string().optional().describe('File size in bytes.'),
            md5: z.string().optional().describe('MD5 checksum when provided.'),
            download_url: z.string().describe('Direct download URL for this file.'),
          })
          .describe('A single file in the item manifest.'),
      )
      .describe('Complete file manifest for the item.'),
  }),

  errors: [
    {
      reason: 'item_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The identifier does not exist in the Internet Archive.',
      recovery:
        'Verify the identifier using ia_search_items or check the Internet Archive website.',
    },
  ],

  async handler(input, ctx) {
    const svc = getArchiveMetadataService();
    const item = await svc.getItem(input.identifier.trim(), ctx);

    ctx.log.info('Item retrieved', {
      identifier: input.identifier,
      fileCount: item.files.length,
    });

    const meta = item.metadata;
    return {
      identifier: meta.identifier,
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.creator ? { creator: meta.creator } : {}),
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.mediatype ? { mediatype: meta.mediatype } : {}),
      ...(meta.date ? { date: meta.date } : {}),
      ...(meta.subject ? { subject: meta.subject } : {}),
      ...(meta.collection ? { collection: meta.collection } : {}),
      ...(meta.licenseurl ? { licenseurl: meta.licenseurl } : {}),
      ...(meta.rights ? { rights: meta.rights } : {}),
      ...(meta.language ? { language: meta.language } : {}),
      file_count: item.files.length,
      files: item.files.map((f) => ({
        name: f.name,
        download_url: f.downloadUrl,
        ...(f.format ? { format: f.format } : {}),
        ...(f.size ? { size: f.size } : {}),
        ...(f.md5 ? { md5: f.md5 } : {}),
      })),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.title ?? result.identifier}`);
    lines.push(`**Identifier:** ${result.identifier}`);
    if (result.mediatype) lines.push(`**Media Type:** ${result.mediatype}`);
    if (result.creator) {
      const creators = Array.isArray(result.creator) ? result.creator.join(', ') : result.creator;
      lines.push(`**Creator:** ${creators}`);
    }
    if (result.date) lines.push(`**Date:** ${result.date}`);
    if (result.language) lines.push(`**Language:** ${result.language}`);
    if (result.subject) {
      const subjects = Array.isArray(result.subject) ? result.subject.join(', ') : result.subject;
      lines.push(`**Subjects:** ${subjects}`);
    }
    if (result.collection) {
      const cols = Array.isArray(result.collection)
        ? result.collection.join(', ')
        : result.collection;
      lines.push(`**Collection:** ${cols}`);
    }
    if (result.licenseurl) lines.push(`**License:** ${result.licenseurl}`);
    if (result.rights) lines.push(`**Rights:** ${result.rights}`);
    if (result.description) {
      const desc = Array.isArray(result.description)
        ? result.description.join(' ')
        : result.description;
      lines.push('');
      lines.push(`**Description:** ${desc}`);
    }
    lines.push('');
    lines.push(`**Files (${result.file_count}):**`);
    for (const f of result.files) {
      const meta = [
        f.format,
        f.size ? `${f.size} bytes` : undefined,
        f.md5 ? `md5:${f.md5}` : undefined,
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`- **${f.name}**${meta ? ` (${meta})` : ''}: ${f.download_url}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
