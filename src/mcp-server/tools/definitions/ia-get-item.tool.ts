/**
 * @fileoverview Tool for retrieving metadata and a paged, format-filterable file manifest for an Archive item.
 * @module mcp-server/tools/definitions/ia-get-item
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { pushItemHeading, pushLabelledField } from '@/mcp-server/tools/labelled-field.js';
import { getArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';
import { requireItemReference } from '@/services/archive-metadata/item-reference.js';
import { startCallDeadline } from '@/services/call-deadline.js';

/** Files returned per call. A larger `max_files` is served at this cap. */
const MAX_FILES_CAP = 500;

/** The largest `max_files` accepted: above the largest manifest measured (288,113 files). */
const MAX_FILES_CEILING = 300_000;

/**
 * A license value as a link labelled with itself when it is an absolute http(s) URL, the one
 * form `markdownLink` links; any other value once as literal text, where `markdownLink` would
 * write it twice as `value (value)`.
 */
const urlLink = (url: string): string => {
  const protocol = /[\r\n]/.test(url) ? undefined : URL.parse(url)?.protocol;
  return protocol === 'http:' || protocol === 'https:'
    ? markdownLink(url, url)
    : escapeMarkdownInline(url);
};

export const iaGetItem = tool('ia_get_item', {
  title: 'Get Internet Archive Item',
  description:
    'Retrieve metadata and the file manifest for an Internet Archive item by identifier. Returns title, creator, description (as plain text), the publication date, when the item was made public and when it was added to the Archive, subjects, collections, license, language, publisher, ISBN, OCLC and LCCN numbers, Open Library edition and work IDs, volume, the running time of an audio or video item, the page-image count of a text item, whether the item is access-restricted, the total file count, and a page of files, each with its format, size, and direct download URL, and for an audio or video file the track title, track number, and duration it is catalogued with; a file marked private cannot be downloaded. Pages hold up to max_files files (default 50, at most 500 per call) starting at file_offset; set format to keep a single file type (e.g. "DjVuTXT", "Text PDF", "VBR MP3"). The primary tool to act on a search result from ia_search_items. Use ia_get_text to retrieve the readable text of a text item.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    identifier: z
      .string()
      .trim()
      .min(1, 'Must not be blank — provide an item identifier from ia_search_items.')
      .describe(
        'Internet Archive item identifier, e.g. "prideprejudice00aust" (Pride and Prejudice), from ia_search_items results; or an archive.org item URL, such as https://archive.org/details/prideprejudice00aust or its download, stream, metadata, or embed form, read as the identifier it names.',
      ),
    format: z
      .string()
      .optional()
      .describe(
        'Keep only files whose format equals this value, ignoring case — e.g. "DjVuTXT", "Text PDF", "VBR MP3". Applied before paging. Omit to list every format.',
      ),
    max_files: z
      .number()
      .int()
      .min(1)
      .max(MAX_FILES_CEILING)
      .default(50)
      .describe(
        'Maximum number of files to return (default 50). One call returns at most 500: a larger value (up to 300,000) is served as 500, with a notice naming the next file_offset.',
      ),
    file_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based position in the (format-filtered) file list to start from (default 0). To read the next page, add the number of files returned to the previous file_offset, or pass the file_offset the notice names.',
      ),
  }),

  output: z.object({
    identifier: z.string().describe('The item identifier.'),
    title: z
      .union([
        z.string().describe('Single title.'),
        z.array(z.string().describe('Title value.')).describe('Multiple title values.'),
      ])
      .optional()
      .describe('Item title when provided; a few records carry a list, relayed as received.'),
    creator: z
      .union([
        z.string().describe('Single creator name.'),
        z.array(z.string().describe('Creator name.')).describe('Multiple creator names.'),
      ])
      .optional()
      .describe('Creator or author name(s) when provided.'),
    description: z
      .union([
        z.string().describe('Single description, as plain text.'),
        z
          .array(z.string().describe('Description, as plain text.'))
          .describe('Multiple descriptions, each as plain text.'),
      ])
      .optional()
      .describe(
        'Item description when provided, converted from the HTML the Archive stores to plain text: <br> and each paragraph, div, or list item start a new line, existing line breaks are kept, and a link reads as its label followed by its URL in parentheses.',
      ),
    mediatype: z
      .union([
        z.string().describe('Single media type.'),
        z.array(z.string().describe('Media type.')).describe('Multiple media types.'),
      ])
      .optional()
      .describe('Media type (texts, audio, movies, etc.); a list is relayed as received.'),
    date: z
      .union([
        z.string().describe('Single date.'),
        z.array(z.string().describe('Date value.')).describe('Multiple date values.'),
      ])
      .optional()
      .describe(
        'Publication date when provided; a few records carry a list, relayed as received. For when the item reached the Archive, see publicdate and addeddate.',
      ),
    publicdate: z
      .union([
        z.string().describe('Single public date.'),
        z.array(z.string().describe('Public date.')).describe('Multiple public dates.'),
      ])
      .optional()
      .describe(
        'When the item was made public on the Archive, as the Metadata API stores it: "YYYY-MM-DD HH:MM:SS" in UTC; a list is relayed as received. Nearly every item has it, dated or not.',
      ),
    addeddate: z
      .union([
        z.string().describe('Single added date.'),
        z.array(z.string().describe('Added date.')).describe('Multiple added dates.'),
      ])
      .optional()
      .describe(
        'When the item was added to the Archive, as the Metadata API stores it: "YYYY-MM-DD HH:MM:SS" in UTC, or on some records a bare "YYYY-MM-DD"; a list is relayed as received.',
      ),
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
    licenseurl: z
      .union([
        z.string().describe('Single license URL.'),
        z.array(z.string().describe('License URL.')).describe('Multiple license URLs.'),
      ])
      .optional()
      .describe('License URL when provided; a few records carry a list, relayed as received.'),
    rights: z
      .union([
        z.string().describe('Single rights statement.'),
        z.array(z.string().describe('Rights statement.')).describe('Multiple rights statements.'),
      ])
      .optional()
      .describe('Rights statement when provided; a few records carry a list, relayed as received.'),
    language: z
      .union([
        z.string().describe('Single language.'),
        z.array(z.string().describe('Language.')).describe('Multiple languages.'),
      ])
      .optional()
      .describe('Language(s) of the item when provided.'),
    publisher: z
      .union([
        z.string().describe('Single publisher statement.'),
        z
          .array(z.string().describe('Publisher statement.'))
          .describe('Multiple publisher statements.'),
      ])
      .optional()
      .describe(
        'Publisher statement (e.g. "London : George Allen") when provided; a few records carry a list, relayed as received.',
      ),
    volume: z
      .union([
        z.string().describe('Single volume designation.'),
        z
          .array(z.string().describe('Volume designation.'))
          .describe('Multiple volume designations.'),
      ])
      .optional()
      .describe(
        'Volume designation when provided (e.g. "2", "v.6", "ser. 3, v. 10 (1912-16)"); a few records carry a list (e.g. ["1931", "18"]), relayed as received.',
      ),
    isbn: z
      .union([
        z.string().describe('Single ISBN.'),
        z.array(z.string().describe('ISBN.')).describe('Multiple ISBNs.'),
      ])
      .optional()
      .describe('ISBN(s) when provided, as catalogued.'),
    oclc_id: z
      .union([
        z.string().describe('Single OCLC number.'),
        z.array(z.string().describe('OCLC number.')).describe('Multiple OCLC numbers.'),
      ])
      .optional()
      .describe('OCLC (WorldCat) number(s) when provided.'),
    lccn: z
      .union([
        z.string().describe('Single LCCN.'),
        z.array(z.string().describe('LCCN.')).describe('Multiple LCCNs.'),
      ])
      .optional()
      .describe('Library of Congress Control Number(s) when provided.'),
    openlibrary_edition: z
      .union([
        z.string().describe('Single Open Library edition ID.'),
        z
          .array(z.string().describe('Open Library edition ID.'))
          .describe('Multiple Open Library edition IDs.'),
      ])
      .optional()
      .describe(
        'Open Library edition ID (e.g. "OL7173379M") when provided; a list is relayed as received.',
      ),
    openlibrary_work: z
      .union([
        z.string().describe('Single Open Library work ID.'),
        z
          .array(z.string().describe('Open Library work ID.'))
          .describe('Multiple Open Library work IDs.'),
      ])
      .optional()
      .describe(
        'Open Library work ID (e.g. "OL66554W") when provided; a list is relayed as received.',
      ),
    runtime: z
      .union([
        z.string().describe('Single running time.'),
        z.array(z.string().describe('Running time.')).describe('Multiple running times.'),
      ])
      .optional()
      .describe(
        'Total running time of an audio or video item as catalogued, e.g. "13:06:44", "20:33", or free text such as "27 min 13 sec"; a list is relayed as received.',
      ),
    image_count: z
      .number()
      .optional()
      .describe(
        'Number of scanned page images of a texts item, covers and calibration cards included — not a printed page count. Omitted for other media types, where the Archive counts something else.',
      ),
    access_restricted: z
      .literal(true)
      .optional()
      .describe(
        'Present when the item is in an access-restricted collection, such as a lending library. Whether a download is refused is per file: see each file’s private.',
      ),
    file_count: z
      .number()
      .describe('Total number of files in the full item manifest, before filtering and paging.'),
    files: z
      .array(
        z
          .object({
            name: z.string().describe('Filename relative to the item.'),
            title: z
              .string()
              .optional()
              .describe(
                'Track or chapter title of an audio or video file, as catalogued. Some derived copies, such as an Ogg made from an MP3, lack it.',
              ),
            track: z
              .string()
              .optional()
              .describe(
                'Track number as catalogued: "1", "01", or "1/37" (track of total); "0" on checksum and file-list files.',
              ),
            length: z
              .string()
              .optional()
              .describe(
                'Duration as catalogued: minutes and seconds ("06:21") or seconds ("381.1", "1133.07"). The copies of one recording can carry different values, so compare lengths within one format.',
              ),
            format: z.string().optional().describe('File format (e.g., DjVuTXT, MP3, JPEG).'),
            size: z.string().optional().describe('File size in bytes.'),
            md5: z.string().optional().describe('MD5 checksum when provided.'),
            private: z
              .literal(true)
              .optional()
              .describe(
                'Present when the manifest marks this file private: the Archive refuses its download, so ia_get_text cannot read it.',
              ),
            download_url: z.string().describe('Direct download URL for this file.'),
          })
          .describe('A single file in the item manifest.'),
      )
      .describe(
        'This page of the manifest in upstream order — up to max_files files (at most 500) from file_offset, after the format filter.',
      ),
  }),

  enrichment: {
    truncated: z.boolean().optional().describe('True when more files remain past this page.'),
    shown: z.number().optional().describe('Number of files returned on this page.'),
    cap: z
      .number()
      .optional()
      .describe('The page size applied: max_files, or 500 when a larger value was capped.'),
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

  enrichmentTrailer: {
    notice: { render: (value) => escapeMarkdownInline(String(value)) },
  },

  errors: [
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
      reason: 'item_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The identifier does not exist in the Internet Archive.',
      recovery:
        'Verify the identifier using ia_search_items or check the Internet Archive website.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'archive_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The Internet Archive Metadata API did not answer within the request timeout or the call's 55 s deadline (the request timeout when that is longer), could not be reached, answered HTTP 5xx after retries, 429, or another 4xx, or sent an unreadable response.",
      recovery:
        'The Internet Archive is temporarily unavailable or overloaded; retry in a few minutes.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const deadline = startCallDeadline(ctx.signal);
    const svc = getArchiveMetadataService();
    const { identifier } = requireItemReference(input.identifier, ctx);
    const item = await svc.getItem(identifier, ctx, deadline);

    const format = input.format?.trim();
    const matched = format
      ? item.files.filter((f) => f.format?.toLowerCase() === format.toLowerCase())
      : item.files;
    const maxFiles = Math.min(input.max_files, MAX_FILES_CAP);
    const page = matched.slice(input.file_offset, input.file_offset + maxFiles);
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
        `file_offset ${input.file_offset} is past the last of ${matched.length} ${format ? 'matching files' : 'files'}; use a file_offset below ${matched.length}.`,
      );
    }
    if (nextOffset < matched.length) {
      if (maxFiles < input.max_files) {
        notices.push(`max_files ${input.max_files} is above the cap of ${MAX_FILES_CAP} per call.`);
      }
      notices.push(
        `Showing files ${input.file_offset + 1}–${nextOffset} of ${matched.length}${format ? ' matching' : ''}. Pass file_offset: ${nextOffset} for the next page${format ? '.' : ', or set format to keep one file type.'}`,
      );
      ctx.enrich.truncated({
        shown: page.length,
        cap: maxFiles,
        guidance: notices.join(' '),
      });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    ctx.log.info('Item retrieved', {
      identifier,
      fileCount: item.files.length,
      matched: matched.length,
      returned: page.length,
    });

    // The service maps exactly the metadata and file fields the output declares, each omitted
    // when absent; only the download URL is renamed.
    return {
      ...item.metadata,
      file_count: item.files.length,
      files: page.map(({ downloadUrl, ...file }) => ({ ...file, download_url: downloadUrl })),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    pushItemHeading(lines, result.title, result.identifier, 1);
    const labelled: [label: string, value: string | string[] | undefined][] = [
      ['Identifier', result.identifier],
      ['Media Type', result.mediatype],
      ['Creator', result.creator],
      ['Date', result.date],
      ['Public Date', result.publicdate],
      ['Added Date', result.addeddate],
      ['Publisher', result.publisher],
      ['Volume', result.volume],
      ['Language', result.language],
      ['Subjects', result.subject],
      ['Collection', result.collection],
      ['ISBN', result.isbn],
      ['OCLC ID', result.oclc_id],
      ['LCCN', result.lccn],
      ['Open Library Edition', result.openlibrary_edition],
      ['Open Library Work', result.openlibrary_work],
      ['Runtime', result.runtime],
    ];
    for (const [label, value] of labelled) {
      if (value) pushLabelledField(lines, label, value);
    }
    if (result.image_count !== undefined) lines.push(`**Page Images:** ${result.image_count}`);
    if (result.licenseurl) pushLabelledField(lines, 'License', result.licenseurl, '', urlLink);
    if (result.rights) pushLabelledField(lines, 'Rights', result.rights);
    if (result.access_restricted) lines.push('**Access Restricted:** true');
    // A list of two or more values already ends with the blank line a new block needs.
    if (result.description) {
      if (lines.at(-1) !== '') lines.push('');
      pushLabelledField(lines, 'Description', result.description);
    }
    if (lines.at(-1) !== '') lines.push('');
    const count =
      result.files.length === result.file_count
        ? `${result.file_count}`
        : `showing ${result.files.length} of ${result.file_count} in the manifest`;
    lines.push(`**Files (${count}):**`);
    // An audio or video file's catalogued details, in render order.
    const details = [
      ['title', 'Title'],
      ['track', 'Track'],
      ['length', 'Length'],
    ] as const;
    for (const f of result.files) {
      const meta = [
        f.format,
        f.size ? `${f.size} bytes` : undefined,
        f.md5 ? `md5:${f.md5}` : undefined,
        f.private ? 'private' : undefined,
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `- **${escapeMarkdownInline(f.name)}**${meta ? ` (${escapeMarkdownInline(meta)})` : ''}: ${markdownLink(f.download_url, f.download_url)}`,
      );
      // One nested item per detail, so a title holding a comma or a line break keeps its bounds.
      for (const [key, label] of details) {
        const value = f[key];
        if (value) lines.push(`  - **${label}:** ${escapeMarkdownInline(value)}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
