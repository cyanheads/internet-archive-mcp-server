/**
 * @fileoverview Domain types for the Archive Metadata service.
 * @module services/archive-metadata/types
 */

/** A single file in an Archive item's manifest. */
export interface ArchiveFile {
  /** Direct download URL. */
  downloadUrl: string;
  /** File format (e.g., "DjVuTXT", "Text", "JPEG", "MP3"). */
  format?: string;
  /** MD5 checksum. */
  md5?: string;
  /** Filename relative to the item. */
  name: string;
  /** Present when the manifest marks the file `private: "true"`: the Archive refuses its download. */
  private?: true;
  /** File size in bytes (as string from the API). */
  size?: string;
}

/**
 * Full metadata for an Archive item, keyed by the `ia_get_item` and `ia://item` output
 * names; each is omitted when the record lacks it. A `string | string[]` field is relayed
 * as the API sent it — `title`, `date`, and `publisher` are documented as single-valued
 * but arrive as lists on a few records.
 */
export interface ArchiveItemMetadata {
  /** Present when `access-restricted-item` is `"true"`, the only value the Archive sets. */
  access_restricted?: true;
  collection?: string | string[];
  creator?: string | string[];
  date?: string | string[];
  /** Plain-text lines converted from the stored HTML (`descriptionToText`). */
  description?: string | string[];
  identifier: string;
  /** `imagecount` of a `texts` item: scanned page images, covers and calibration cards included. */
  image_count?: number;
  isbn?: string | string[];
  language?: string | string[];
  lccn?: string | string[];
  licenseurl?: string;
  mediatype?: string;
  /** OCLC number(s), from the `oclc-id` key. */
  oclc_id?: string | string[];
  openlibrary_edition?: string;
  openlibrary_work?: string;
  publisher?: string | string[];
  rights?: string;
  subject?: string | string[];
  title?: string | string[];
  volume?: string;
}

/** Full item with metadata and file manifest. */
export interface ArchiveItem {
  files: ArchiveFile[];
  metadata: ArchiveItemMetadata;
}

/** One page of text read from a text item. Offsets and lengths count UTF-16 code units. */
export interface TextContent {
  /** Character offset used for this slice. */
  charOffset: number;
  /** Why efficient continuation is unavailable; offset pagination remains usable. */
  continuationNotice?: string;
  /** True when the file holds text past the end of this slice. */
  hasMore: boolean;
  /** Maximum characters returned in this slice. */
  maxChars: number;
  /** Opaque tenant-scoped token for the next page, when available. */
  nextContinuation?: string;
  /** Name of the source file fetched. */
  sourceFile: string;
  /** Size of the source file in bytes, from the manifest; absent when the manifest has none. */
  sourceFileBytes?: number;
  /** Extracted text slice. */
  text: string;
}
