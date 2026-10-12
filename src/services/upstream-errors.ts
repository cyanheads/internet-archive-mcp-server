/**
 * @fileoverview Upstream failure classification shared by the Advanced Search, Metadata, and
 * Wayback services: the HTTP status a fetch error carries, the wait a 429 names, transport failures
 * (a request timeout, a network error, a connection dropped mid-body), and the retry
 * predicate built on them.
 * @module services/upstream-errors
 */

import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient } from '@cyanheads/mcp-ts-core/utils';

/** `errorSource` of a body read the connection dropped under, tagged so `transportFailure` sees a network error. */
const BODY_READ_NETWORK_ERROR = 'BodyReadNetworkError';

/** The upstream HTTP status a `fetchWithTimeout` error carries, if it came from a response. */
export function statusOf(err: unknown): number | undefined {
  const status = err instanceof McpError ? err.data?.statusCode : undefined;
  return typeof status === 'number' ? status : undefined;
}

/**
 * How long a rate-limited caller should wait, from a `Retry-After` value when one was sent:
 * delta-seconds, or an HTTP-date still in the future. Anything else — a fractional or
 * negative number, a past date, no header — falls back to several minutes.
 */
export function waitPhrase(retryAfter: unknown): string {
  if (typeof retryAfter === 'string' && /^\d+$/.test(retryAfter.trim())) {
    return `wait ${retryAfter.trim()} seconds`;
  }
  const until = typeof retryAfter === 'string' ? Date.parse(retryAfter) : Number.NaN;
  return Number.isNaN(until) || until <= Date.now()
    ? 'wait several minutes'
    : `wait until ${new Date(until).toUTCString()}`;
}

/**
 * A 429 from `name`, rethrown as `ServiceUnavailable` with `status: 429`, the `Retry-After`
 * value, and a hint to wait that opens with `hintSubject`. `isRetriedFailure` answers it after
 * one request — the upstream asked the client to slow down, so retrying would only extend the
 * limit — while the wire says when to call again rather than that it never can.
 */
export function rateLimitError(
  err: unknown,
  name: string,
  hintSubject: string,
  reason?: string,
): McpError {
  const { retryAfter } = (err as McpError).data ?? {};
  return serviceUnavailable(
    `${name} returned HTTP 429 (rate limited).`,
    {
      ...(reason && { reason }),
      status: 429,
      ...(retryAfter !== undefined && { retryAfter }),
      recovery: {
        hint: `${hintSubject} is rate-limiting requests; ${waitPhrase(retryAfter)} before retrying.`,
      },
    },
    { cause: err },
  );
}

/** Whether a response body is an HTML page — what the upstream APIs serve when overloaded — rather than JSON. */
export function isHtmlPage(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

/**
 * A response body read that failed below HTTP — the connection dropped after the headers —
 * as a retryable network error from `upstream`. The fetch's own deadline and a caller
 * cancellation already arrive as `McpError` and pass through.
 */
export function bodyReadError(err: unknown, upstream: string): unknown {
  if (err instanceof McpError) return err;
  return serviceUnavailable(
    `${upstream} dropped the connection mid-response.`,
    { errorSource: BODY_READ_NETWORK_ERROR },
    { cause: err },
  );
}

/**
 * How a request failed below HTTP: `fetchWithTimeout`'s own deadline expiring on the headers
 * or the body, or a network error — before the response, or a connection dropped mid-body.
 * A caller cancellation or a caller-side deadline (`FetchSignalTimeout`) is neither.
 */
export function transportFailure(err: unknown): 'network' | 'timeout' | undefined {
  const source = err instanceof McpError ? err.data?.errorSource : undefined;
  return source === 'FetchTimeout'
    ? 'timeout'
    : source === 'FetchNetworkErrorWrapper' || source === BODY_READ_NETWORK_ERROR
      ? 'network'
      : undefined;
}

/**
 * The retry predicate for an upstream request: the framework default, except that a request
 * timeout is answered after one attempt — it already waited the full request timeout on an
 * upstream that did not answer — and so is a 429, whose wait hint, not this loop, sets when
 * to call again. The Metadata service retries a first timeout once on top of this.
 */
export function isRetriedFailure(err: unknown): boolean {
  if (transportFailure(err) === 'timeout') return false;
  if (err instanceof McpError && err.data?.status === 429) return false;
  return defaultIsTransient(err);
}

/**
 * A transport failure from `upstream` rethrown as `ServiceUnavailable` carrying `data` (the
 * calling tool's declared reason and hint) and, after a network error, the attempts made.
 * Any other error is returned as it is.
 */
export function transportError(
  err: unknown,
  upstream: string,
  timeoutMs: number,
  data: Record<string, unknown>,
): unknown {
  const failure = transportFailure(err);
  if (!failure) return err;
  const { retryAttempts } = (err as McpError).data ?? {};
  return serviceUnavailable(
    failure === 'timeout'
      ? `${upstream} timed out after ${timeoutMs / 1000} s.`
      : `${upstream} could not be reached (network error${retryAttempts ? `, ${retryAttempts} attempts` : ''}).`,
    { ...data, ...(retryAttempts !== undefined && { retryAttempts }) },
    { cause: err },
  );
}
