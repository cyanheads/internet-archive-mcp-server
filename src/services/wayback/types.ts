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

/** Result from the Wayback Availability API. */
export interface AvailabilityResult {
  /** Resolved snapshot URL on web.archive.org. */
  snapshotUrl: string;
  /** HTTP status at capture time. */
  status: string;
  /** Timestamp of the nearest snapshot in YYYYMMDDHHMMSS format. */
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
  /** Canonical replay URL used to fetch the content. */
  replayUrl: string;
  /** Plain text extracted from the archived HTML. */
  text: string;
}
