/**
 * @fileoverview The deadline one tool or resource call runs under: 55 s, or `IA_REQUEST_TIMEOUT_MS`
 * when that is longer, started by the handler before any request and passed to each service
 * method it calls. Every request the call chains gets the request timeout or what remains,
 * whichever is less, and every retry ladder runs under `withRetry`'s `deadlineMs` set to what
 * remains, so the call settles before the 60 s an MCP SDK client waits by default.
 * @module services/call-deadline
 */

import { McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';

/**
 * The shortest call deadline. A default MCP SDK client gives up on a request after 60 s; the
 * 5 s left over cover the request's trip in, the work after the last upstream byte, and the
 * response's trip back.
 */
const DEADLINE_FLOOR_MS = 55_000;

/**
 * A remainder this small counts as spent: Node can fire a timer aimed at the deadline while
 * `Date.now()` still shows 1 ms left, and a request sent with 1 ms could only time out.
 */
const SPENT_MS = 1;

/** One call's deadline; see `startCallDeadline`. */
export interface CallDeadline {
  /**
   * Throws a `Timeout` with `data.reason: 'retry_deadline_exceeded'` and `retryable: false`
   * when 1 ms or less remains, so no request is sent that could only time out; the retry
   * predicates refuse it. Does nothing once the caller's signal has aborted, so the request
   * fails as the cancellation it is.
   */
  assertTimeLeft(): void;
  /** The whole budget in seconds, for messages ("the 55 s call deadline"). */
  readonly budgetSeconds: number;
  /**
   * Whether `err` is this deadline ending the call — `withRetry`'s `retry_deadline_exceeded`
   * (mid-request or mid-backoff), `assertTimeLeft`'s refusal, or a request's own timeout
   * (`FetchTimeout`) that fired with the deadline spent, which is a request cut to the time
   * remaining — and not a request timing out on its own, nor a caller cancellation (always
   * false once the signal aborted). A request whose signal timed out (`FetchSignalTimeout`) is
   * never claimed: the one clock that aborts request signals is `withRetry`'s, which reports
   * that abort as `retry_deadline_exceeded`, and any other is the caller's.
   */
  isExpiry(err: unknown): boolean;
  /** The timeout for the next request: `requestTimeoutMs`, or what remains when that is less. */
  nextTimeoutMs(): number;
  /** Milliseconds left, never negative: `withRetry`'s `deadlineMs` for a ladder starting now. */
  remainingMs(): number;
  /** `IA_REQUEST_TIMEOUT_MS`: the timeout a request gets while the deadline is further off. */
  readonly requestTimeoutMs: number;
}

/**
 * Start a call's deadline now. `signal` is the caller's (`ctx.signal`): once it aborts, the
 * deadline neither refuses requests nor claims failures, so cancellation stays
 * `RequestCancelled`. Holds no timer — the clock is `Date.now()`.
 */
export function startCallDeadline(signal: AbortSignal): CallDeadline {
  const { requestTimeoutMs } = getServerConfig();
  const budgetMs = Math.max(DEADLINE_FLOOR_MS, requestTimeoutMs);
  const endsAt = Date.now() + budgetMs;
  const remainingMs = () => Math.max(0, endsAt - Date.now());

  return {
    budgetSeconds: budgetMs / 1000,
    requestTimeoutMs,
    remainingMs,
    nextTimeoutMs: () => Math.min(requestTimeoutMs, remainingMs()),
    assertTimeLeft() {
      if (signal.aborted || remainingMs() > SPENT_MS) return;
      throw timeout(`The ${budgetMs / 1000} s call deadline ran out before the next request.`, {
        reason: 'retry_deadline_exceeded',
        retryable: false,
      });
    },
    isExpiry(err) {
      if (signal.aborted || !(err instanceof McpError)) return false;
      if (err.data?.reason === 'retry_deadline_exceeded') return true;
      return err.data?.errorSource === 'FetchTimeout' && remainingMs() <= SPENT_MS;
    },
  };
}
