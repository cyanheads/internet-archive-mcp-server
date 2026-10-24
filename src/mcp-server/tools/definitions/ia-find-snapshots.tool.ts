/**
 * @fileoverview Tool for finding Wayback Machine snapshots of a URL.
 * @module mcp-server/tools/definitions/ia-find-snapshots
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { getWaybackService } from '@/services/wayback/wayback-service.js';

const WAYBACK_WEB = 'https://web.archive.org/web';

/** CDX records returned per call. A larger history-mode `limit` is sent to CDX as this cap. */
const LIMIT_CAP = 10_000;

/** The largest `limit` accepted: the CDX server's documented per-query maximum. */
const LIMIT_CEILING = 150_000;

export const iaFindSnapshots = tool('ia_find_snapshots', {
  title: 'Find Wayback Machine Snapshots',
  description:
    'Find Wayback Machine snapshots of a URL. Mode "closest" returns the single nearest capture ' +
    'to a given timestamp via the Availability API, falling back to a CDX closest-capture query ' +
    'when the Availability API has no answer (one result). Mode "history" returns the ' +
    'full capture list via the CDX API — filterable by date range and HTTP status code, ' +
    'collapsed by default to one capture per day (collapse "timestamp:8"); collapse ' +
    '"timestamp:14" lists one row per distinct capture second. Use history mode to survey ' +
    'how a page changed over time; use closest mode when you need the snapshot nearest a specific date. ' +
    'History mode returns up to limit records (at most 10,000 per call) and supports resume-key ' +
    'pagination for URLs with very large capture histories.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    url: z
      .string()
      .trim()
      .min(1, 'Must not be blank — provide the URL to look up.')
      .describe('The URL to look up in the Wayback Machine.'),
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
      .max(LIMIT_CEILING)
      .default(100)
      .describe(
        'Maximum number of CDX records to return (history mode only, default 100). One call ' +
          'returns at most 10,000: a larger value (up to 150,000) is served as 10,000, and the ' +
          'resume_key continues from there.',
      ),
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
          '(4=year, 6=month, 8=day, 10=hour, 14=second): consecutive captures sharing the first ' +
          'N timestamp digits are listed once. Omitted or blank, it is "timestamp:8", one ' +
          'capture per day. Pass "timestamp:14" for one row per distinct capture second.',
      ),
    resume_key: z
      .string()
      .optional()
      .describe(
        'Opaque pagination key from a previous history mode response. Pass this to continue from ' +
          'where the last page left off. Server cursors expire after one hour and bind the URL and original filters; omit filters on continuation or repeat their original values. Page size may change. Wildcard and legacy raw continuations can omit collapsed captures.',
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
              .describe('HTTP status code at time of capture ("-" for a revisit record).'),
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
    cap: z
      .number()
      .optional()
      .describe('The limit applied: limit, or 10,000 when a larger value was capped.'),
    notice: z
      .string()
      .optional()
      .describe('Pagination guidance, cap disclosure, or limitations of legacy raw continuation.'),
  },

  errors: [
    {
      reason: 'invalid_resume_key',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The server history cursor is malformed, expired, or unavailable for this caller.',
      recovery:
        'Restart history mode without resume_key using the original URL and filters; server cursors expire after one hour.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'resume_key_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An explicit URL or filter conflicts with the server history cursor.',
      recovery:
        'Keep the original URL and omit collapse, from, to, and status_filter when continuing with resume_key, or restart without resume_key to change the query.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'missing_timestamp',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Closest mode was called without a timestamp, or with a blank one.',
      recovery:
        'Pass timestamp in YYYYMMDDHHMMSS format or any prefix of it (e.g. "20200101"), or use ' +
        'mode "history" to list captures without one.',
      severity: 'warning',
    },
    {
      reason: 'no_snapshots',
      code: JsonRpcErrorCode.NotFound,
      when: 'No snapshots found for the given URL with the current filters.',
      recovery: 'Broaden the date range, remove status_filter, or verify the URL is correct.',
      severity: 'warning',
    },
    {
      reason: 'no_snapshot_available',
      code: JsonRpcErrorCode.NotFound,
      when:
        'Closest mode: no capture exists near the requested timestamp for this URL. Either ' +
        'mode: the Wayback Machine does not serve captures of this URL at all — the CDX or ' +
        'Availability API answered HTTP 403, 410, or 451, as it does for a site excluded from ' +
        'the archive.',
      recovery:
        'Try a different timestamp or switch to history mode to discover what snapshots exist.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'cdx_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when:
        'The Wayback CDX API answered HTTP 5xx after retries or 429, refused the request with ' +
        'another 4xx, did not answer within the request timeout, could not be reached, or ' +
        'returned an unreadable response; in closest mode, the CDX closest-capture check ' +
        'failed or did not complete in time.',
      recovery:
        'The Wayback CDX API is temporarily overloaded or unreachable; retry in a few seconds. ' +
        'A query that keeps timing out needs a narrower from and to range or a smaller limit.',
      thrownBy: 'service',
    },
    {
      reason: 'availability_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when:
        'The Wayback Availability API answered HTTP 5xx after retries or 429, refused the ' +
        'request with another 4xx, did not answer within the request timeout, could not be ' +
        'reached, or returned an unreadable response (closest mode).',
      recovery:
        'Retry in a few seconds, or use history mode with from and to around the timestamp to list nearby captures.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getWaybackService();

    if (input.mode === 'closest') {
      const ts = input.timestamp?.trim();
      if (!ts) {
        throw ctx.fail(
          'missing_timestamp',
          'timestamp is required for mode "closest".',
          ctx.recoveryFor('missing_timestamp'),
        );
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
    const collapseParam = input.collapse || undefined;
    const limit = Math.min(input.limit, LIMIT_CAP);

    const histResult = await svc.fetchHistory(
      {
        url: input.url,
        from: input.from?.trim() || undefined,
        to: input.to?.trim() || undefined,
        statusFilter: input.status_filter?.trim() || undefined,
        limit,
        collapse: collapseParam,
        resumeKey: input.resume_key?.trim() || undefined,
      },
      ctx,
    );

    if (histResult.records.length === 0) {
      throw ctx.fail(
        'no_snapshots',
        `No snapshots found for "${input.url}" with the specified filters.${histResult.notice ? ` ${histResult.notice}` : ''}`,
        ctx.recoveryFor('no_snapshots'),
      );
    }

    ctx.log.info('CDX history fetched', {
      url: input.url,
      count: histResult.records.length,
      hasResumeKey: !!histResult.resumeKey,
    });

    const shown = histResult.records.length;
    if (shown >= limit && !histResult.complete) {
      const clamped =
        limit < input.limit
          ? `limit ${input.limit} is above the cap of ${LIMIT_CAP.toLocaleString('en-US')} per call, so this page holds ${shown.toLocaleString('en-US')} captures. `
          : `This page holds ${shown.toLocaleString('en-US')} captures, the limit. `;
      ctx.enrich.truncated({
        shown,
        cap: limit,
        guidance:
          (histResult.resumeKey
            ? `${clamped}Pass this response's resume_key as resume_key for the next page.`
            : `${clamped}Narrow from and to to list the captures past it.`) +
          (histResult.notice ? ` ${histResult.notice}` : ''),
      });
    } else if (histResult.notice) {
      ctx.enrich.notice(histResult.notice);
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
      lines.push(`## ${escapeMarkdownInline(snap.timestamp)}`);
      lines.push(`**Replay URL:** ${markdownLink(snap.replay_url, snap.replay_url)}`);
      if (snap.statuscode) lines.push(`**Status:** ${escapeMarkdownInline(snap.statuscode)}`);
      if (snap.mimetype) lines.push(`**MIME:** ${escapeMarkdownInline(snap.mimetype)}`);
      if (snap.original_url)
        lines.push(`**Original URL:** ${markdownLink(snap.original_url, snap.original_url)}`);
      if (snap.digest) lines.push(`**Digest:** ${escapeMarkdownInline(snap.digest)}`);
      if (snap.length) lines.push(`**Length:** ${escapeMarkdownInline(snap.length)}`);
      lines.push('');
    }
    if (result.resume_key) {
      lines.push(`---`);
      lines.push(
        `**Resume Key:** ${escapeMarkdownInline(result.resume_key)} _(pass as resume_key to get the next page)_`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
