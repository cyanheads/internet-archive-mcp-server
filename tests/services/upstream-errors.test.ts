/**
 * @fileoverview Tests for `transportError`, the one mapping every service applies to a request
 * left without a usable answer: the call deadline running out (named in the message), a
 * request's own timeout, a network error, a redirect chain `fetchWithTimeout` refuses to follow,
 * and the failures it leaves as they are. Then `unansweredRequestError`, the part after the
 * deadline that a single request sent under its own limit uses directly: the limit it names,
 * one attempt's network error, and the deadline it leaves to its caller. Error shapes come from
 * the real `fetchWithTimeout` and `withRetry` on a fake clock.
 * @module tests/services/upstream-errors.test
 */

import {
  JsonRpcErrorCode,
  McpError,
  requestCancelled,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockResponder,
} from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ requestTimeoutMs: 30_000 }));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));

import { type CallDeadline, startCallDeadline } from '@/services/call-deadline.js';
import {
  isRetriedFailure,
  rateLimitError,
  transportError,
  unansweredRequestError,
} from '@/services/upstream-errors.js';

const UPSTREAM = 'The Example API';

/** The calling tool's declared reason and hint, as a service passes them. */
const DECLARED = { reason: 'example_unavailable', recovery: { hint: 'Retry in a few minutes.' } };

/** Every request waits for its signal to abort, then rejects with the abort reason. */
const hang: FetchMockResponder = (request) =>
  new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason));
  });

/** An upstream that redirects every request to itself, and one that redirects off the web. */
const LOOP = 'https://loop.example.test/';
const OFF_WEB = 'https://off-web.example.test/';
const redirectTo = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });

const http = createFetchMock([
  { match: LOOP, respond: redirectTo(LOOP) },
  { match: OFF_WEB, respond: redirectTo('ftp://files.example.test/a.txt') },
  { match: () => true, respond: hang },
]);

/** The error a promise rejects with, once fake time has run every pending timer. */
const settle = async (pending: Promise<unknown>): Promise<unknown> => {
  const caught = pending.then(
    () => undefined,
    (err: unknown) => err,
  );
  await vi.runAllTimersAsync();
  return caught;
};

const request = (timeoutMs: number, signal: AbortSignal, url = 'https://upstream.example.test/') =>
  fetchWithTimeout(url, timeoutMs, createMockContext(), { signal });

/** A ladder whose attempt fails with `answer` after `afterMs`, under the deadline's remainder. */
const ladder = (deadline: CallDeadline, answer: McpError, afterMs: number) =>
  withRetry(
    () =>
      new Promise((_, reject) => {
        setTimeout(() => reject(answer), afterMs);
      }),
    { signal: caller.signal, deadlineMs: deadline.remainingMs() },
  );

/** The mapped error's `data`, without the Symbol-keyed markers a full `toEqual` would see. */
const dataOf = (err: unknown) => Object.fromEntries(Object.entries((err as McpError).data ?? {}));

let caller: AbortController;

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

describe('transportError under the call deadline', () => {
  const expectDeadline = (mapped: unknown, cause: unknown, seconds = 55) => {
    expect(mapped).toBeInstanceOf(McpError);
    expect(mapped).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: `${UPSTREAM} did not finish within the ${seconds} s call deadline.`,
    });
    expect(dataOf(mapped)).toEqual(DECLARED);
    expect((mapped as McpError).cause).toBe(cause);
  };

  it('names the deadline for a request cut to the time remaining, not the request timeout', async () => {
    const deadline = startCallDeadline(caller.signal);
    vi.advanceTimersByTime(31_000);
    const err = await settle(request(deadline.nextTimeoutMs(), caller.signal));

    expectDeadline(transportError(err, UPSTREAM, deadline, DECLARED), err);
  });

  it('names the deadline when it runs out mid-backoff after a 503', async () => {
    const deadline = startCallDeadline(caller.signal);
    vi.advanceTimersByTime(54_000);
    const err = await settle(
      ladder(deadline, serviceUnavailable('HTTP 503', { status: 503 }), 500),
    );

    expect(err).toMatchObject({ data: { reason: 'retry_deadline_exceeded' } });
    expectDeadline(transportError(err, UPSTREAM, deadline, DECLARED), err);
  });

  it('names the deadline when no time is left to send a request', () => {
    const deadline = startCallDeadline(caller.signal);
    vi.advanceTimersByTime(55_000);
    let err: unknown;
    try {
      deadline.assertTimeLeft();
    } catch (refusal) {
      err = refusal;
    }

    expectDeadline(transportError(err, UPSTREAM, deadline, DECLARED), err);
  });

  it('reports a 429 that completed as the deadline ran out as the 429', async () => {
    const deadline = startCallDeadline(caller.signal);
    const limited = rateLimitError(
      new McpError(JsonRpcErrorCode.RateLimited, 'HTTP 429', { status: 429, retryAfter: '60' }),
      UPSTREAM,
      UPSTREAM,
      'example_unavailable',
    );
    const err = await settle(ladder(deadline, limited, 55_000));

    expect(err).toMatchObject({ data: { reason: 'retry_deadline_exceeded' } });
    expect((err as McpError).cause).toBe(limited);
    expect(transportError(err, UPSTREAM, deadline, DECLARED)).toBe(limited);
  });

  it('reports a refusal that completed as the deadline ran out as the refusal', async () => {
    const deadline = startCallDeadline(caller.signal);
    // Shaped as the lookup services refuse a 4xx no retry fixes.
    const refused = serviceUnavailable(`${UPSTREAM} returned HTTP 400.`, {
      reason: 'example_unavailable',
      status: 400,
      retryable: false,
      recovery: { hint: 'Check the request.' },
    });
    const err = await settle(ladder(deadline, refused, 55_000));

    expect(err).toMatchObject({ data: { reason: 'retry_deadline_exceeded' } });
    expect((err as McpError).cause).toBe(refused);
    expect(transportError(err, UPSTREAM, deadline, DECLARED)).toBe(refused);
  });

  it('names a 90 s deadline when the request timeout is 90 s, after one full request', async () => {
    config.requestTimeoutMs = 90_000;
    const deadline = startCallDeadline(caller.signal);
    const sent = Date.now();
    const err = await settle(request(deadline.nextTimeoutMs(), caller.signal));

    expect(Date.now() - sent).toBe(90_000);
    expectDeadline(transportError(err, UPSTREAM, deadline, DECLARED), err, 90);
  });
});

describe('transportError inside the call deadline', () => {
  it('names the request timeout for a request that timed out on its full timeout', async () => {
    const deadline = startCallDeadline(caller.signal);
    const err = await settle(request(deadline.nextTimeoutMs(), caller.signal));
    const mapped = transportError(err, UPSTREAM, deadline, DECLARED);

    expect(mapped).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: `${UPSTREAM} timed out after 30 s.`,
    });
    expect(dataOf(mapped)).toEqual(DECLARED);
  });

  it('names the attempts of a network error', () => {
    const deadline = startCallDeadline(caller.signal);
    const err = serviceUnavailable('fetch failed', {
      errorSource: 'FetchNetworkErrorWrapper',
      retryAttempts: 4,
    });

    expect(transportError(err, UPSTREAM, deadline, DECLARED)).toMatchObject({
      message: `${UPSTREAM} could not be reached (network error, 4 attempts).`,
      data: { ...DECLARED, retryAttempts: 4 },
    });
  });

  it.each([
    ['a mapped upstream status', serviceUnavailable('HTTP 503', { ...DECLARED, status: 503 })],
    ['a caller cancellation', requestCancelled('aborted', { errorSource: 'FetchAborted' })],
    ['a plain Error', new Error('boom')],
  ])('returns %s as it is', (_label, err) => {
    const deadline = startCallDeadline(caller.signal);
    vi.advanceTimersByTime(55_000);

    expect(transportError(err, UPSTREAM, deadline, DECLARED)).toBe(err);
  });

  it('never names the deadline once the caller has cancelled', async () => {
    const deadline = startCallDeadline(caller.signal);
    vi.advanceTimersByTime(54_000);
    const expiry = await settle(
      ladder(deadline, serviceUnavailable('HTTP 503', { status: 503 }), 500),
    );
    let refusal: unknown;
    try {
      deadline.assertTimeLeft();
    } catch (err) {
      refusal = err;
    }
    caller.abort();

    expect(transportError(expiry, UPSTREAM, deadline, DECLARED)).toBe(expiry);
    expect(transportError(refusal, UPSTREAM, deadline, DECLARED)).toBe(refusal);
  });
});

describe('transportError for a redirect chain fetchWithTimeout refuses to follow', () => {
  it.each([
    [
      'a chain past its hop limit',
      LOOP,
      'too_many_redirects',
      128,
      'redirected more than 127 times',
    ],
    [
      'a hop to a URL that is not HTTP or HTTPS',
      OFF_WEB,
      'invalid_url',
      1,
      'redirected to a URL that is not HTTP or HTTPS',
    ],
  ])(
    'names %s under the declared reason and hint, in place of the hint to request another URL',
    async (_label, url, reason, requests, what) => {
      const deadline = startCallDeadline(caller.signal);
      const sent = http.calls.length;
      const err = await settle(request(deadline.nextTimeoutMs(), caller.signal, url));

      // The framework's refusal, as a service's retry ladder receives it: answered at once.
      expect(err).toMatchObject({ code: JsonRpcErrorCode.ValidationError, data: { reason } });
      expect(http.calls.length - sent).toBe(requests);
      expect(isRetriedFailure(err)).toBe(false);

      const mapped = transportError(err, UPSTREAM, deadline, DECLARED);
      expect(mapped).toBeInstanceOf(McpError);
      expect(mapped).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: `${UPSTREAM} ${what}.`,
      });
      expect(dataOf(mapped)).toEqual(DECLARED);
      expect((mapped as McpError).cause).toBe(err);
    },
  );

  it.each([
    ['another reason', validationError('Blocked.', { reason: 'private_address_blocked' })],
    ['no reason', validationError('Bad input.')],
  ])('returns a ValidationError with %s as it is', (_label, err) => {
    const deadline = startCallDeadline(caller.signal);

    expect(transportError(err, UPSTREAM, deadline, DECLARED)).toBe(err);
  });
});

describe('unansweredRequestError for one request sent under its own limit', () => {
  it('names the limit the request was sent under, not the request timeout', async () => {
    const err = await settle(request(25_000, caller.signal));
    const mapped = unansweredRequestError(err, UPSTREAM, 25_000, DECLARED);

    expect(mapped).toBeInstanceOf(McpError);
    expect(mapped).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: `${UPSTREAM} timed out after 25 s.`,
    });
    expect(dataOf(mapped)).toEqual(DECLARED);
    expect((mapped as McpError).cause).toBe(err);
  });

  it('names a network error from one attempt without an attempt count', () => {
    const err = serviceUnavailable(
      'Network error during fetch GET https://upstream.example.test/',
      { errorSource: 'FetchNetworkErrorWrapper' },
    );
    const mapped = unansweredRequestError(err, UPSTREAM, 25_000, DECLARED);

    expect(mapped).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: `${UPSTREAM} could not be reached (network error).`,
    });
    expect(dataOf(mapped)).toEqual(DECLARED);
    expect((mapped as McpError).cause).toBe(err);
  });

  it('names a redirect loop as transportError does', async () => {
    const err = await settle(request(25_000, caller.signal, LOOP));

    expect(unansweredRequestError(err, UPSTREAM, 25_000, DECLARED)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: `${UPSTREAM} redirected more than 127 times.`,
    });
  });

  it('leaves the call deadline to its caller, returning an expiry as it is', async () => {
    const deadline = startCallDeadline(caller.signal);
    vi.advanceTimersByTime(54_000);
    const expiry = await settle(
      ladder(deadline, serviceUnavailable('HTTP 503', { status: 503 }), 500),
    );

    expect(expiry).toMatchObject({ data: { reason: 'retry_deadline_exceeded' } });
    expect(unansweredRequestError(expiry, UPSTREAM, 25_000, DECLARED)).toBe(expiry);
  });

  it.each([
    ['a mapped upstream status', serviceUnavailable('HTTP 503', { ...DECLARED, status: 503 })],
    ['a caller cancellation', requestCancelled('aborted', { errorSource: 'FetchAborted' })],
    ['a plain Error', new Error('boom')],
  ])('returns %s as it is', (_label, err) => {
    expect(unansweredRequestError(err, UPSTREAM, 25_000, DECLARED)).toBe(err);
  });
});
