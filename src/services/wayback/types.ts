/**
 * @fileoverview Domain types for the Wayback Machine service.
 * @module services/wayback/types
 */

/** A single CDX capture record. */
export interface CdxRecord {
  /** SHA-1 digest of the content. */
  digest: string;
  /** Content length in bytes (may be missing for older records). */
  length?: string;
  /** MIME type of the captured content. */
  mimetype: string;
  /** Original URL as captured. */
  original: string;
  /** HTTP status code returned at capture time. */
  statuscode: string;
  /** Wayback timestamp in YYYYMMDDHHMMSS format. */
  timestamp: string;
}

/** The capture nearest a requested timestamp, from the Availability API or the CDX fallback. */
export interface ClosestSnapshot {
  /** Replay URL of the capture on https://web.archive.org. */
  snapshotUrl: string;
  /** HTTP status at capture time (`-` for a CDX revisit record). */
  status: string;
  /** Timestamp of the capture in YYYYMMDDHHMMSS format. */
  timestamp: string;
}

/** Paginated CDX history result. */
export interface CdxHistoryResult {
  /** CDX records for this page. */
  records: CdxRecord[];
  /** Opaque resume key for fetching the next page, if more records exist. */
  resumeKey?: string;
}

/** Fetched snapshot content. */
export interface SnapshotContent {
  /** Replay URL of the capture Wayback served — where the fetch ended after any redirect. */
  replayUrl: string;
  /** HTTP status Wayback replayed the served capture with. */
  status: string;
  /** Plain text extracted from the archived HTML. */
  text: string;
  /** Capture timestamp (YYYYMMDDHHMMSS) read from `replayUrl`, when it carries one. */
  timestamp?: string | undefined;
  /** Set when the body ran past the read ceiling: the text comes from this many leading bytes. */
  truncatedAtBytes?: number | undefined;
}
