/**
 * @fileoverview Tool for retrieving metadata and a paged, format-filterable file manifest for an Archive item.
 * @module mcp-server/tools/definitions/ia-get-item
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

export const iaGetItem = tool('ia_get_item', {
  title: 'Get Internet Archive Item',
  description:
    'Retrieve metadata and the file manifest for an Internet Archive item by identifier. ' +
    'Returns title, creator, description, subjects, collections, license, language, the total ' +
    'file count, and a page of files, each with its format, size, and direct download URL. ' +
    'Pages hold up to max_files files (default 50) starting at file_offset; set format to keep ' +
    'a single file type (e.g. "DjVuTXT", "Text PDF", "VBR MP3"). The primary tool to act on a ' +
    'search result from ia_search_items. Use ia_get_text to retrieve the readable text of a text item.',
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
    format: z
      .string()
      .optional()
      .describe(
        'Keep only files whose format equals this value, ignoring case — e.g. "DjVuTXT", ' +
          '"Text PDF", "VBR MP3". Applied before paging. Omit to list every format.',
      ),
    max_files: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe('Maximum number of files to return (1–500, default 50).'),
    file_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based position in the (format-filtered) file list to start from (default 0). ' +
          'To read the next page, add max_files to the previous file_offset.',
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
    language: z
      .union([
        z.string().describe('Single language.'),
        z.array(z.string().describe('Language.')).describe('Multiple languages.'),
      ])
      .optional()
      .describe('Language(s) of the item when provided.'),
    file_count: z
      .number()
      .describe('Total number of files in the full item manifest, before filtering and paging.'),
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
      .describe(
        'This page of the manifest in upstream order — up to max_files files from file_offset, ' +
          'after the format filter.',
      ),
  }),

  enrichment: {
    truncated: z.boolean().optional().describe('True when more files remain past this page.'),
    shown: z.number().optional().describe('Number of files returned on this page.'),
    cap: z.number().optional().describe('The max_files cap that was applied.'),
    totalCount: z
      .number()
      .optional()
      .describe('Number of files matching the format filter, before paging.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Paging guidance with the next file_offset, or the formats present when the filter matched nothing.',
      ),
  },

  errors: [
    {
      reason: 'item_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The identifier does not exist in the Internet Archive.',
      recovery:
        'Verify the identifier using ia_search_items or check the Internet Archive website.',
      severity: 'warning',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getArchiveMetadataService();
    const item = await svc.getItem(input.identifier, ctx);

    const format = input.format?.trim();
    const matched = format
      ? item.files.filter((f) => f.format?.toLowerCase() === format.toLowerCase())
      : item.files;
    const page = matched.slice(input.file_offset, input.file_offset + input.max_files);
    const nextOffset = input.file_offset + page.length;

    /** Notice segments from every source, flushed once — `notice` is last-wins. */
    const notices: string[] = [];
    if (format) {
      ctx.enrich.total(matched.length);
      if (matched.length === 0) {
        const present = [...new Set(item.files.flatMap((f) => (f.format ? [f.format] : [])))];
        notices.push(
          present.length > 0
            ? `No files have format "${format}". Formats in this item: ${present.join(', ')}.`
            : `No files have format "${format}"; no file in this item declares a format.`,
        );
      }
    }
    if (matched.length > 0 && input.file_offset >= matched.length) {
      notices.push(
        `file_offset ${input.file_offset} is past the last of ${matched.length} ` +
          `${format ? 'matching files' : 'files'}; use a file_offset below ${matched.length}.`,
      );
    }
    if (nextOffset < matched.length) {
      notices.push(
        `Showing files ${input.file_offset + 1}–${nextOffset} of ${matched.length}` +
          `${format ? ' matching' : ''}. Pass file_offset: ${nextOffset} for the next page` +
          `${format ? '.' : ', or set format to keep one file type.'}`,
      );
      ctx.enrich.truncated({
        shown: page.length,
        cap: input.max_files,
        guidance: notices.join(' '),
      });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    ctx.log.info('Item retrieved', {
      identifier: input.identifier,
      fileCount: item.files.length,
      matched: matched.length,
      returned: page.length,
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
      files: page.map((f) => ({
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
    if (result.language) {
      const languages = Array.isArray(result.language)
        ? result.language.join(', ')
        : result.language;
      lines.push(`**Language:** ${languages}`);
    }
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
    const count =
      result.files.length === result.file_count
        ? `${result.file_count}`
        : `showing ${result.files.length} of ${result.file_count} in the manifest`;
    lines.push(`**Files (${count}):**`);
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
