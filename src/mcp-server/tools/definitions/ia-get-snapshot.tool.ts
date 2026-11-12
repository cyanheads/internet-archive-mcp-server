/**
 * @fileoverview Tool for fetching archived content of a URL at a specific Wayback timestamp.
 * @module mcp-server/tools/definitions/ia-get-snapshot
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  getWaybackService,
  NOT_SERVED,
  NOT_SERVED_HINT,
  notServedMessage,
} from '@/services/wayback/wayback-service.js';
import { TIMESTAMP_FORMS, waybackTimestamp } from '@/services/wayback/wayback-timestamp.js';

export const iaGetSnapshot = tool('ia_get_snapshot', {
  title: 'Get Wayback Machine Snapshot Content',
  description:
    'Fetch the archived content of a URL at a specific Wayback Machine timestamp. Resolves to the nearest available capture when the exact timestamp has no snapshot. Returns the capture as text — an HTML page as readable plain text with its markup stripped, another text type (plain text, JSON, XML, JavaScript) as stored — and the replay URL of the capture Wayback served, for browser access. A capture of a PDF, image, or other non-text file fails as non_text_capture. Long text comes one page at a time: has_more and total_chars say what remains, and char_offset reads further — pass resolved_timestamp as timestamp so every page comes from the same capture. Use ia_find_snapshots first to discover valid timestamps for a URL.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    url: z
      .string()
      .trim()
      .min(1, 'Must not be blank — provide the URL whose archived content to retrieve.')
      .describe('The URL whose archived content to retrieve.'),
    timestamp: z
      .string()
      .describe(
        'Target Wayback timestamp: 1–14 digits — YYYYMMDDHHMMSS or a prefix of it — or an ISO 8601 date or UTC date-time such as "2020-01-01" or "2020-01-01T12:00:00Z". A full 14 digits, such as resolved_timestamp or a timestamp from ia_find_snapshots, reads that capture, or the one Wayback redirects it to; a shorter value names a period and resolves to the capture nearest its end ("2015" can resolve to one from early January 2016); blank reads the latest capture. Example: "20200101120000" for noon on January 1, 2020.',
      ),
    char_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Character offset (UTF-16 code units) into the capture's text where this page starts. For the next page, pass the previous char_offset plus max_chars, with the previous resolved_timestamp as timestamp so the page comes from the same capture. An offset at or past total_chars returns empty text.",
      ),
    max_chars: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Maximum characters this page holds. Defaults to the server-configured maximum (IA_MAX_SNAPSHOT_CHARS, typically 50 000); a larger value is served at that maximum, with a notice.',
      ),
  }),

  output: z.object({
    text: z
      .string()
      .describe(
        "One page of the capture's text: up to max_chars characters from char_offset. An HTML page is reduced to readable plain text: scripts, styles, comments, and tags removed, character references decoded, whitespace collapsed. Another text type (plain text, JSON, XML, JavaScript) is the body as archived, line breaks and markup kept. Taken from at most the first 4 MiB of the capture; a notice says so when it is longer.",
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
        "True when the capture's text continues past this page; the notice names the char_offset and timestamp that read the next one.",
      ),
    total_chars: z
      .number()
      .describe(
        "Length of the capture's whole text in characters (UTF-16 code units), counted over the same first 4 MiB the text comes from.",
      ),
    replay_url: z
      .string()
      .describe(
        'Wayback Machine replay URL (https://web.archive.org) of the capture the text came from — where the fetch ended after any redirect Wayback issued to the capture it served.',
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
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Set when the capture is longer than the 4 MiB read limit (the text comes from its first bytes only), when max_chars is above the server maximum, or when more text follows this page — naming the char_offset and timestamp that read the next one.',
      ),
  },

  errors: [
    {
      reason: 'invalid_timestamp',
      code: JsonRpcErrorCode.ValidationError,
      when: 'timestamp is not blank, 1–14 digits, or an ISO 8601 date or UTC date-time, or names a month, day, hour, minute, or second no Gregorian date and time has.',
      recovery:
        'Set timestamp to 1–14 digits (YYYYMMDDHHMMSS or a prefix of it, such as "20200615"), an ISO 8601 date or UTC date-time such as "2020-06-15" or "2020-06-15T12:34:56Z", or blank for the latest capture.',
      severity: 'warning',
    },
    {
      reason: 'no_snapshot_available',
      code: JsonRpcErrorCode.NotFound,
      when: 'No capture exists near the requested timestamp for this URL, the capture there is an archived error page — the HTTP 4xx or 5xx the site itself returned when it was captured — or the Wayback Machine refused the replay request with an HTTP 4xx, as it does for a site excluded from the archive; or the closest-capture lookup answered HTTP 403, 410, or 451, the Wayback Machine declining to serve the URL at all.',
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
      when: 'The archived page could not be fetched — the Wayback Machine answered HTTP 5xx after retries or 429, did not answer within the request timeout, or could not be reached, or refused the unmodified (id_) form of a text capture it had replayed — or its nearest capture could not be looked up: the closest-capture lookup found no capture or answered HTTP 429, or 408, 425, or 5xx after retries, or an unreadable response, and its CDX fallback failed or had no time left within the lookup deadline (the request timeout plus 25 s); or the lookup refused the request with another 4xx, did not answer within the request timeout, or could not be reached.',
      recovery: 'The Wayback Machine is temporarily unavailable; retry in a few seconds.',
    },
  ],

  async handler(input, ctx) {
    const svc = getWaybackService();
    // Blank reads the latest capture, so only a non-blank timestamp is checked — before any request.
    const text = input.timestamp.trim();
    const timestamp = text ? waybackTimestamp(text) : undefined;
    if (text && timestamp === undefined) {
      throw ctx.fail('invalid_timestamp', `timestamp must be ${TIMESTAMP_FORMS}.`, {
        field: 'timestamp',
        ...ctx.recoveryFor('invalid_timestamp'),
      });
    }

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
        ? { snapshotUrl: svc.buildReplayUrl(exact, input.url), timestamp: exact }
        : await svc.findClosest(input.url, timestamp, ctx);
      fetching = timestamp ?? resolved.timestamp;
      const content = await svc.fetchContent(resolved.snapshotUrl, ctx);
      const resolvedTimestamp = content.timestamp ?? resolved.timestamp;

      // Pages count UTF-16 code units, as ia_get_text's do, and never exceed the ceiling.
      const ceiling = getServerConfig().maxSnapshotChars;
      const maxChars = Math.min(input.max_chars ?? ceiling, ceiling);
      const totalChars = content.text.length;
      const nextOffset = input.char_offset + maxChars;
      const hasMore = nextOffset < totalChars;

      const notices: string[] = [];
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
        notices.push(
          `More text follows: call ia_get_snapshot again with the same url, timestamp ${resolvedTimestamp} (resolved_timestamp), and char_offset ${nextOffset} for the next page.`,
        );
      }
      if (notices.length) ctx.enrich.notice(notices.join(' '));
      ctx.log.info('Snapshot content fetched', {
        url: input.url,
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
      };
    } catch (err) {
      if (
        fetching !== undefined &&
        err instanceof McpError &&
        err.code === JsonRpcErrorCode.NotFound
      ) {
        const { captureTimestamp, mediaType, replayUrl, status } = err.data ?? {};
        if (mediaType !== undefined) {
          throw ctx.fail(
            'non_text_capture',
            `The capture of ${input.url} that Wayback served is ${mediaType}, not text, so it has no text to return; the original file is at ${replayUrl}.`,
            { mediaType, replayUrl, ...ctx.recoveryFor('non_text_capture') },
            { cause: err },
          );
        }
        const refusal = captureTimestamp === undefined && typeof status === 'number' ? status : 0;
        if (NOT_SERVED.has(refusal)) {
          throw ctx.fail(
            'no_snapshot_available',
            notServedMessage(input.url, refusal),
            { recovery: { hint: NOT_SERVED_HINT } },
            { cause: err },
          );
        }
        throw ctx.fail(
          'no_snapshot_available',
          captureTimestamp !== undefined
            ? `The capture of ${input.url} at ${captureTimestamp} is an archived HTTP ${status} error page — the site returned that error when it was captured, so the capture holds no copy of the page itself.`
            : refusal && refusal !== 404
              ? `The Wayback Machine refused the replay request for ${input.url} at ${fetching} with HTTP ${refusal}.`
              : `No capture found at ${input.url} for timestamp ${fetching}.`,
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
            ? `Could not fetch the archived page for ${input.url} near ${fetching}: ${err.message}`
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
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
