/**
 * @fileoverview Tool for finding Wayback Machine snapshots of a URL.
 * @module mcp-server/tools/definitions/ia-find-snapshots
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { startCallDeadline } from '@/services/call-deadline.js';
import { readCaptureTarget } from '@/services/wayback/wayback-capture-url.js';
import { getWaybackService } from '@/services/wayback/wayback-service.js';
import { TIMESTAMP_FORMS, waybackTimestamp } from '@/services/wayback/wayback-timestamp.js';

const WAYBACK_WEB = 'https://web.archive.org/web';

/** CDX records returned per call. A larger history-mode `limit` is sent to CDX as this cap. */
const LIMIT_CAP = 10_000;

/** The largest `limit` accepted: the CDX server's documented per-query maximum. */
const LIMIT_CEILING = 150_000;

export const iaFindSnapshots = tool('ia_find_snapshots', {
  title: 'Find Wayback Machine Snapshots',
  description:
    'Find Wayback Machine snapshots of a URL. Mode "closest" returns the single nearest capture to a given timestamp, or the latest capture when timestamp is omitted, via the Availability API, falling back to a CDX closest-capture query when the Availability API finds no capture or answers with a rate limit, a server error, an unreadable response, or an error in place of a capture (one result). Mode "history" returns the full capture list via the CDX API — filterable by date range and HTTP status code, collapsed by default to one capture per day (collapse "timestamp:8"); collapse "timestamp:14" lists one row per distinct capture second. Use history mode to survey how a page changed over time; use closest mode when you need the snapshot nearest a specific date. History mode returns up to limit records (at most 10,000 per call) and supports resume-key pagination for URLs with very large capture histories.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    url: z
      .string()
      .trim()
      .min(1, 'Must not be blank — provide the URL to look up.')
      .describe(
        "The URL to look up in the Wayback Machine. A Wayback capture URL — web.archive.org/web/<timestamp>/<url>, such as a replay_url — reads as the URL it archives: history mode lists that URL's captures, and closest mode looks up its timestamp, where a timestamp naming a different one fails as ambiguous_timestamp.",
      ),
    mode: z
      .enum(['closest', 'history'])
      .describe(
        'Lookup mode: "closest" returns the single nearest snapshot to the given timestamp, or the latest capture when timestamp is omitted; "history" returns the paginated full capture list via the CDX API.',
      ),
    timestamp: z
      .string()
      .optional()
      .describe(
        'Target timestamp for mode "closest": 1–14 digits — YYYYMMDDHHMMSS or a prefix of it, such as "20200615" — or an ISO 8601 date or UTC date-time such as "2020-06-15" or "2020-06-15T12:34:56Z". A shorter value names a period and resolves to the capture nearest its end: "2015" can resolve to one from early January 2016. Omitted or blank, it is the timestamp of a Wayback capture URL passed as url, else the latest capture.',
      ),
    from: z
      .string()
      .optional()
      .describe(
        'Start of the date range (history mode only): 1–14 digits — YYYYMMDDHHMMSS or a prefix of it — or an ISO 8601 date or UTC date-time such as "2020-01-01". A prefix starts at the beginning of the period it names: "2015" is January 1, 2015.',
      ),
    to: z
      .string()
      .optional()
      .describe(
        'End of the date range (history mode only), in the same forms as from, and inclusive: a prefix ends at the end of the period it names, so "2015" reaches December 31, 2015, and "20231231" the end of that day.',
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
        'Filter CDX results to a specific HTTP status code (history mode only). Must be a 3-digit numeric code. Example: "200" to return only successful captures.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMIT_CEILING)
      .default(100)
      .describe(
        'Maximum number of CDX records to return (history mode only, default 100). One call returns at most 10,000: a larger value (up to 150,000) is served as 10,000, and the resume_key continues from there.',
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
        'CDX collapse parameter (history mode only). Format: "timestamp:N" where N is 1–14 (4=year, 6=month, 8=day, 10=hour, 14=second): consecutive captures sharing the first N timestamp digits are listed once. Omitted or blank, it is "timestamp:8", one capture per day. Pass "timestamp:14" for one row per distinct capture second.',
      ),
    resume_key: z
      .string()
      .optional()
      .describe(
        'Opaque pagination key from a previous history mode response. Pass this to continue from where the last page left off. Server cursors expire after one hour and bind the URL and original filters; omit filters on continuation or repeat their original values. Page size may change. Wildcard and legacy raw continuations can omit collapsed captures.',
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
      reason: 'invalid_timestamp',
      code: JsonRpcErrorCode.ValidationError,
      when: 'timestamp (closest mode), from, or to (history mode) is not 1–14 digits or an ISO 8601 date or UTC date-time, or names a month, day, hour, minute, or second no Gregorian date and time has; or url is a Wayback capture URL whose timestamp is not 1–14 digits naming a real date and time (field "url").',
      recovery:
        'Set the named field to 1–14 digits (YYYYMMDDHHMMSS or a prefix of it, such as "20200615") or an ISO 8601 date or UTC date-time such as "2020-06-15" or "2020-06-15T12:34:56Z".',
      severity: 'warning',
    },
    {
      reason: 'ambiguous_timestamp',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Closest mode: url is a Wayback capture URL and timestamp names a different timestamp than the one the URL carries.',
      recovery:
        'Pass the URL the capture archives as url with the timestamp meant, or omit timestamp to find the capture the URL names.',
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
      when: 'Closest mode: no capture exists near the requested timestamp for this URL, or, with no timestamp, none exists at all. Either mode: the Wayback Machine does not serve captures of this URL at all — the CDX or Availability API answered HTTP 403, 410, or 451, as it does for a site excluded from the archive.',
      recovery:
        'Try a different timestamp or switch to history mode to discover what snapshots exist.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'cdx_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The Wayback CDX API answered HTTP 5xx after retries or 429, refused the request with another 4xx, did not answer within the request timeout, could not be reached, returned an unreadable response, or did not finish within the call's 55 s deadline (the request timeout when that is longer); in closest mode, the Availability API found no capture and the CDX closest-capture check it fell back to failed, did not complete in time, or had no time left.",
      recovery:
        'The Wayback CDX API is temporarily overloaded or unreachable; retry in a few seconds. A query that keeps timing out needs a narrower from and to range or a smaller limit.',
      thrownBy: 'service',
    },
    {
      reason: 'availability_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "Closest mode: the Wayback Availability API answered HTTP 429, or 408, 425, or 5xx after retries, an unreadable response, or an error in place of a capture, and the CDX closest-capture check it fell back to failed too or had no time left within the call's 55 s deadline (the request timeout when that is longer); or the Availability API refused the request with another 4xx, did not answer within the request timeout or that deadline, or could not be reached, none of which falls back.",
      recovery:
        'Retry in a few seconds, or use history mode with from and to around the timestamp to list nearby captures.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const deadline = startCallDeadline(ctx.signal);
    const svc = getWaybackService();

    // Before any request: a Wayback capture URL reads as its original URL, and in closest
    // mode its timestamp stands in for a blank one; history mode reads neither timestamp.
    const target = readCaptureTarget(
      input.url,
      input.mode === 'closest' ? input.timestamp : undefined,
    );
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

    /**
     * A history-mode bound as CDX reads it, checked before any request: undefined when
     * blank, rejected when CDX would misread it. Each mode reads only its own fields.
     */
    const timestampOf = (field: 'from' | 'to'): string | undefined => {
      const value = input[field]?.trim();
      if (!value) return;
      const digits = waybackTimestamp(value);
      if (digits === undefined) {
        throw ctx.fail('invalid_timestamp', `${field} must be ${TIMESTAMP_FORMS}.`, {
          field,
          ...ctx.recoveryFor('invalid_timestamp'),
        });
      }
      return digits;
    };

    if (input.mode === 'closest') {
      // No timestamp, from either source, looks up the latest capture.
      const result = await svc.findClosest(url, timestamp, ctx, deadline);
      ctx.log.info('Closest snapshot found', { url, timestamp: result.timestamp });

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
        url,
        from: timestampOf('from'),
        to: timestampOf('to'),
        statusFilter: input.status_filter?.trim() || undefined,
        limit,
        collapse: collapseParam,
        resumeKey: input.resume_key?.trim() || undefined,
      },
      ctx,
      deadline,
    );

    if (histResult.records.length === 0) {
      throw ctx.fail(
        'no_snapshots',
        `No snapshots found for "${url}" with the specified filters.${histResult.notice ? ` ${histResult.notice}` : ''}`,
        ctx.recoveryFor('no_snapshots'),
      );
    }

    ctx.log.info('CDX history fetched', {
      url,
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
      replay_url: `${WAYBACK_WEB}/${r.timestamp}/${r.original || url}`,
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
