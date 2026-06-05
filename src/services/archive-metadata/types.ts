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
  description?: string;
  identifier: string;
  language?: string;
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

/** Text content retrieved from a text item. */
export interface TextContent {
  /** Character offset used for this slice. */
  charOffset: number;
  /** Maximum characters returned in this slice. */
  maxChars: number;
  /** Name of the source file fetched. */
  sourceFile: string;
  /** Extracted text slice. */
  text: string;
  /** Total character count of the full text file. */
  totalChars: number;
}
