/**
 * @fileoverview An `identifier` or `collection` value read as the Internet Archive item it
 * names: a bare identifier, or an archive.org item URL with the file a download, stream, or
 * storage-node URL points at.
 * @module services/archive-metadata/item-reference
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';

/** The archive.org path an item URL names it by: `/<route>/<identifier>`, or a storage node's `/<n>/items/<identifier>`. */
export type ItemRoute = 'details' | 'download' | 'embed' | 'metadata' | 'stream' | 'storage';

/** What an `identifier` or `collection` value names. */
export type ItemReference =
  | {
      kind: 'item';
      identifier: string;
      /** The URL form the identifier was read from; absent for a bare identifier. */
      route?: ItemRoute;
      /** The file a download, stream, or storage-node URL names, percent-decoded. */
      file?: string;
    }
  | { kind: 'wayback' }
  | {
      kind: 'unrecognized';
      /** The host of an `http(s)://` URL that names no item. */
      host?: string;
    };

/** Hosts whose `/<route>/<identifier>` paths name an item. */
const ITEM_HOSTS = new Set(['archive.org', 'www.archive.org']);

const ROUTES = new Map<string, ItemRoute>(
  (['details', 'download', 'embed', 'metadata', 'stream'] as const).map((r) => [r, r]),
);

/** Routes whose path past the identifier names a file of the item. */
const FILE_ROUTES = new Set<ItemRoute>(['download', 'stream', 'storage']);

/** A storage node's number in `/<n>/items/<identifier>`. */
const NODE_NUMBER = /^[0-9]+$/;

/** A path segment percent-decoded, or as given when it holds a `%` that starts no escape. */
const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * What `value` names. A value with no `/` or `:` is a bare identifier, unchanged: identifiers
 * hold only letters, digits, `.`, `_`, `-`, and a leading `@`. Otherwise it is parsed as a URL
 * (WHATWG `URL`, with `https://` supplied when it has no scheme): an `http(s)` URL on
 * `archive.org` or `www.archive.org` whose path is `/details`, `/download`, `/embed`,
 * `/metadata`, or `/stream` followed by the identifier, or a storage-node URL
 * (`<node>.archive.org/<n>/items/<identifier>`), names that item; any further path names a file
 * for the download, stream, and storage-node forms (each segment percent-decoded, rejoined with
 * `/`) and is dropped for the others, as are the query and fragment. A `web.archive.org/web/…`
 * URL is a Wayback capture; anything else is unrecognized. Linear in the length of `value`.
 */
export function parseItemReference(value: string): ItemReference {
  if (!value.includes('/') && !value.includes(':')) return { kind: 'item', identifier: value };
  const explicit = URL.parse(value);
  const url = explicit ?? URL.parse(`https://${value}`);
  if (url?.protocol !== 'https:' && url?.protocol !== 'http:') return { kind: 'unrecognized' };
  const host = url.hostname;
  const [, first = '', second = '', third = '', ...rest] = url.pathname.split('/');

  let route: ItemRoute | undefined;
  let identifier = '';
  let fileSegments: string[] = [];
  if (host === 'web.archive.org') {
    if (first === 'web') return { kind: 'wayback' };
  } else if (ITEM_HOSTS.has(host)) {
    route = ROUTES.get(first);
    identifier = second;
    fileSegments = [third, ...rest];
  } else if (host.endsWith('.archive.org') && NODE_NUMBER.test(first) && second === 'items') {
    route = 'storage';
    identifier = third;
    fileSegments = rest;
  }
  if (!route || !identifier) return { kind: 'unrecognized', ...(explicit && { host }) };

  const file = FILE_ROUTES.has(route) ? fileSegments.map(decodeSegment).join('/') : '';
  return { kind: 'item', identifier: decodeSegment(identifier), route, ...(file && { file }) };
}

/** The recovery for a Wayback capture URL: the tool that reads one, and the inputs it takes. */
const WAYBACK_HINT =
  "Read a Wayback Machine capture with ia_get_snapshot: pass the archived page's URL as url and the capture timestamp (the digits after /web/) as timestamp.";

/**
 * The item `value` names (`parseItemReference`), or `invalid_identifier` (InvalidParams) before
 * any request: a Wayback capture URL with a hint naming `ia_get_snapshot`, anything else with
 * the calling definition's recovery. The message never echoes `value`, which may be a URL
 * carrying credentials; it names the host of an `http(s)` URL.
 */
export function requireItemReference(
  value: string,
  ctx: Context,
): Extract<ItemReference, { kind: 'item' }> {
  const ref = parseItemReference(value);
  if (ref.kind === 'item') return ref;
  const message =
    ref.kind === 'wayback'
      ? 'identifier is a Wayback Machine capture URL, not an Internet Archive item identifier or item URL.'
      : ref.host
        ? `identifier is a URL on ${ref.host} that names no Internet Archive item.`
        : 'identifier is neither an Internet Archive item identifier, which holds no "/" or ":", nor an archive.org item URL.';
  throw invalidParams(message, {
    reason: 'invalid_identifier',
    ...ctx.recoveryFor('invalid_identifier'),
    ...(ref.kind === 'wayback' && { recovery: { hint: WAYBACK_HINT } }),
  });
}
