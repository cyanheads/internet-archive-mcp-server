/**
 * @fileoverview A Wayback Machine capture URL in `url` — `web.archive.org/web/<timestamp>/<original>`,
 * the form of the `replay_url` both Wayback tools return — read as the URL it archives and its
 * timestamp, together with the tool's own `timestamp`, before any request is sent; the
 * original URL a capture URL names, for a replay redirect's target or the capture served;
 * and the URL an `href` on a replayed page names, for the page's links.
 * @module services/wayback/wayback-capture-url
 */

import { TIMESTAMP_FORMS, waybackTimestamp } from './wayback-timestamp.js';

/** Hosts that serve Wayback Machine captures under `/web/`; `wayback.archive.org` redirects to `web.archive.org`. */
export const WAYBACK_HOSTS: ReadonlySet<string> = new Set([
  'web.archive.org',
  'wayback.archive.org',
]);

/** `url` and `timestamp` read together: the lookup they name, or why they name none. */
export type CaptureTarget =
  | {
      kind: 'target';
      /** The URL to look up: a capture URL's original, or `url` as given. */
      url: string;
      /** 1–14 Wayback digits, or undefined for the latest capture. */
      timestamp: string | undefined;
    }
  | {
      kind: 'invalid_timestamp';
      field: 'url' | 'timestamp';
      message: string;
      /** The recovery for a capture URL's own timestamp, replacing the tool's declared one. */
      hint?: string;
    }
  | { kind: 'ambiguous_timestamp'; message: string };

/** `http://` or `https://`, any case. */
const SCHEME = /^https?:\/\//i;

/**
 * A capture's path up to its original URL: `/web/`, the timestamp digits, an optional replay
 * modifier (`id_`, `if_`, `im_`, …), and `/`. Calendar (`/web/*`, `/web/2020*`), timegate
 * (`/web/<url>`), and timemap (`/web/timemap/…`) paths name no single capture and do not match.
 */
const CAPTURE_PATH = /^\/web\/(\d+)(?:[a-z]{2}_)?\//;

/** An original whose scheme is percent-encoded, as `https%3A%2F%2Fexample.com%2F`. */
const ENCODED_SCHEME = /^https?%3A%2F%2F/i;

const URL_TIMESTAMP_HINT =
  'Correct the digits after /web/ in the capture URL to a real date and time, or pass the URL it archives as url.';

/**
 * The Wayback capture `value` names, read from the raw string — never a parsed `URL`, which
 * resolves dot segments and splits off the query the original keeps. `digits` are as written;
 * `original` is everything after the capture path, decoded once when its scheme is
 * percent-encoded. Undefined for anything that is not a capture URL on a `WAYBACK_HOSTS` host.
 */
export function captureOf(value: string): { digits: string; original: string } | undefined {
  const rest = value.replace(SCHEME, '');
  const slash = rest.indexOf('/');
  if (slash < 0 || !WAYBACK_HOSTS.has(rest.slice(0, slash).toLowerCase())) return;
  const path = rest.slice(slash);
  const match = CAPTURE_PATH.exec(path);
  const digits = match?.[1];
  const original = match ? path.slice(match[0].length) : '';
  if (!digits || !original) return;
  return { digits, original: ENCODED_SCHEME.test(original) ? decodeOnce(original) : original };
}

/** The origin replays are served from, which a root-relative `/web/` href on a replay names. */
const WAYBACK_ORIGIN = 'https://web.archive.org';

/**
 * The URL an `href` on a replayed page names, as the archived page meant it, any scheme and
 * its fragment kept; undefined when it does not parse. Tabs and line breaks are removed and
 * the ends trimmed, as a URL parser does. An href Wayback rewrote — a root-relative
 * `/web/<timestamp>/…`, or an absolute or protocol-relative URL on a `WAYBACK_HOSTS` host,
 * that `captureOf` reads — names the original inside it, read once, so a link to an
 * archived copy keeps that copy's capture URL and a rewritten `mailto:` reads as one again.
 * Any other href, a `/web/` path naming no capture included, resolves against `base`.
 */
export function hrefTarget(href: string, base: URL | undefined): URL | undefined {
  const value = href.replace(/[\t\n\r]/g, '').trim();
  const absolute = value.startsWith('/web/')
    ? `${WAYBACK_ORIGIN}${value}`
    : value.startsWith('//')
      ? `https:${value}`
      : value;
  const capture = SCHEME.test(absolute) ? captureOf(absolute) : undefined;
  return (capture ? URL.parse(capture.original) : URL.parse(value, base)) ?? undefined;
}

/** `text` percent-decoded once, or as given when it holds a `%` that starts no escape. */
function decodeOnce(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * What `url` and `timestamp` look up, checked before any request. A Wayback capture URL —
 * `http://`, `https://`, or no scheme; a `WAYBACK_HOSTS` host in any case;
 * `/web/<digits>[<modifier>_]/<original>` — reads as its original URL at its own timestamp,
 * which fills a blank or omitted `timestamp`; any other `url` is looked up as given.
 *
 * `invalid_timestamp` names `url` when a capture URL's digits are no Wayback timestamp
 * (`waybackTimestamp`), and `timestamp` when it is not blank and is none either.
 * `ambiguous_timestamp` when both name a timestamp and their digit forms differ: a prefix of
 * the capture's timestamp names a period, not that capture. Linear in the length of both.
 */
export function readCaptureTarget(url: string, timestamp?: string): CaptureTarget {
  const capture = captureOf(url);
  const embedded = capture && waybackTimestamp(capture.digits);
  if (capture && embedded === undefined) {
    return {
      kind: 'invalid_timestamp',
      field: 'url',
      message: `url is a Wayback capture URL whose timestamp, ${capture.digits}, is not 1–14 digits (YYYYMMDDHHMMSS or a prefix of it) naming a real Gregorian date and time.`,
      hint: URL_TIMESTAMP_HINT,
    };
  }
  const text = timestamp?.trim();
  const explicit = text ? waybackTimestamp(text) : undefined;
  if (text && explicit === undefined) {
    return {
      kind: 'invalid_timestamp',
      field: 'timestamp',
      message: `timestamp must be ${TIMESTAMP_FORMS}.`,
    };
  }
  if (!capture) return { kind: 'target', url, timestamp: explicit };
  if (explicit !== undefined && explicit !== embedded) {
    return {
      kind: 'ambiguous_timestamp',
      message: `url is a Wayback capture URL naming ${capture.original} at ${embedded}, and timestamp names a different timestamp, ${explicit}.`,
    };
  }
  return { kind: 'target', url: capture.original, timestamp: embedded };
}
