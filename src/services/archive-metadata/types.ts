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
  /** File size in bytes (as string from the API). */
  size?: string;
}

/** Full metadata for an Archive item. */
export interface ArchiveItemMetadata {
  collection?: string | string[];
  creator?: string | string[];
  date?: string;
  description?: string | string[];
  identifier: string;
  language?: string | string[];
  licenseurl?: string;
  mediatype?: string;
  rights?: string;
  subject?: string | string[];
  title?: string;
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
