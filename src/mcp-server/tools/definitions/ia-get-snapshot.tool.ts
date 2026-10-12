/**
 * @fileoverview Tool for fetching archived content of a URL at a specific Wayback timestamp.
 * @module mcp-server/tools/definitions/ia-get-snapshot
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  getWaybackService,
  NOT_SERVED,
  NOT_SERVED_HINT,
  notServedMessage,
} from '@/services/wayback/wayback-service.js';

export const iaGetSnapshot = tool('ia_get_snapshot', {
  title: 'Get Wayback Machine Snapshot Content',
  description:
    'Fetch the archived content of a URL at a specific Wayback Machine timestamp. Resolves to the ' +
    'nearest available capture when the exact timestamp has no snapshot. Returns the archived page ' +
    'as readable plain text (HTML stripped) and the replay URL of the capture Wayback served, for browser access. ' +
    'Use ia_find_snapshots first to discover valid timestamps for a URL.',
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
        'Target Wayback timestamp in YYYYMMDDHHMMSS format (or any prefix). ' +
          'The nearest available snapshot will be resolved and fetched. ' +
          'Example: "20200101120000" for noon on January 1, 2020.',
      ),
  }),

  output: z.object({
    text: z
      .string()
      .describe(
        'Readable plain text extracted from the archived HTML: scripts, styles, comments, and ' +
          'tags removed, character references decoded, whitespace collapsed. Capped at the ' +
          'server-configured IA_MAX_SNAPSHOT_CHARS limit (default 50 000 characters). Taken from ' +
          'at most the first 4 MiB of the page; a notice says so when a page is longer.',
      ),
    replay_url: z
      .string()
      .describe(
        'Wayback Machine replay URL (https://web.archive.org) of the capture the text came from — ' +
          'where the fetch ended after any redirect Wayback issued to the capture it served.',
      ),
    resolved_timestamp: z
      .string()
      .describe(
        'Timestamp (YYYYMMDDHHMMSS) of the capture the text came from, read from replay_url.',
      ),
    resolved_status: z
      .string()
      .describe(
        'HTTP status Wayback replayed the capture the text came from with — the same capture ' +
          'as resolved_timestamp and replay_url.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Set when the page is longer than the 4 MiB read limit: the text comes from its first bytes only.',
      ),
  },

  errors: [
    {
      reason: 'no_snapshot_available',
      code: JsonRpcErrorCode.NotFound,
      when:
        'No capture exists near the requested timestamp for this URL, the capture there is an ' +
        'archived error page — the HTTP 4xx or 5xx the site itself returned when it was ' +
        'captured — or the Wayback Machine refused the replay request with an HTTP 4xx, as it ' +
        'does for a site excluded from the archive; or the closest-capture lookup answered ' +
        'HTTP 403, 410, or 451, the Wayback Machine declining to serve the URL at all.',
      recovery:
        'Use ia_find_snapshots in history mode to discover what snapshots actually exist for this URL; ' +
        'status_filter "200" lists only captures with readable content.',
      severity: 'warning',
    },
    {
      reason: 'content_fetch_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when:
        'The archived page could not be fetched, or its nearest capture could not be looked up — ' +
        'the Wayback Machine answered HTTP 5xx after retries or 429, refused the lookup with ' +
        'another 4xx, sent an unreadable lookup response, did not answer within the request ' +
        'timeout, or could not be reached.',
      recovery: 'The Wayback Machine is temporarily unavailable; retry in a few seconds.',
    },
  ],

  async handler(input, ctx) {
    const svc = getWaybackService();
    const timestamp = input.timestamp.trim();

    // When the caller passes a full 14-digit timestamp (returned by ia_find_snapshots),
    // the Wayback Availability API can spuriously return {} for that exact timestamp —
    // especially when the original URL redirects. Skip the lookup and build the replay
    // URL directly; Wayback redirects it to the nearest capture when the timestamp is not
    // itself one. Imprecise timestamps resolve through the closest-capture lookup.
    const isExactTimestamp = /^\d{14}$/.test(timestamp);

    // Two upstream failures map onto declared contract entries so callers receive the
    // reason and recovery hint: a NotFound from the page fetch means no readable capture
    // there — none at all, or an archived error page — and a ServiceUnavailable from the
    // lookup or the page fetch means the Wayback Machine is unreachable or refused the
    // request. The lookup's own no_snapshot_available passes through as thrown.
    let fetching = false;
    try {
      const resolved = isExactTimestamp
        ? { snapshotUrl: svc.buildReplayUrl(timestamp, input.url), timestamp }
        : await svc.findClosest(input.url, timestamp, ctx);
      fetching = true;
      const content = await svc.fetchContent(resolved.snapshotUrl, ctx);
      const resolvedTimestamp = content.timestamp ?? resolved.timestamp;

      if (content.truncatedAtBytes !== undefined) {
        const bytes = content.truncatedAtBytes.toLocaleString('en-US');
        ctx.enrich.notice(
          `The archived page is longer than ${bytes} bytes; the text comes from its first ${bytes} bytes. Open replay_url for the full page.`,
        );
      }
      ctx.log.info('Snapshot content fetched', { url: input.url, resolvedTimestamp });

      return {
        text: content.text,
        replay_url: content.replayUrl,
        resolved_timestamp: resolvedTimestamp,
        resolved_status: content.status,
      };
    } catch (err) {
      if (fetching && err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        const { captureTimestamp, status } = err.data ?? {};
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
            ? `The capture of ${input.url} at ${captureTimestamp} is an archived HTTP ${status} ` +
                'error page — the site returned that error when it was captured, so the capture holds no copy of the page itself.'
            : refusal && refusal !== 404
              ? `The Wayback Machine refused the replay request for ${input.url} at ${timestamp} with HTTP ${refusal}.`
              : `No capture found at ${input.url} for timestamp ${timestamp}.`,
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
          fetching
            ? `Could not fetch the archived page for ${input.url} near ${timestamp}: ${err.message}`
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
    const lines: string[] = [
      `**Replay URL:** ${result.replay_url}`,
      `**Resolved Timestamp:** ${result.resolved_timestamp} | **Status:** ${result.resolved_status}`,
      '',
      '---',
      '',
      result.text,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
