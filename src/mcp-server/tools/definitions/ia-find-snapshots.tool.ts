/**
 * @fileoverview Tool for finding Wayback Machine snapshots of a URL.
 * @module mcp-server/tools/definitions/ia-find-snapshots
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getWaybackService } from '@/services/wayback/wayback-service.js';

const WAYBACK_WEB = 'https://web.archive.org/web';

export const iaFindSnapshots = tool('ia_find_snapshots', {
  title: 'Find Wayback Machine Snapshots',
  description:
    'Find Wayback Machine snapshots of a URL. Mode "closest" returns the single nearest capture ' +
    'to a given timestamp via the Availability API (fast, one result). Mode "history" returns the ' +
    'full capture list via the CDX API — filterable by date range, HTTP status code, and MIME type, ' +
    'collapsed by default to one capture per day (collapse=timestamp:8). Use history mode to survey ' +
    'how a page changed over time; use closest mode when you need the snapshot nearest a specific date. ' +
    'history mode supports resume-key pagination for URLs with very large capture histories.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    url: z.string().describe('The URL to look up in the Wayback Machine.'),
    mode: z
      .enum(['closest', 'history'])
      .describe(
        'Lookup mode: "closest" returns the single nearest snapshot to the given timestamp; ' +
          '"history" returns the paginated full capture list via the CDX API.',
      ),
    timestamp: z
      .string()
      .optional()
      .describe(
        'Target timestamp in YYYYMMDDHHMMSS format (or any prefix thereof). Required for mode=closest. ' +
          'Example: "20200101" for January 1, 2020.',
      ),
    from: z
      .string()
      .optional()
      .describe(
        'Start of date range filter in YYYYMMDD format (history mode only). ' +
          'Example: "20200101".',
      ),
    to: z
      .string()
      .optional()
      .describe(
        'End of date range filter in YYYYMMDD format (history mode only). ' +
          'Example: "20231231".',
      ),
    status_filter: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{3}$/)
          .describe('3-digit HTTP status code.'),
      ])
      .optional()
      .describe(
        'Filter CDX results to a specific HTTP status code (history mode only). ' +
          'Must be a 3-digit numeric code. Example: "200" to return only successful captures.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(100)
      .describe('Maximum number of CDX records to return (history mode only, default 100).'),
    collapse: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^timestamp:\d{1,2}$/)
          .describe('Collapse precision string.'),
      ])
      .optional()
      .describe(
        'CDX collapse parameter (history mode only). Format: "timestamp:N" where N is 1–14 ' +
          '(4=year, 6=month, 8=day, 10=hour, 14=exact). Default "timestamp:8" collapses to one per day. ' +
          'Pass an empty string or omit to get uncollapsed results.',
      ),
    resume_key: z
      .string()
      .optional()
      .describe(
        'Opaque pagination key from a previous history mode response. Pass this to continue from ' +
          'where the last page left off.',
      ),
  }),

  output: z.object({
    snapshots: z
      .array(
        z
          .object({
            timestamp: z.string().describe('Wayback timestamp in YYYYMMDDHHMMSS format.'),
            replay_url: z.string().describe('Full Wayback Machine replay URL for this snapshot.'),
            statuscode: z
              .string()
              .optional()
              .describe('HTTP status code at time of capture (history mode).'),
            mimetype: z
              .string()
              .optional()
              .describe('MIME type of the captured content (history mode).'),
            original_url: z
              .string()
              .optional()
              .describe('Original URL as captured (history mode).'),
            digest: z.string().optional().describe('SHA-1 digest of the content (history mode).'),
            length: z.string().optional().describe('Content length in bytes (history mode).'),
          })
          .describe('A single Wayback Machine snapshot record.'),
      )
      .describe('List of snapshots matching the query.'),
    resume_key: z
      .string()
      .optional()
      .describe(
        'Opaque key to pass as resume_key in the next call to continue paginating CDX history results.',
      ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the snapshot list was capped at the limit.'),
    shown: z.number().optional().describe('Number of snapshots returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
  },

  errors: [
    {
      reason: 'no_snapshots',
      code: JsonRpcErrorCode.NotFound,
      when: 'No snapshots found for the given URL with the current filters.',
      recovery:
        'Broaden the date range, remove status or MIME filters, or verify the URL is correct.',
    },
    {
      reason: 'no_snapshot_available',
      code: JsonRpcErrorCode.NotFound,
      when: 'No capture exists near the requested timestamp for this URL.',
      recovery:
        'Try a different timestamp or switch to history mode to discover what snapshots exist.',
    },
    {
      reason: 'cdx_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Wayback CDX API is temporarily unavailable or returned an unreadable response.',
      recovery: 'The Wayback CDX API is temporarily overloaded; retry in a few seconds.',
    },
  ],

  async handler(input, ctx) {
    const svc = getWaybackService();

    if (input.mode === 'closest') {
      const ts = input.timestamp?.trim();
      if (!ts) {
        throw ctx.fail('no_snapshot_available', 'timestamp is required for mode=closest.', {
          ...ctx.recoveryFor('no_snapshot_available'),
        });
      }

      const result = await svc.findClosest(input.url, ts, ctx);
      ctx.log.info('Closest snapshot found', { url: input.url, timestamp: result.timestamp });

      return {
        snapshots: [
          {
            timestamp: result.timestamp,
            replay_url: result.snapshotUrl,
            statuscode: result.status,
          },
        ],
      };
    }

    // history mode
    const collapseParam = input.collapse === '' ? undefined : (input.collapse ?? 'timestamp:8');

    const histResult = await svc.fetchHistory(
      {
        url: input.url,
        from: input.from?.trim() || undefined,
        to: input.to?.trim() || undefined,
        statusFilter: input.status_filter?.trim() || undefined,
        limit: input.limit,
        collapse: collapseParam,
        resumeKey: input.resume_key?.trim() || undefined,
      },
      ctx,
    );

    if (histResult.records.length === 0) {
      throw ctx.fail(
        'no_snapshots',
        `No snapshots found for "${input.url}" with the specified filters.`,
        { ...ctx.recoveryFor('no_snapshots') },
      );
    }

    ctx.log.info('CDX history fetched', {
      url: input.url,
      count: histResult.records.length,
      hasResumeKey: !!histResult.resumeKey,
    });

    if (histResult.records.length >= input.limit) {
      ctx.enrich.truncated({ shown: histResult.records.length, cap: input.limit });
    }

    const snapshots = histResult.records.map((r) => ({
      timestamp: r.timestamp,
      replay_url: `${WAYBACK_WEB}/${r.timestamp}/${r.original || input.url}`,
      statuscode: r.statuscode || undefined,
      mimetype: r.mimetype || undefined,
      original_url: r.original || undefined,
      digest: r.digest || undefined,
      ...(r.length ? { length: r.length } : {}),
    }));

    return {
      snapshots,
      ...(histResult.resumeKey ? { resume_key: histResult.resumeKey } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const snap of result.snapshots) {
      lines.push(`## ${snap.timestamp}`);
      lines.push(`**Replay URL:** ${snap.replay_url}`);
      if (snap.statuscode) lines.push(`**Status:** ${snap.statuscode}`);
      if (snap.mimetype) lines.push(`**MIME:** ${snap.mimetype}`);
      if (snap.original_url) lines.push(`**Original URL:** ${snap.original_url}`);
      if (snap.digest) lines.push(`**Digest:** ${snap.digest}`);
      if (snap.length) lines.push(`**Length:** ${snap.length}`);
      lines.push('');
    }
    if (result.resume_key) {
      lines.push(`---`);
      lines.push(
        `**Resume Key:** ${result.resume_key} _(pass as resume_key to get the next page)_`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
