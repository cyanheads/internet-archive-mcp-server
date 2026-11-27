/**
 * @fileoverview Tool for fetching archived content of a URL at a specific Wayback timestamp.
 * @module mcp-server/tools/definitions/ia-get-snapshot
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdown, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { startCallDeadline } from '@/services/call-deadline.js';
import type { ArchivedRedirect, PageLink, RedirectDeadEnd } from '@/services/wayback/types.js';
import { captureOf, readCaptureTarget } from '@/services/wayback/wayback-capture-url.js';
import {
  getWaybackService,
  MAX_REPLAY_REDIRECTS,
  NOT_SERVED,
  NOT_SERVED_HINT,
  notServedMessage,
} from '@/services/wayback/wayback-service.js';

/**
 * `text` as a Markdown code span, so text from a `Location` header reads back exactly from
 * either surface of a notice. Error messages name it plainly: the framework escapes a message
 * for `content[]`.
 */
const code = (text: string): string => markdown().inlineCode(text).build();

/**
 * The archived redirects a replay followed, as the rest of a sentence about the first one's
 * capture: " at <timestamp> is an archived HTTP <status> redirect to <target>", each later one
 * joined as ", whose capture at …", with each target rendered by `name`.
 */
function redirectChain(
  redirects: readonly ArchivedRedirect[],
  name: (target: string) => string,
): string {
  return redirects
    .map(
      (r, i) =>
        `${i === 0 ? '' : ', whose capture'} at ${r.captureTimestamp} is an archived HTTP ${r.status} redirect to ${name(r.target)}`,
    )
    .join('');
}

/** How a replay's redirects ended, as a clause; `chained` when archived redirects were named before it. */
function deadEndClause(end: RedirectDeadEnd, chained: boolean): string {
  const capture = (timestamp: string) => `${chained ? 'its' : 'the'} capture at ${timestamp}`;
  switch (end.kind) {
    case 'not_archived':
      return 'the Wayback Machine has not archived that URL';
    case 'archived_error':
      return `${capture(end.captureTimestamp)} is an archived HTTP ${end.status} error page`;
    case 'refused':
      return `the Wayback Machine refused to replay it with HTTP ${end.status}`;
    case 'loop':
      return `the next redirect returns to ${end.url}, which was already requested`;
    case 'too_many_redirects':
      return `the redirects continue past ${MAX_REPLAY_REDIRECTS}, the most this server follows`;
    case 'no_location':
      return end.captureTimestamp === undefined
        ? `the Wayback Machine answered HTTP ${end.status} with no Location header`
        : `${capture(end.captureTimestamp)} is an archived HTTP ${end.status} redirect with no Location header`;
    case 'bad_location': {
      const to = `${end.location}, which is not an http(s) Wayback Machine URL, so it is not followed`;
      return end.captureTimestamp === undefined
        ? `the Wayback Machine redirected to ${to}`
        : `${capture(end.captureTimestamp)} is an archived HTTP ${end.status} redirect to ${to}`;
    }
    default: {
      const unreachable: never = end;
      return unreachable;
    }
  }
}

/** An error message's opening clause for the archived redirects a replay of `url` followed, each target named plainly. */
function redirectedFrom(url: string, redirects: readonly ArchivedRedirect[]): string {
  return `The capture of ${url}${redirectChain(redirects, (target) => target)}`;
}

/** The message for redirects from `url` at `timestamp` that reached no readable capture. */
function deadEndMessage(
  url: string,
  timestamp: string,
  redirects: readonly ArchivedRedirect[],
  end: RedirectDeadEnd,
): string {
  return redirects.length > 0
    ? `${redirectedFrom(url, redirects)}; ${deadEndClause(end, true)}.`
    : `No readable capture of ${url} at ${timestamp}: ${deadEndClause(end, false)}.`;
}

/**
 * The links whose first occurrence starts in the page of text from `charOffset` up to
 * `nextOffset`, as `{ text, url }`. The last page, the one reaching the end of the text, also
 * takes a link starting at the end itself (an image-only link after the last text), so a read
 * that follows has_more meets each link once. A page at or past the end of the text holds
 * none, except the one page of an empty text.
 */
function linksOnPage(
  links: readonly PageLink[],
  charOffset: number,
  nextOffset: number,
  totalChars: number,
): { text: string; url: string }[] {
  if (charOffset > 0 && charOffset >= totalChars) return [];
  const end = nextOffset < totalChars ? nextOffset : Number.POSITIVE_INFINITY;
  return links
    .filter(({ offset }) => charOffset <= offset && offset < end)
    .map(({ text, url }) => ({ text, url }));
}

export const iaGetSnapshot = tool('ia_get_snapshot', {
  title: 'Get Wayback Machine Snapshot Content',
  description:
    'Fetch the archived content of a URL at a specific Wayback Machine timestamp, or of the capture a Wayback capture URL such as a replay_url names. Resolves to the nearest available capture when the exact timestamp has no snapshot. Returns the capture as text — an HTML page as readable plain text in lines, its markup stripped and its table cells separated by tabs, another text type (plain text, JSON, XML, JavaScript) as stored — and the replay URL of the capture Wayback served, for browser access. With include_links, it also returns the links on the page as text and URL, so a linked page can be read next. A capture of a PDF, image, or other non-text file fails as non_text_capture. Long text comes one page at a time: has_more and total_chars say what remains, and char_offset reads further — pass it with the url and timestamp the notice names, so every page comes from the same capture; after an archived redirect that url differs from the one sent. Use ia_find_snapshots first to discover valid timestamps for a URL.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    url: z
      .string()
      .trim()
      .min(1, 'Must not be blank — provide the URL whose archived content to retrieve.')
      .describe(
        'The URL whose archived content to retrieve. A Wayback capture URL — web.archive.org/web/<timestamp>/<url>, such as a replay_url — reads as the URL it archives at its timestamp; a timestamp naming a different one fails as ambiguous_timestamp.',
      ),
    timestamp: z
      .string()
      .describe(
        'Target Wayback timestamp: 1–14 digits — YYYYMMDDHHMMSS or a prefix of it — or an ISO 8601 date or UTC date-time such as "2020-01-01" or "2020-01-01T12:00:00Z". A full 14 digits, such as resolved_timestamp or a timestamp from ia_find_snapshots, reads that capture, or the one Wayback redirects it to; a shorter value names a period and resolves to the capture nearest its end ("2015" can resolve to one from early January 2016); blank reads the timestamp of a Wayback capture URL passed as url, else the latest capture. Example: "20200101120000" for noon on January 1, 2020.',
      ),
    char_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Character offset (UTF-16 code units) into the capture's text where this page starts. For the next page, pass the previous char_offset plus max_chars with the url and timestamp the previous page's notice names, so the page comes from the same capture; after an archived redirect that url differs from the one sent. An offset at or past total_chars returns empty text.",
      ),
    max_chars: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Maximum characters this page holds. Defaults to the server-configured maximum (IA_MAX_SNAPSHOT_CHARS, typically 50 000); a larger value is served at that maximum, with a notice.',
      ),
    include_links: z
      .boolean()
      .default(false)
      .describe(
        "Also return the page's links: links holds each http(s) link target whose first occurrence starts in this page of text, as { text, url }, and total_links counts the links in the capture's whole text. It adds no request. Keep it set for the next page, as the next-page notice does, so a read that follows has_more lists each link once.",
      ),
  }),

  output: z.object({
    text: z
      .string()
      .describe(
        "One page of the capture's text: up to max_chars characters from char_offset. An HTML page is reduced to readable plain text in lines: scripts, styles, comments, and tags removed and character references decoded; each block element (paragraph, heading, list item, table row) and <br> starts a new line; the cells of a table row are separated by tabs, empty cells included; the tags of text-level elements (a, b, i, span, sup, …) add no space, so text the page writes without a space has none, though a link and the element beside it keep one space between two words outside CJK text; <pre> text keeps its spacing and line breaks, and elsewhere a whitespace run reads as one space and blank lines collapse to one. Left out are a <template>'s content, unless it declares a shadow root, and the content of an inline element (span, a, sup, …) the page hides with its own hidden attribute or inline display:none style; content hidden by a class, a stylesheet, or a hidden block element stays. Another text type (plain text, JSON, XML, JavaScript) is the body as archived, line breaks and markup kept. Taken from at most the first 4 MiB of the capture; a notice says so when it is longer.",
      ),
    char_offset: z.number().describe('Character offset (UTF-16 code units) this page starts at.'),
    max_chars: z
      .number()
      .describe(
        'Maximum characters this page could hold — the requested max_chars, or the server maximum when the request omitted it or asked for more.',
      ),
    has_more: z
      .boolean()
      .describe(
        "True when the capture's text continues past this page; the notice names the url, char_offset, and timestamp that read the next one, and include_links when this call set it.",
      ),
    total_chars: z
      .number()
      .describe(
        "Length of the capture's whole text in characters (UTF-16 code units), counted over the same first 4 MiB the text comes from.",
      ),
    replay_url: z
      .string()
      .describe(
        `Wayback Machine replay URL (https://web.archive.org) of the capture the text came from — where the replay's redirects ended: Wayback's own to the nearest capture, and archived redirects (a capture of the site's own 3xx, which the notice names), followed for up to ${MAX_REPLAY_REDIRECTS} redirects on the Wayback Machine.`,
      ),
    resolved_timestamp: z
      .string()
      .describe(
        'Timestamp (YYYYMMDDHHMMSS) of the capture the text came from, read from replay_url.',
      ),
    resolved_status: z
      .string()
      .describe(
        'HTTP status Wayback replayed the capture the text came from with — the same capture as resolved_timestamp and replay_url.',
      ),
    links: z
      .array(
        z
          .object({
            text: z
              .string()
              .describe(
                "The link's text as it reads in text, on one line; empty for a link holding only an image.",
              ),
            url: z
              .string()
              .describe(
                'Where the link points: an absolute http(s) URL, its fragment dropped. Read it with ia_get_snapshot and timestamp resolved_timestamp for its capture nearest this one, or, when it is a Wayback capture URL (a link to an archived copy), with a blank timestamp.',
              ),
          })
          .describe('One link: its text and the URL it points to.'),
      )
      .optional()
      .describe(
        "Set when include_links is true: the links whose first occurrence starts in this page of text, in document order. Each http(s) target is listed once, with the first non-empty text it is linked by; the page's own URL is left out, and so is a link inside content the text leaves out (a template or a hidden inline element). The last page also takes the links at the very end of the text, so the pages of a read that follows has_more list each link once. Empty for a capture that is not HTML.",
      ),
    total_links: z
      .number()
      .optional()
      .describe(
        "Set when include_links is true: how many links the capture's whole text holds, counted over the same first 4 MiB the text comes from; 0 for a capture that is not HTML.",
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        "Set when the replay passed through an archived redirect (a capture of the site's own 3xx) — the capture requested is one, or Wayback first redirected the requested timestamp to a nearest capture that is one — naming each archived redirect's capture timestamp, HTTP status, and target, the text then coming from the capture Wayback served for the last target; when the capture is longer than the 4 MiB read limit (the text comes from its first bytes only); when max_chars is above the server maximum; or when more text follows this page — naming the url, char_offset, and timestamp that read the next one, and include_links when this call set it.",
      ),
  },

  errors: [
    {
      reason: 'invalid_timestamp',
      code: JsonRpcErrorCode.ValidationError,
      when: 'timestamp is not blank, 1–14 digits, or an ISO 8601 date or UTC date-time, or names a month, day, hour, minute, or second no Gregorian date and time has; or url is a Wayback capture URL whose timestamp is not 1–14 digits naming a real date and time (field "url").',
      recovery:
        'Set timestamp to 1–14 digits (YYYYMMDDHHMMSS or a prefix of it, such as "20200615"), an ISO 8601 date or UTC date-time such as "2020-06-15" or "2020-06-15T12:34:56Z", or blank for the latest capture.',
      severity: 'warning',
    },
    {
      reason: 'ambiguous_timestamp',
      code: JsonRpcErrorCode.ValidationError,
      when: 'url is a Wayback capture URL and timestamp names a different timestamp than the one the URL carries.',
      recovery:
        'Pass the URL the capture archives as url with the timestamp meant, or leave timestamp blank to read the capture the URL names.',
      severity: 'warning',
    },
    {
      reason: 'no_snapshot_available',
      code: JsonRpcErrorCode.NotFound,
      when: `No capture exists near the requested timestamp for this URL, the capture there is an archived error page — the HTTP 4xx or 5xx the site itself returned when it was captured — or the Wayback Machine refused the replay request with an HTTP 4xx, as it does for a site excluded from the archive; or the replay's redirects reach no readable capture — the target of an archived redirect (a capture of the site's own 3xx) was never archived, is an archived error page, or was refused, or the redirects loop, run past ${MAX_REPLAY_REDIRECTS}, or reach a 3xx with no Location or a Location that is not an http(s) Wayback Machine URL — answered after one attempt; or the closest-capture lookup answered HTTP 403, 410, or 451, the Wayback Machine declining to serve the URL at all.`,
      recovery:
        'Use ia_find_snapshots in history mode to discover what snapshots actually exist for this URL; status_filter "200" lists only captures with readable content.',
      severity: 'warning',
    },
    {
      reason: 'non_text_capture',
      code: JsonRpcErrorCode.NotFound,
      when: 'The capture Wayback served is not text — a PDF, image, archive, or other non-text media type — so it holds no text to return.',
      recovery:
        'Download the original file from the replay URL the message names, or use ia_find_snapshots in history mode to find a capture of this URL whose mimetype is HTML or another text type.',
      severity: 'warning',
    },
    {
      reason: 'content_fetch_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The archived page could not be fetched — the Wayback Machine answered HTTP 429, or 408, 425, or 5xx after retries, did not answer within the request timeout, or could not be reached, or refused the unmodified (id_) form of a text capture it had replayed, or that form's redirects reached no readable capture — or its nearest capture could not be looked up: the closest-capture lookup found no capture or answered HTTP 429, or 408, 425, or 5xx after retries, an unreadable response, or an error in place of a capture, and its CDX fallback failed or had no time left; or the lookup refused the request with another 4xx, did not answer within the request timeout, or could not be reached; or the lookup and the fetch together did not finish within the call's 55 s deadline (the request timeout when that is longer).",
      recovery: 'The Wayback Machine is temporarily unavailable; retry in a few seconds.',
    },
  ],

  async handler(input, ctx) {
    const deadline = startCallDeadline(ctx.signal);
    const svc = getWaybackService();
    // Before any request: a Wayback capture URL reads as its original URL at its own
    // timestamp; otherwise a blank timestamp reads the latest capture.
    const target = readCaptureTarget(input.url, input.timestamp);
    if (target.kind === 'invalid_timestamp') {
      throw ctx.fail('invalid_timestamp', target.message, {
        field: target.field,
        ...ctx.recoveryFor('invalid_timestamp'),
        ...(target.hint && { recovery: { hint: target.hint } }),
      });
    }
    if (target.kind === 'ambiguous_timestamp') {
      throw ctx.fail('ambiguous_timestamp', target.message, ctx.recoveryFor('ambiguous_timestamp'));
    }
    const { url, timestamp } = target;

    // When the caller passes a full 14-digit timestamp (returned by ia_find_snapshots),
    // the Wayback Availability API can spuriously return {} for that exact timestamp —
    // especially when the original URL redirects. Skip the lookup and build the replay
    // URL directly; Wayback redirects it to the nearest capture when the timestamp is not
    // itself one. Imprecise timestamps resolve through the closest-capture lookup.
    const exact = timestamp?.length === 14 ? timestamp : undefined;

    // Upstream failures map onto declared contract entries so callers receive the reason
    // and recovery hint: a NotFound from the page fetch naming a media type is a capture
    // that holds no text; any other means no readable capture there — none at all, or an
    // archived error page — and a ServiceUnavailable from the lookup or the page fetch
    // means the Wayback Machine is unreachable or refused the request. The lookup's own
    // no_snapshot_available passes through as thrown. Once the page fetch starts, its
    // messages name the timestamp asked for, or the capture a blank one resolved to.
    let fetching: string | undefined;
    try {
      const resolved = exact
        ? { snapshotUrl: svc.buildReplayUrl(exact, url), timestamp: exact }
        : await svc.findClosest(url, timestamp, ctx, deadline);
      fetching = timestamp ?? resolved.timestamp;
      // Links are asked for only when wanted, so a call without include_links fetches as before.
      const content = input.include_links
        ? await svc.fetchContent(resolved.snapshotUrl, ctx, deadline, { links: true })
        : await svc.fetchContent(resolved.snapshotUrl, ctx, deadline);
      const resolvedTimestamp = content.timestamp ?? resolved.timestamp;

      // Pages count UTF-16 code units, as ia_get_text's do, and never exceed the ceiling.
      const ceiling = getServerConfig().maxSnapshotChars;
      const maxChars = Math.min(input.max_chars ?? ceiling, ceiling);
      const totalChars = content.text.length;
      const nextOffset = input.char_offset + maxChars;
      const hasMore = nextOffset < totalChars;

      const notices: string[] = [];
      if (content.redirects) {
        notices.push(
          `The capture${redirectChain(content.redirects, code)}, and the text comes from the capture Wayback served for that URL (replay_url).`,
        );
      }
      if (content.truncatedAtBytes !== undefined) {
        const bytes = content.truncatedAtBytes.toLocaleString('en-US');
        notices.push(
          `The archived page is longer than ${bytes} bytes; the text comes from its first ${bytes} bytes. Open replay_url for the full page.`,
        );
      }
      if (input.max_chars !== undefined && input.max_chars > ceiling) {
        const max = ceiling.toLocaleString('en-US');
        notices.push(
          `max_chars ${input.max_chars.toLocaleString('en-US')} is above this server's maximum of ${max} characters per call, so this page holds up to ${max}.`,
        );
      }
      if (hasMore) {
        // Names the URL looked up — after an archived redirect, the original URL of the capture
        // served, so the next page is one request to that capture — never the caller's capture
        // URL, whose own timestamp could differ from the one served. When that URL is itself a
        // Wayback capture URL (a capture of one), it would read at its own timestamp, so the
        // capture served is named instead. As a code span, so it reads back exactly from either
        // surface.
        const lookedUp = (content.redirects && captureOf(content.replayUrl)?.original) ?? url;
        const nextUrl = captureOf(lookedUp) ? content.replayUrl : lookedUp;
        notices.push(
          `More text follows: call ia_get_snapshot again with url ${code(nextUrl)}, timestamp ${resolvedTimestamp} (resolved_timestamp), ${input.include_links ? `char_offset ${nextOffset}, and include_links true` : `and char_offset ${nextOffset}`} for the next page.`,
        );
      }
      if (notices.length) ctx.enrich.notice(notices.join(' '));
      ctx.log.info('Snapshot content fetched', {
        url,
        resolvedTimestamp,
        totalChars,
        hasMore,
      });

      return {
        text: content.text.slice(input.char_offset, nextOffset),
        replay_url: content.replayUrl,
        resolved_timestamp: resolvedTimestamp,
        resolved_status: content.status,
        char_offset: input.char_offset,
        max_chars: maxChars,
        has_more: hasMore,
        total_chars: totalChars,
        ...(content.links && {
          links: linksOnPage(content.links, input.char_offset, nextOffset, totalChars),
          total_links: content.links.length,
        }),
      };
    } catch (err) {
      if (
        fetching !== undefined &&
        err instanceof McpError &&
        err.code === JsonRpcErrorCode.NotFound
      ) {
        const { captureTimestamp, deadEnd, mediaType, redirects, replayUrl, status } =
          err.data ?? {};
        if (deadEnd !== undefined) {
          throw ctx.fail(
            'no_snapshot_available',
            deadEndMessage(
              url,
              fetching,
              redirects as ArchivedRedirect[],
              deadEnd as RedirectDeadEnd,
            ),
            ctx.recoveryFor('no_snapshot_available'),
            { cause: err },
          );
        }
        if (mediaType !== undefined) {
          const served = `is ${mediaType}, not text, so it has no text to return; the original file is at ${replayUrl}.`;
          throw ctx.fail(
            'non_text_capture',
            redirects
              ? `${redirectedFrom(url, redirects as ArchivedRedirect[])}; the capture Wayback served for that URL ${served}`
              : `The capture of ${url} that Wayback served ${served}`,
            { mediaType, replayUrl, ...ctx.recoveryFor('non_text_capture') },
            { cause: err },
          );
        }
        const refusal = captureTimestamp === undefined && typeof status === 'number' ? status : 0;
        if (NOT_SERVED.has(refusal)) {
          throw ctx.fail(
            'no_snapshot_available',
            notServedMessage(url, refusal),
            { recovery: { hint: NOT_SERVED_HINT } },
            { cause: err },
          );
        }
        throw ctx.fail(
          'no_snapshot_available',
          captureTimestamp !== undefined
            ? `The capture of ${url} at ${captureTimestamp} is an archived HTTP ${status} error page — the site returned that error when it was captured, so the capture holds no copy of the page itself.`
            : refusal && refusal !== 404
              ? `The Wayback Machine refused the replay request for ${url} at ${fetching} with HTTP ${refusal}.`
              : `No capture found at ${url} for timestamp ${fetching}.`,
          ctx.recoveryFor('no_snapshot_available'),
          { cause: err },
        );
      }
      if (err instanceof McpError && err.code === JsonRpcErrorCode.ServiceUnavailable) {
        // A lookup failure's message already says what could not be looked up. When the
        // service named its own next step (wait out a rate limit, or list captures in
        // history mode), that step and its retry fields replace the generic hint.
        const { recovery, retryable, retryAfter } = err.data ?? {};
        throw ctx.fail(
          'content_fetch_failed',
          fetching !== undefined
            ? `Could not fetch the archived page for ${url} near ${fetching}: ${err.message}`
            : err.message,
          {
            ...ctx.recoveryFor('content_fetch_failed'),
            ...(recovery !== undefined && { recovery }),
            ...(retryable !== undefined && { retryable }),
            ...(retryAfter !== undefined && { retryAfter }),
          },
          { cause: err },
        );
      }
      throw err;
    }
  },

  format: (result) => {
    const count = (n: number) => n.toLocaleString('en-US');
    const lines: string[] = [
      `**Replay URL:** ${markdownLink(result.replay_url, result.replay_url)}`,
      `**Resolved Timestamp:** ${escapeMarkdownInline(result.resolved_timestamp)} | **Status:** ${escapeMarkdownInline(result.resolved_status)}`,
      `**Offset:** ${count(result.char_offset)} | **Max Chars:** ${count(result.max_chars)} | **Total Chars:** ${count(result.total_chars)}${result.has_more ? ` — more follows (next offset: ${count(result.char_offset + result.max_chars)})` : ' — end of text'}`,
      '',
      '---',
      '',
      escapeMarkdownInline(result.text),
    ];
    const { links, total_links } = result;
    if (links && total_links !== undefined) {
      lines.push('', `**Links on this page:** ${count(links.length)} of ${count(total_links)}`);
      if (links.length > 0) lines.push('', ...links.map((l) => `- ${markdownLink(l.text, l.url)}`));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
