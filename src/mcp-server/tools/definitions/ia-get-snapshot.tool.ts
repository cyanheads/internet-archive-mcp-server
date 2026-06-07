/**
 * @fileoverview Tool for fetching archived content of a URL at a specific Wayback timestamp.
 * @module mcp-server/tools/definitions/ia-get-snapshot
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { SnapshotContent } from '@/services/wayback/types.js';
import { getWaybackService } from '@/services/wayback/wayback-service.js';

export const iaGetSnapshot = tool('ia_get_snapshot', {
  title: 'Get Wayback Machine Snapshot Content',
  description:
    'Fetch the archived content of a URL at a specific Wayback Machine timestamp. Resolves to the ' +
    'nearest available capture when the exact timestamp has no snapshot. Returns the archived page ' +
    'as readable plain text (HTML stripped) and the canonical replay URL for browser access. ' +
    'Use ia_find_snapshots first to discover valid timestamps for a URL.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    url: z.string().describe('The URL whose archived content to retrieve.'),
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
        'Readable plain text extracted from the archived HTML (scripts, styles, and nav stripped). ' +
          'Capped at the server-configured IA_MAX_SNAPSHOT_CHARS limit (default 50 000 characters).',
      ),
    replay_url: z
      .string()
      .describe('Canonical Wayback Machine replay URL used to fetch this content.'),
    resolved_timestamp: z
      .string()
      .describe('The actual snapshot timestamp resolved from the nearest capture lookup.'),
    resolved_status: z
      .string()
      .describe(
        'HTTP status code of the original capture at the resolved timestamp. ' +
          'Returned by the Availability API for imprecise timestamps; assumed "200" ' +
          'for exact 14-digit timestamps (direct path skips the Availability API).',
      ),
  }),

  errors: [
    {
      reason: 'no_snapshot_available',
      code: JsonRpcErrorCode.NotFound,
      when: 'No capture exists near the requested timestamp for this URL.',
      recovery:
        'Use ia_find_snapshots in history mode to discover what snapshots actually exist for this URL.',
    },
    {
      reason: 'content_fetch_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The archived page could not be fetched — the Wayback Machine is temporarily unreachable.',
      recovery: 'The Wayback Machine is temporarily unavailable; retry in a few seconds.',
    },
  ],

  async handler(input, ctx) {
    const svc = getWaybackService();

    // When the caller passes a full 14-digit timestamp (returned by ia_find_snapshots),
    // the Wayback Availability API can spuriously return {} for that exact timestamp —
    // especially when the original URL redirects. Skip the re-check and build the
    // replay URL directly; fall back to the Availability API for imprecise timestamps.
    const isExactTimestamp = /^\d{14}$/.test(input.timestamp.trim());

    let resolvedTimestamp: string;
    let resolvedStatus: string;
    let snapshotUrl: string;

    if (isExactTimestamp) {
      // Direct path: build replay URL from the exact timestamp
      snapshotUrl = svc.buildReplayUrl(input.timestamp.trim(), input.url);
      resolvedTimestamp = input.timestamp.trim();
      resolvedStatus = '200'; // status will be determined by fetchContent; default assumed
    } else {
      // Resolution path: use Availability API to find the nearest snapshot
      const availability = await svc.findClosest(input.url, input.timestamp, ctx);
      snapshotUrl = availability.snapshotUrl;
      resolvedTimestamp = availability.timestamp;
      resolvedStatus = availability.status;
    }

    // Fetch and extract the archived content.
    // For exact-timestamp direct paths, a 404 means no capture at that timestamp —
    // remap to the declared no_snapshot_available contract so callers get the recovery hint.
    let content: SnapshotContent;
    try {
      content = await svc.fetchContent(snapshotUrl, ctx);
    } catch (err) {
      if (isExactTimestamp && err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'no_snapshot_available',
          `No capture found at ${input.url} for timestamp ${resolvedTimestamp}.`,
          { ...ctx.recoveryFor('no_snapshot_available') },
        );
      }
      throw err;
    }

    ctx.log.info('Snapshot content fetched', {
      url: input.url,
      resolvedTimestamp,
    });

    return {
      text: content.text,
      replay_url: content.replayUrl,
      resolved_timestamp: resolvedTimestamp,
      resolved_status: resolvedStatus,
    };
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
