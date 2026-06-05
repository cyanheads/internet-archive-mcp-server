/**
 * @fileoverview Tool for fetching archived content of a URL at a specific Wayback timestamp.
 * @module mcp-server/tools/definitions/ia-get-snapshot
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
        'Readable plain text extracted from the archived HTML (scripts, styles, and nav stripped).',
      ),
    replay_url: z
      .string()
      .describe('Canonical Wayback Machine replay URL used to fetch this content.'),
    resolved_timestamp: z
      .string()
      .describe('The actual snapshot timestamp resolved from the nearest capture lookup.'),
    resolved_status: z
      .string()
      .describe('HTTP status code of the original capture at the resolved timestamp.'),
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

    // Step 1: resolve the nearest snapshot via Availability API
    const availability = await svc.findClosest(input.url, input.timestamp, ctx);

    // Step 2: fetch and extract the archived content
    const content = await svc.fetchContent(availability.snapshotUrl, ctx);

    ctx.log.info('Snapshot content fetched', {
      url: input.url,
      resolvedTimestamp: availability.timestamp,
    });

    return {
      text: content.text,
      replay_url: content.replayUrl,
      resolved_timestamp: availability.timestamp,
      resolved_status: availability.status,
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
