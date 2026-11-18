/**
 * @fileoverview Tests for the call deadline at its own seam: the budget rule (55 s, or the
 * request timeout when longer), the per-request timeout trimmed to what remains, the
 * pre-request refusal and its 1 ms spent margin, and which failures `isExpiry` claims — every
 * timeout and expiry produced by the real `fetchWithTimeout` and `withRetry` on a fake clock.
 * @module tests/services/call-deadline.test
 */

import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockResponder,
} from '@cyanheads/mcp-ts-core/testing';
import { defaultIsTransient, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ requestTimeoutMs: 30_000 }));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));

import { type CallDeadline, startCallDeadline } from '@/services/call-deadline.js';
import { isRetriedFailure, transportError } from '@/services/upstream-errors.js';

const URL_UNDER_TEST = 'https://upstream.example.test/slow';

/** Every request waits for its signal to abort, then rejects with the abort reason, as `fetch` does. */
const hang: FetchMockResponder = (request) =>
  new Promise((_, reject) => {
    if (request.signal.aborted) reject(request.signal.reason);
    request.signal.addEventListener('abort', () => reject(request.signal.reason));
  });

const http = createFetchMock([{ match: () => true, respond: hang }]);

/** The error a promise rejects with, once fake time has run every pending timer. */
const settle = async (pending: Promise<unknown>): Promise<unknown> => {
  const caught = pending.then(
    () => undefined,
    (err: unknown) => err,
  );
  await vi.runAllTimersAsync();
  return caught;
};

/** A request to the hanging upstream under `timeoutMs` and `signal`, as a service sends it. */
const request = (timeoutMs: number, signal: AbortSignal) =>
  fetchWithTimeout(URL_UNDER_TEST, timeoutMs, createMockContext(), { signal });

let caller: AbortController;
const start = (): CallDeadline => startCallDeadline(caller.signal);

beforeAll(() => {
  http.install();
});

afterAll(() => {
  http.restore();
});

beforeEach(() => {
  config.requestTimeoutMs = 30_000;
  caller = new AbortController();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the budget', () => {
  it.each([
    [1_000, 55],
    [30_000, 55],
    [55_000, 55],
    [55_500, 55.5],
    [90_000, 90],
  ])('is 55 s or the request timeout when longer (request timeout %i ms → %s s)', (ms, seconds) => {
    config.requestTimeoutMs = ms;
    const deadline = start();

    expect(deadline.budgetSeconds).toBe(seconds);
    expect(deadline.remainingMs()).toBe(seconds * 1000);
    expect(deadline.requestTimeoutMs).toBe(ms);
  });

  it('gives each request the full request timeout until less than that remains', () => {
    const deadline = start();
    expect(deadline.nextTimeoutMs()).toBe(30_000);

    vi.advanceTimersByTime(25_000);
    expect(deadline.nextTimeoutMs()).toBe(30_000);

    vi.advanceTimersByTime(6_000);
    expect(deadline.remainingMs()).toBe(24_000);
    expect(deadline.nextTimeoutMs()).toBe(24_000);
  });

  it('lets one request run a 90 s request timeout in full', () => {
    config.requestTimeoutMs = 90_000;
    expect(start().nextTimeoutMs()).toBe(90_000);
  });

  it('never reports a negative remainder past the deadline', () => {
    const deadline = start();
    vi.advanceTimersByTime(70_000);

    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.nextTimeoutMs()).toBe(0);
  });
});

describe('assertTimeLeft', () => {
  it('lets a request go with 2 ms left', () => {
    const deadline = start();
    vi.advanceTimersByTime(54_998);

    expect(() => deadline.assertTimeLeft()).not.toThrow();
  });

  it.each([
    ['1 ms left', 54_999],
    ['the deadline reached', 55_000],
    ['the deadline passed', 60_000],
  ])('refuses a request with %s, as an unretried Timeout naming the deadline', (_label, ms) => {
    const deadline = start();
    vi.advanceTimersByTime(ms);

    let thrown: unknown;
    try {
      deadline.assertTimeLeft();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect(thrown).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: expect.stringContaining('55 s call deadline'),
      data: { reason: 'retry_deadline_exceeded', retryable: false },
    });
    expect(defaultIsTransient(thrown)).toBe(false);
    expect(isRetriedFailure(thrown)).toBe(false);
    expect(deadline.isExpiry(thrown)).toBe(true);
  });

  it('stands aside once the caller has cancelled, so the request fails as a cancellation', async () => {
    const deadline = start();
    vi.advanceTimersByTime(60_000);
    caller.abort();

    expect(() => deadline.assertTimeLeft()).not.toThrow();
    await expect(request(deadline.nextTimeoutMs(), caller.signal)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
  });
});

describe('isExpiry', () => {
  it('claims a request whose timeout was cut to the time remaining', async () => {
    const deadline = start();
    vi.advanceTimersByTime(31_000);

    const err = await settle(request(deadline.nextTimeoutMs(), caller.signal));

    expect(deadline.remainingMs()).toBe(0);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { errorSource: 'FetchTimeout' },
    });
    expect(deadline.isExpiry(err)).toBe(true);
  });

  it('claims a cut request whose timer fired with 1 ms still showing, naming the deadline', async () => {
    const deadline = start();
    vi.advanceTimersByTime(31_000);

    const err = await settle(request(deadline.remainingMs() - 1, caller.signal));

    expect(deadline.remainingMs()).toBe(1);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { errorSource: 'FetchTimeout' },
    });
    expect(
      transportError(err, 'The upstream', deadline, { reason: 'upstream_unavailable' }),
    ).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'The upstream did not finish within the 55 s call deadline.',
      data: { reason: 'upstream_unavailable' },
    });
    expect(deadline.isExpiry(err)).toBe(true);
  });

  it('leaves a request that timed out on its own full timeout to the request timeout', async () => {
    const deadline = start();

    const err = await settle(request(deadline.nextTimeoutMs(), caller.signal));

    expect(deadline.remainingMs()).toBe(25_000);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { errorSource: 'FetchTimeout' },
    });
    expect(deadline.isExpiry(err)).toBe(false);
  });

  it('claims withRetry expiring mid-request and mid-backoff under the remaining budget', async () => {
    const deadline = start();
    vi.advanceTimersByTime(20_000);

    const midRequest = await settle(
      withRetry(({ signal }) => request(deadline.nextTimeoutMs(), signal), {
        signal: caller.signal,
        deadlineMs: deadline.remainingMs(),
      }),
    );
    expect(midRequest).toMatchObject({ data: { reason: 'retry_deadline_exceeded' } });
    expect(deadline.isExpiry(midRequest)).toBe(true);

    const later = start();
    vi.advanceTimersByTime(54_500);
    const midBackoff = await settle(
      withRetry(() => Promise.reject(serviceUnavailable('HTTP 503', { status: 503 })), {
        signal: caller.signal,
        deadlineMs: later.remainingMs(),
      }),
    );
    expect(midBackoff).toMatchObject({ data: { reason: 'retry_deadline_exceeded' } });
    expect(later.isExpiry(midBackoff)).toBe(true);
  });

  it.each([
    ["the caller's signal", () => caller],
    ['a timeout signal of its own', () => new AbortController()],
  ])(
    'never claims a request %s timed out (FetchSignalTimeout), even with the deadline spent',
    async (_label, timer) => {
      const deadline = start();
      vi.advanceTimersByTime(55_000);
      const timedOut = timer();
      timedOut.abort(new DOMException('The signal timed out.', 'TimeoutError'));

      const err = await settle(request(deadline.nextTimeoutMs(), timedOut.signal));

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { errorSource: 'FetchSignalTimeout' },
      });
      expect(deadline.isExpiry(err)).toBe(false);
    },
  );

  it.each([
    ['an upstream 503', serviceUnavailable('HTTP 503', { status: 503 })],
    ['a network error', serviceUnavailable('down', { errorSource: 'FetchNetworkErrorWrapper' })],
    ['a plain Error', new Error('boom')],
    ['a DOMException abort reason', new DOMException('aborted', 'AbortError')],
  ])('never claims %s, even with the deadline spent', (_label, err) => {
    const deadline = start();
    vi.advanceTimersByTime(55_000);

    expect(deadline.isExpiry(err)).toBe(false);
  });

  it('claims nothing once the caller has cancelled', async () => {
    const deadline = start();
    vi.advanceTimersByTime(31_000);
    const cut = await settle(request(deadline.nextTimeoutMs(), new AbortController().signal));
    let refused: unknown;
    try {
      deadline.assertTimeLeft();
    } catch (err) {
      refused = err;
    }
    expect(deadline.isExpiry(cut)).toBe(true);
    expect(deadline.isExpiry(refused)).toBe(true);

    caller.abort();

    expect(deadline.isExpiry(cut)).toBe(false);
    expect(deadline.isExpiry(refused)).toBe(false);
  });
});
