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

/** The capture nearest a requested timestamp, or the latest one when none is given, from the Availability API or the CDX fallback. */
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
  /** True only when an exact collapsed lookahead proves no further captures remain. */
  complete?: boolean;
  /** Continuation limitations, including legacy collapsed paging. */
  notice?: string;
  /** CDX records for this page. */
  records: CdxRecord[];
  /** Opaque resume key for fetching the next page, if more records exist. */
  resumeKey?: string;
}

/**
 * An archived redirect a replay passed through: a capture of the 3xx the site itself sent,
 * which Wayback replays with that status and the capture's `Memento-Datetime`.
 */
export interface ArchivedRedirect {
  /**
   * Timestamp (YYYYMMDDHHMMSS) of the redirect capture, from its `Memento-Datetime`; the header
   * as sent when it is not an HTTP date.
   */
  captureTimestamp: string;
  /** The HTTP status the site redirected with when it was captured. */
  status: number;
  /** Where it points: the original URL of the Wayback capture URL in its `Location`. */
  target: string;
}

/**
 * How a replay's redirects ended without a readable capture. The first three follow an
 * archived redirect and concern its target: Wayback has not archived it (a 404 with no
 * `Memento-Datetime`), its capture is an archived error page, or Wayback refused to replay
 * it. The rest can end any chain: a `Location` already requested, a redirect past
 * `MAX_REPLAY_REDIRECTS`, a 3xx with no `Location`, or one that is unparseable, not http(s),
 * or off the Wayback hosts.
 * `captureTimestamp` is set when the 3xx that ended the chain is itself an archived redirect.
 */
export type RedirectDeadEnd =
  | { kind: 'not_archived' }
  | { kind: 'archived_error'; status: number; captureTimestamp: string }
  | { kind: 'refused'; status: number }
  | { kind: 'loop'; url: string }
  | { kind: 'too_many_redirects' }
  | { kind: 'no_location'; status: number; captureTimestamp?: string }
  | { kind: 'bad_location'; status: number; location: string; captureTimestamp?: string };

/** Fetched snapshot content. */
export interface SnapshotContent {
  /**
   * The archived redirects the replay followed to the served capture, in order; absent when
   * it passed through none. Wayback's own redirects to a nearest capture are not listed.
   */
  redirects?: ArchivedRedirect[] | undefined;
  /** Replay URL of the capture Wayback served — where the replay's redirects ended. */
  replayUrl: string;
  /** HTTP status Wayback replayed the served capture with. */
  status: string;
  /**
   * The capture's whole text, read from at most `REPLAY_BYTE_CEILING` bytes: an HTML page
   * stripped to plain text, or another text type's body as archived.
   */
  text: string;
  /** Capture timestamp (YYYYMMDDHHMMSS) read from `replayUrl`, when it carries one. */
  timestamp?: string | undefined;
  /** Set when the body ran past the read ceiling: the text comes from this many leading bytes. */
  truncatedAtBytes?: number | undefined;
}
