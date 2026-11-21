/**
 * @fileoverview Tests for WaybackService following replay redirects itself. Each request is
 * answered with the response Wayback sends for that URL — a 3xx with its `Location` stays a
 * 3xx — through the real fetchWithTimeout and the real retry loop, with only the HTTP
 * boundary stubbed: both redirect kinds under every 3xx status, absolute and relative
 * Locations, a hop to the wayback.archive.org alias, the archived redirects a chain passes
 * through, every dead end on the first hop and later ones and the requests it costs, the
 * 10-redirect limit, transient failures on a later hop, the call deadline and cancellation
 * mid-chain, and the `id_` read. One case runs the runtime's own `fetch` against a loopback
 * server answering as Wayback does.
 * @module tests/services/wayback-redirects.test
 */

import { createServer, type Server } from 'node:http';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createFetchMock,
  createMockContext,
  type FetchMockResponder,
} from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** The real fetchWithTimeout behind a spy, so a test can read the timeout and options each request was sent with. */
const fetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  fetchWithTimeout: (...args: Parameters<typeof fetchWithTimeout>) => fetchWithTimeout(...args),
}));

import { iaGetSnapshot } from '@/mcp-server/tools/definitions/ia-get-snapshot.tool.js';
import { startCallDeadline } from '@/services/call-deadline.js';
import { WaybackService } from '@/services/wayback/wayback-service.js';

const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
  '@cyanheads/mcp-ts-core/utils',
);

const WEB = 'https://web.archive.org/web';

/** The replay URL of `url` at `timestamp`. */
const at = (timestamp: string, url: string) => `${WEB}/${timestamp}/${url}`;

/** The `Memento-Datetime` Wayback sends with a capture taken at the 14-digit `timestamp`. */
const httpDate = (timestamp: string) =>
  new Date(
    timestamp.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/, '$1-$2-$3T$4:$5:$6Z'),
  ).toUTCString();

/** Wayback's own jump to the nearest capture: a 302, unless `status` says otherwise, with `x-archive-redirect-reason` and no Memento-Datetime. */
const nearest =
  (location: string, status = 302): FetchMockResponder =>
  () =>
    new Response(null, {
      status,
      headers: { location, 'x-archive-redirect-reason': 'found capture at 20200101000000' },
    });

/**
 * The replay of a capture that is itself an archived redirect: the status the site sent,
 * the capture's Memento-Datetime, and its `Location` as Wayback rewrote it, if it had one.
 */
const archived =
  (status: number, timestamp: string, location?: string): FetchMockResponder =>
  () =>
    new Response(null, {
      status,
      headers: {
        'memento-datetime': httpDate(timestamp),
        ...(location !== undefined && { location }),
      },
    });

/** A capture replayed as an HTML page. */
const page =
  (html: string, contentType = 'text/html'): FetchMockResponder =>
  () =>
    new Response(html, { headers: { 'content-type': contentType } });

/** Wayback's answer for a URL it has not archived: a 404 with no Memento-Datetime. */
const NOT_ARCHIVED: FetchMockResponder = () =>
  new Response('Wayback Machine has not archived that URL.', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  });

const upstream = createFetchMock();

/** A catch-all registered last: answers any other request with a 400 and records it, so an extra hop shows in the request count. */
const routeUnrouted = () =>
  upstream.route({ match: () => true, respond: () => new Response('unrouted', { status: 400 }) });

/** Routes each URL to the response Wayback sends for it, then the catch-all. */
const serve = (routes: Record<string, FetchMockResponder>) => {
  for (const [match, respond] of Object.entries(routes)) upstream.route({ match, respond });
  routeUnrouted();
};

/** The URLs requested, in order. */
const requested = () => upstream.calls.map((c) => c.request.url);

const buildService = () =>
  new WaybackService({ mcpServerVersion: '0.0.0-test' } as AppConfig, {} as StorageService);

/** fetchContent of `snapshotUrl` under a fresh call deadline, as ia_get_snapshot calls it. */
const fetchContent = (snapshotUrl: string, signal?: AbortSignal) => {
  const ctx = createMockContext({ errors: iaGetSnapshot.errors, ...(signal && { signal }) });
  return buildService().fetchContent(snapshotUrl, ctx, startCallDeadline(ctx.signal));
};

/** What `run` threw. */
const failure = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error('expected a failure');
    },
    (err: unknown) => err as McpError,
  );

/** Runs `run` on the fake clock, so the real retry loop's backoff elapses at once. */
const withRetries = async <T>(run: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers();
  const pending = run();
  await vi.runAllTimersAsync();
  return pending;
};

/** A chain of `count` nearest-capture redirects from `first` to a served page, keyed by URL. */
const nearestChain = (count: number) => {
  const hop = (i: number) =>
    at(`202001010000${String(i).padStart(2, '0')}`, 'https://example.com/');
  const routes: Record<string, FetchMockResponder> = {};
  for (let i = 0; i < count; i++) routes[hop(i)] = nearest(hop(i + 1));
  routes[hop(count)] = page('<p>end of the chain</p>');
  return { first: hop(0), last: hop(count), routes };
};

beforeEach(() => {
  fetchWithTimeout.mockReset();
  fetchWithTimeout.mockImplementation(actual.fetchWithTimeout);
});

describe('fetchContent following replay redirects (#63)', () => {
  beforeAll(() => upstream.install());
  afterAll(() => upstream.restore());
  beforeEach(() => upstream.reset());
  afterEach(() => vi.useRealTimers());

  const PROMPT_TS = '20250805171636';
  const REQUESTED = at(PROMPT_TS, 'http://example.com/docs/report.pdf');
  const TARGET = 'http://redirected.example.org/';
  const TARGET_AT_TS = at(PROMPT_TS, TARGET);
  const SERVED = at('20250828072413', TARGET);

  it.each<
    [
      name: string,
      start: string,
      routes: Record<string, FetchMockResponder>,
      expected: { replayUrl: string; timestamp: string; redirects?: unknown },
      requests: string[],
    ]
  >([
    [
      'a capture served without a redirect',
      at('20200104000551', 'https://example.com/'),
      { [at('20200104000551', 'https://example.com/')]: page('<p>page</p>') },
      { replayUrl: at('20200104000551', 'https://example.com/'), timestamp: '20200104000551' },
      [at('20200104000551', 'https://example.com/')],
    ],
    [
      'a nearest-capture redirect with an absolute Location',
      at('20200104000000', 'https://example.com/'),
      {
        [at('20200104000000', 'https://example.com/')]: nearest(
          at('20200104000551', 'https://example.com/'),
        ),
        [at('20200104000551', 'https://example.com/')]: page('<p>page</p>'),
      },
      { replayUrl: at('20200104000551', 'https://example.com/'), timestamp: '20200104000551' },
      [at('20200104000000', 'https://example.com/'), at('20200104000551', 'https://example.com/')],
    ],
    [
      'a nearest-capture redirect to an http web.archive.org URL, reported in its https form',
      at('20200104000000', 'https://example.com/'),
      {
        [at('20200104000000', 'https://example.com/')]: nearest(
          'http://web.archive.org/web/20200104000551/https://example.com/',
        ),
        'http://web.archive.org/web/20200104000551/https://example.com/': page('<p>page</p>'),
      },
      { replayUrl: at('20200104000551', 'https://example.com/'), timestamp: '20200104000551' },
      [
        at('20200104000000', 'https://example.com/'),
        'http://web.archive.org/web/20200104000551/https://example.com/',
      ],
    ],
    [
      'an archived 301 with a root-relative Location, then a nearest-capture redirect',
      REQUESTED,
      {
        [REQUESTED]: archived(301, PROMPT_TS, `/web/${PROMPT_TS}/${TARGET}`),
        [TARGET_AT_TS]: nearest(SERVED),
        [SERVED]: page('<p>home page</p>'),
      },
      {
        replayUrl: SERVED,
        timestamp: '20250828072413',
        redirects: [{ status: 301, captureTimestamp: PROMPT_TS, target: TARGET }],
      },
      [REQUESTED, TARGET_AT_TS, SERVED],
    ],
    [
      'an archived 302 with an absolute Location to a capture at the same second',
      REQUESTED,
      {
        [REQUESTED]: archived(302, PROMPT_TS, TARGET_AT_TS),
        [TARGET_AT_TS]: page('<p>home page</p>'),
      },
      {
        replayUrl: TARGET_AT_TS,
        timestamp: PROMPT_TS,
        redirects: [{ status: 302, captureTimestamp: PROMPT_TS, target: TARGET }],
      },
      [REQUESTED, TARGET_AT_TS],
    ],
    [
      'a nearest-capture redirect to an archived 302 with a root-relative Location',
      at('20150101011527', 'http://example.com/'),
      {
        [at('20150101011527', 'http://example.com/')]: nearest(
          at('20150101011528', 'http://www.example.com/'),
        ),
        [at('20150101011528', 'http://www.example.com/')]: archived(
          302,
          '20150101011528',
          '/web/20150101011528/http://www.example.com/en-us/default.aspx',
        ),
        [at('20150101011528', 'http://www.example.com/en-us/default.aspx')]: nearest(
          at('20150101011529', 'http://www.example.com/en-us/default.aspx'),
        ),
        [at('20150101011529', 'http://www.example.com/en-us/default.aspx')]: page('<p>home</p>'),
      },
      {
        replayUrl: at('20150101011529', 'http://www.example.com/en-us/default.aspx'),
        timestamp: '20150101011529',
        redirects: [
          {
            status: 302,
            captureTimestamp: '20150101011528',
            target: 'http://www.example.com/en-us/default.aspx',
          },
        ],
      },
      [
        at('20150101011527', 'http://example.com/'),
        at('20150101011528', 'http://www.example.com/'),
        at('20150101011528', 'http://www.example.com/en-us/default.aspx'),
        at('20150101011529', 'http://www.example.com/en-us/default.aspx'),
      ],
    ],
    [
      'two archived redirects in a row, recorded in the order they were followed',
      REQUESTED,
      {
        [REQUESTED]: archived(301, PROMPT_TS, TARGET_AT_TS),
        [TARGET_AT_TS]: archived(302, PROMPT_TS, at(PROMPT_TS, 'https://final.example.net/')),
        [at(PROMPT_TS, 'https://final.example.net/')]: page('<p>final</p>'),
      },
      {
        replayUrl: at(PROMPT_TS, 'https://final.example.net/'),
        timestamp: PROMPT_TS,
        redirects: [
          { status: 301, captureTimestamp: PROMPT_TS, target: TARGET },
          { status: 302, captureTimestamp: PROMPT_TS, target: 'https://final.example.net/' },
        ],
      },
      [REQUESTED, TARGET_AT_TS, at(PROMPT_TS, 'https://final.example.net/')],
    ],
  ])('follows %s to the capture served', async (_name, start, routes, expected, requests) => {
    serve(routes);

    const content = await fetchContent(start);

    expect(content).toMatchObject(expected);
    if (!expected.redirects) expect(content).not.toHaveProperty('redirects');
    expect(content.text).not.toBe('');
    expect(requested()).toEqual(requests);
  });

  it('fails a non-text capture reached through an archived redirect as non-text, carrying the redirects passed', async () => {
    serve({
      [REQUESTED]: archived(301, PROMPT_TS, `/web/${PROMPT_TS}/${TARGET}`),
      [TARGET_AT_TS]: nearest(SERVED),
      [SERVED]: page('%PDF-1.7', 'application/pdf'),
    });

    const err = await failure(fetchContent(REQUESTED));

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        mediaType: 'application/pdf',
        replayUrl: SERVED,
        redirects: [{ status: 301, captureTimestamp: PROMPT_TS, target: TARGET }],
      },
    });
    expect(err.data).not.toHaveProperty('deadEnd');
    expect(requested()).toEqual([REQUESTED, TARGET_AT_TS, SERVED]);
  });

  describe('a redirect to the wayback.archive.org alias host', () => {
    const FIRST = at(PROMPT_TS, 'http://example.com/');
    const SERVED_AT = '20250805171640';
    const ON_WEB = at(SERVED_AT, 'http://example.com/');
    const STORED = 'stored text\n  <kept>\n';

    it.each(['https', 'http'])(
      'requests the %s alias URL its Location names and reports the capture on https://web.archive.org',
      async (scheme) => {
        const alias = `${scheme}://wayback.archive.org/web/${SERVED_AT}/http://example.com/`;
        serve({ [FIRST]: nearest(alias), [alias]: page('<p>page</p>') });

        const content = await fetchContent(FIRST);

        expect(content).toMatchObject({ replayUrl: ON_WEB, timestamp: SERVED_AT, text: 'page' });
        expect(requested()).toEqual([FIRST, alias]);
      },
    );

    it('reads a text capture it served from the id_ form on https://web.archive.org', async () => {
      const alias = `https://wayback.archive.org/web/${SERVED_AT}/http://example.com/`;
      const raw = `${WEB}/${SERVED_AT}id_/http://example.com/`;
      serve({
        [FIRST]: nearest(alias),
        [alias]: page('rewritten', 'text/plain'),
        [raw]: page(STORED, 'text/plain'),
      });

      const content = await fetchContent(FIRST);

      expect(content).toMatchObject({ replayUrl: ON_WEB, timestamp: SERVED_AT, text: STORED });
      expect(requested()).toEqual([FIRST, alias, raw]);
    });
  });

  it.each([300, 303, 307, 308])(
    'follows Wayback’s own %i to the nearest capture, listing no archived redirect',
    async (status) => {
      const first = at('20200104000000', 'https://example.com/');
      const served = at('20200104000551', 'https://example.com/');
      serve({ [first]: nearest(served, status), [served]: page('<p>page</p>') });

      const content = await fetchContent(first);

      expect(content).toMatchObject({ replayUrl: served, timestamp: '20200104000551' });
      expect(content).not.toHaveProperty('redirects');
      expect(requested()).toEqual([first, served]);
    },
  );

  it.each([300, 303, 307, 308])(
    'follows an archived %i, disclosing it with that status',
    async (status) => {
      serve({
        [REQUESTED]: archived(status, PROMPT_TS, TARGET_AT_TS),
        [TARGET_AT_TS]: page('<p>home page</p>'),
      });

      const content = await fetchContent(REQUESTED);

      expect(content).toMatchObject({
        replayUrl: TARGET_AT_TS,
        redirects: [{ status, captureTimestamp: PROMPT_TS, target: TARGET }],
      });
      expect(requested()).toEqual([REQUESTED, TARGET_AT_TS]);
    },
  );

  it.each([
    ['root-relative', '/web/20200104000551/https://example.com/home'],
    ['path-relative', 'home'],
  ])(
    'resolves a %s Location on a later hop against the URL that answered it, not the first',
    async (_kind, location) => {
      const first = at('20200104000000', 'https://example.com/');
      const second = 'http://web.archive.org/web/20200104000551/https://example.com/';
      const third = 'http://web.archive.org/web/20200104000551/https://example.com/home';
      serve({
        [first]: nearest(second),
        [second]: archived(301, '20200104000551', location),
        [third]: page('<p>home</p>'),
      });

      const content = await fetchContent(first);

      expect(requested()).toEqual([first, second, third]);
      expect(content).toMatchObject({
        replayUrl: at('20200104000551', 'https://example.com/home'),
        redirects: [
          { status: 301, captureTimestamp: '20200104000551', target: 'https://example.com/home' },
        ],
      });
    },
  );

  it('sends every later hop with the signal of the attempt’s first request', async () => {
    serve({
      [REQUESTED]: archived(301, PROMPT_TS, `/web/${PROMPT_TS}/${TARGET}`),
      [TARGET_AT_TS]: nearest(SERVED),
      [SERVED]: page('<p>home page</p>'),
    });

    await fetchContent(REQUESTED);

    const signals = fetchWithTimeout.mock.calls.map(([, , , options]) => options.signal);
    expect(signals).toHaveLength(3);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);
    expect(signals[2]).toBe(signals[0]);
  });

  it('follows ten redirects, the most a chain may have', async () => {
    const chain = nearestChain(10);
    serve(chain.routes);

    const content = await fetchContent(chain.first);

    expect(content).toMatchObject({ replayUrl: chain.last, text: 'end of the chain' });
    expect(requested()).toHaveLength(11);
  });

  it('sends every replay request with redirect manual, capturing Location and Memento-Datetime', async () => {
    serve({
      [REQUESTED]: archived(301, PROMPT_TS, `/web/${PROMPT_TS}/${TARGET}`),
      [TARGET_AT_TS]: nearest(SERVED),
      [SERVED]: page('<p>home page</p>'),
    });

    await fetchContent(REQUESTED);

    expect(upstream.calls.map((c) => c.request.redirect)).toEqual(['manual', 'manual', 'manual']);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
    for (const [, , , options] of fetchWithTimeout.mock.calls) {
      expect(options).toMatchObject({
        redirect: 'manual',
        errorHeaders: expect.arrayContaining(['memento-datetime', 'location']),
      });
    }
  });

  describe('each URL in the chain as it is requested: parsed, without its fragment', () => {
    /** `url` with any `#fragment` removed. */
    const withoutFragment = (url: string) => url.replace(/#.*$/s, '');

    /**
     * Routes as `serve` does, matching each request's URL without its fragment, so a request
     * that carries one still reaches its route and the URLs requested show it.
     */
    const serveIgnoringFragments = (routes: Record<string, FetchMockResponder>) => {
      for (const [url, respond] of Object.entries(routes)) {
        upstream.route({ match: (request) => withoutFragment(request.url) === url, respond });
      }
      routeUnrouted();
    };

    it('reports a capture served without a redirect at the URL requested, parsed and without its fragment', async () => {
      const parsed = at('20200104000551', 'http://example.com/a%20b/%C3%A9/y');
      serveIgnoringFragments({ [parsed]: page('<p>page</p>') });

      const content = await fetchContent(
        at('20200104000551', 'http://example.com/a b/é/x/../y#frag'),
      );

      expect(content).toMatchObject({ replayUrl: parsed, timestamp: '20200104000551' });
      expect(requested()).toEqual([parsed]);
    });

    it('fails a redirect back to the first URL in its parsed form as a loop, after two requests', async () => {
      const first = at('20200104000000', 'http://example.com/a%20b');
      const other = at('20200104000551', 'http://example.com/b');
      serveIgnoringFragments({ [first]: nearest(other), [other]: nearest(first) });

      const err = await withRetries(() =>
        failure(fetchContent(at('20200104000000', 'http://example.com/a b'))),
      );

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { status: 302, deadEnd: { kind: 'loop', url: first }, redirects: [] },
      });
      expect(requested()).toEqual([first, other]);
    });

    it('follows a Location with a fragment to the URL without it, recording its target without it', async () => {
      serveIgnoringFragments({
        [REQUESTED]: archived(302, PROMPT_TS, `/web/${PROMPT_TS}/${TARGET}#main`),
        [TARGET_AT_TS]: page('<p>home page</p>'),
      });

      const content = await fetchContent(REQUESTED);

      expect(content).toMatchObject({
        replayUrl: TARGET_AT_TS,
        redirects: [{ status: 302, captureTimestamp: PROMPT_TS, target: TARGET }],
      });
      expect(requested()).toEqual([REQUESTED, TARGET_AT_TS]);
    });

    it('fails a Location that differs from a URL already requested only by its fragment as a loop', async () => {
      serveIgnoringFragments({ [REQUESTED]: nearest(`${REQUESTED}#again`) });

      const err = await withRetries(() => failure(fetchContent(REQUESTED)));

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { status: 302, deadEnd: { kind: 'loop', url: REQUESTED }, redirects: [] },
      });
      expect(requested()).toEqual([REQUESTED]);
    });
  });

  describe('a chain that reaches no readable capture', () => {
    const PARKED = 'http://parked.example.org/?subid1=20240515-0034-48';
    const LOOP_A = at(PROMPT_TS, 'http://loop-a.example.com/');
    const LOOP_B = at(PROMPT_TS, 'http://loop-b.example.com/');
    /** A Location on a Wayback host whose scheme is not http(s). */
    const FTP_ON_WAYBACK = `ftp://web.archive.org/web/${PROMPT_TS}/http://example.com/`;
    /** The archived 301 every later-hop row passes before its dead end. */
    const VIA_301 = { status: 301, captureTimestamp: PROMPT_TS, target: TARGET };
    const toTarget = { [REQUESTED]: archived(301, PROMPT_TS, TARGET_AT_TS) };
    const NEAREST_FIRST = at('20200104000000', 'https://example.com/');
    const NEAREST_NEXT = at('20200104000551', 'https://example.com/');

    it.each<
      [
        name: string,
        start: string,
        routes: Record<string, FetchMockResponder>,
        failure: { status: number; deadEnd: unknown; redirects: unknown[] },
        requests: number,
      ]
    >([
      [
        'an archived redirect to a URL Wayback never archived',
        REQUESTED,
        {
          [REQUESTED]: archived(302, PROMPT_TS, at(PROMPT_TS, PARKED)),
          [at(PROMPT_TS, PARKED)]: NOT_ARCHIVED,
        },
        {
          status: 404,
          deadEnd: { kind: 'not_archived' },
          redirects: [{ status: 302, captureTimestamp: PROMPT_TS, target: PARKED }],
        },
        2,
      ],
      [
        'an archived redirect to a capture of an archived error page, named for the target',
        REQUESTED,
        {
          [REQUESTED]: archived(301, PROMPT_TS, TARGET_AT_TS),
          [TARGET_AT_TS]: () =>
            new Response('<p>Not Found</p>', {
              status: 404,
              headers: { 'memento-datetime': httpDate('20250805171640') },
            }),
        },
        {
          status: 404,
          deadEnd: { kind: 'archived_error', status: 404, captureTimestamp: '20250805171640' },
          redirects: [{ status: 301, captureTimestamp: PROMPT_TS, target: TARGET }],
        },
        2,
      ],
      [
        'an archived redirect to a URL whose replay Wayback refuses',
        REQUESTED,
        {
          [REQUESTED]: archived(301, PROMPT_TS, TARGET_AT_TS),
          [TARGET_AT_TS]: () => new Response('<p>playback</p>', { status: 403 }),
        },
        {
          status: 403,
          deadEnd: { kind: 'refused', status: 403 },
          redirects: [{ status: 301, captureTimestamp: PROMPT_TS, target: TARGET }],
        },
        2,
      ],
      [
        'archived redirects that loop back to a capture already requested',
        LOOP_A,
        {
          [LOOP_A]: archived(301, PROMPT_TS, LOOP_B),
          [LOOP_B]: archived(301, PROMPT_TS, LOOP_A),
        },
        {
          status: 301,
          deadEnd: { kind: 'loop', url: LOOP_A },
          redirects: [
            { status: 301, captureTimestamp: PROMPT_TS, target: 'http://loop-b.example.com/' },
            { status: 301, captureTimestamp: PROMPT_TS, target: 'http://loop-a.example.com/' },
          ],
        },
        2,
      ],
      [
        'an archived redirect with no Location',
        REQUESTED,
        { [REQUESTED]: archived(301, PROMPT_TS) },
        {
          status: 301,
          deadEnd: { kind: 'no_location', status: 301, captureTimestamp: PROMPT_TS },
          redirects: [],
        },
        1,
      ],
      [
        'a Wayback redirect with no Location',
        REQUESTED,
        { [REQUESTED]: () => new Response(null, { status: 302 }) },
        { status: 302, deadEnd: { kind: 'no_location', status: 302 }, redirects: [] },
        1,
      ],
      [
        'a Location that does not parse as a URL',
        REQUESTED,
        { [REQUESTED]: archived(302, PROMPT_TS, 'http://[unclosed/') },
        {
          status: 302,
          deadEnd: {
            kind: 'bad_location',
            status: 302,
            location: 'http://[unclosed/',
            captureTimestamp: PROMPT_TS,
          },
          redirects: [],
        },
        1,
      ],
      [
        'a Location that is not http(s)',
        REQUESTED,
        { [REQUESTED]: archived(302, PROMPT_TS, 'ftp://files.example.com/report.pdf') },
        {
          status: 302,
          deadEnd: {
            kind: 'bad_location',
            status: 302,
            location: 'ftp://files.example.com/report.pdf',
            captureTimestamp: PROMPT_TS,
          },
          redirects: [],
        },
        1,
      ],
      [
        'a Location off the Wayback hosts',
        REQUESTED,
        { [REQUESTED]: nearest('https://redirected.example.org/elsewhere') },
        {
          status: 302,
          deadEnd: {
            kind: 'bad_location',
            status: 302,
            location: 'https://redirected.example.org/elsewhere',
          },
          redirects: [],
        },
        1,
      ],
      [
        'a Location on a Wayback host that is not http(s)',
        REQUESTED,
        { [REQUESTED]: archived(302, PROMPT_TS, FTP_ON_WAYBACK) },
        {
          status: 302,
          deadEnd: {
            kind: 'bad_location',
            status: 302,
            location: FTP_ON_WAYBACK,
            captureTimestamp: PROMPT_TS,
          },
          redirects: [],
        },
        1,
      ],
      [
        'a Wayback redirect with no Location, after an archived redirect',
        REQUESTED,
        { ...toTarget, [TARGET_AT_TS]: () => new Response(null, { status: 302 }) },
        { status: 302, deadEnd: { kind: 'no_location', status: 302 }, redirects: [VIA_301] },
        2,
      ],
      [
        'an archived redirect with no Location, after a nearest-capture redirect',
        NEAREST_FIRST,
        { [NEAREST_FIRST]: nearest(NEAREST_NEXT), [NEAREST_NEXT]: archived(301, '20200104000551') },
        {
          status: 301,
          deadEnd: { kind: 'no_location', status: 301, captureTimestamp: '20200104000551' },
          redirects: [],
        },
        2,
      ],
      [
        'an archived redirect to a Location that does not parse, after an archived redirect',
        REQUESTED,
        { ...toTarget, [TARGET_AT_TS]: archived(302, '20250805171640', 'http://[unclosed/') },
        {
          status: 302,
          deadEnd: {
            kind: 'bad_location',
            status: 302,
            location: 'http://[unclosed/',
            captureTimestamp: '20250805171640',
          },
          redirects: [VIA_301],
        },
        2,
      ],
      [
        'a Location on a Wayback host that is not http(s), after an archived redirect',
        REQUESTED,
        { ...toTarget, [TARGET_AT_TS]: nearest(FTP_ON_WAYBACK) },
        {
          status: 302,
          deadEnd: { kind: 'bad_location', status: 302, location: FTP_ON_WAYBACK },
          redirects: [VIA_301],
        },
        2,
      ],
      [
        'a Location off the Wayback hosts, after an archived redirect',
        REQUESTED,
        { ...toTarget, [TARGET_AT_TS]: nearest('https://redirected.example.org/elsewhere') },
        {
          status: 302,
          deadEnd: {
            kind: 'bad_location',
            status: 302,
            location: 'https://redirected.example.org/elsewhere',
          },
          redirects: [VIA_301],
        },
        2,
      ],
      [
        'a 410 for the target of an archived redirect, a refusal of that target',
        REQUESTED,
        { ...toTarget, [TARGET_AT_TS]: () => new Response('<p>playback</p>', { status: 410 }) },
        { status: 410, deadEnd: { kind: 'refused', status: 410 }, redirects: [VIA_301] },
        2,
      ],
      [
        'a 451 for the target of an archived redirect, a refusal of that target',
        REQUESTED,
        { ...toTarget, [TARGET_AT_TS]: () => new Response('<p>playback</p>', { status: 451 }) },
        { status: 451, deadEnd: { kind: 'refused', status: 451 }, redirects: [VIA_301] },
        2,
      ],
    ])(
      'fails %s as NotFound, after one attempt',
      async (_name, start, routes, expected, requests) => {
        serve(routes);

        const err = await withRetries(() => failure(fetchContent(start)));

        expect(err).toMatchObject({ code: JsonRpcErrorCode.NotFound });
        expect(err.data).toMatchObject(expected);
        expect(err.data?.redirects).toEqual(expected.redirects);
        expect(err.data?.deadEnd).toEqual(expected.deadEnd);
        expect(requested()).toHaveLength(requests);
      },
    );

    it('fails an eleventh redirect as too many redirects, after eleven requests', async () => {
      const chain = nearestChain(11);
      serve(chain.routes);

      const err = await withRetries(() => failure(fetchContent(chain.first)));

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { status: 302, deadEnd: { kind: 'too_many_redirects' }, redirects: [] },
      });
      expect(requested()).toHaveLength(11);
      expect(requested()).not.toContain(chain.last);
    });

    it('lists an eleventh redirect that is itself an archived redirect in the redirects passed', async () => {
      const chain = nearestChain(10);
      const beyond = at('20200101000010', 'http://redirected.example.org/');
      serve({ ...chain.routes, [chain.last]: archived(301, '20200101000010', beyond) });

      const err = await withRetries(() => failure(fetchContent(chain.first)));

      expect(err).toMatchObject({ code: JsonRpcErrorCode.NotFound });
      expect(err.data?.deadEnd).toEqual({ kind: 'too_many_redirects' });
      expect(err.data?.redirects).toEqual([
        {
          status: 301,
          captureTimestamp: '20200101000010',
          target: 'http://redirected.example.org/',
        },
      ]);
      expect(requested()).toHaveLength(11);
      expect(requested()).not.toContain(beyond);
    });

    it('leaves a 404 after only nearest-capture redirects as the 404 it was', async () => {
      serve({
        [at('20200104000000', 'https://example.com/')]: nearest(
          at('20200104000551', 'https://example.com/'),
        ),
        [at('20200104000551', 'https://example.com/')]: NOT_ARCHIVED,
      });

      const err = await withRetries(() =>
        failure(fetchContent(at('20200104000000', 'https://example.com/'))),
      );

      expect(err).toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { status: 404 } });
      expect(err.data).not.toHaveProperty('deadEnd');
      expect(err.data).not.toHaveProperty('redirects');
      expect(requested()).toHaveLength(2);
    });

    it('leaves an archived error page requested directly as the archived error it was', async () => {
      serve({
        [REQUESTED]: () =>
          new Response('<p>error</p>', {
            status: 503,
            headers: { 'memento-datetime': httpDate(PROMPT_TS) },
          }),
      });

      const err = await withRetries(() => failure(fetchContent(REQUESTED)));

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: `The capture at ${PROMPT_TS} is an archived HTTP 503 page.`,
        data: { status: 503, captureTimestamp: PROMPT_TS },
      });
      expect(err.data).not.toHaveProperty('deadEnd');
      expect(requested()).toHaveLength(1);
    });
  });

  describe('a transient failure on a later hop keeps its handling', () => {
    const routesWith = (answer: FetchMockResponder) => ({
      [REQUESTED]: archived(301, PROMPT_TS, `/web/${PROMPT_TS}/${TARGET}`),
      [TARGET_AT_TS]: answer,
    });

    it.each([503, 408, 425])(
      'retries a %i on the second hop, each attempt starting the chain again',
      async (status) => {
        serve(routesWith(() => new Response('unavailable', { status })));

        const err = await withRetries(() => failure(fetchContent(REQUESTED)));

        expect(err).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable, data: { status } });
        expect(requested()).toEqual([
          REQUESTED,
          TARGET_AT_TS,
          REQUESTED,
          TARGET_AT_TS,
          REQUESTED,
          TARGET_AT_TS,
          REQUESTED,
          TARGET_AT_TS,
        ]);
      },
    );

    it('answers a 429 on the second hop after one attempt, with its wait hint', async () => {
      serve(routesWith(() => new Response('slow down', { status: 429 })));

      const err = await withRetries(() => failure(fetchContent(REQUESTED)));

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { status: 429, recovery: { hint: expect.stringMatching(/rate-limiting/) } },
      });
      expect(requested()).toEqual([REQUESTED, TARGET_AT_TS]);
    });

    it('retries a network error on the second hop like any other', async () => {
      serve(routesWith(() => Promise.reject(new TypeError('fetch failed'))));

      const err = await withRetries(() => failure(fetchContent(REQUESTED)));

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'Wayback Machine could not be reached (network error, 4 attempts).',
      });
      expect(requested()).toHaveLength(8);
    });

    it('answers a timeout on the second hop after one attempt', async () => {
      serve(
        routesWith(
          (request) =>
            new Promise((_, reject) => {
              request.signal.addEventListener('abort', () => reject(request.signal.reason));
            }),
        ),
      );
      vi.useFakeTimers();

      const pending = failure(fetchContent(REQUESTED));
      await vi.advanceTimersByTimeAsync(30_000);
      const err = await pending;

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'Wayback Machine timed out after 30 s.',
      });
      expect(requested()).toEqual([REQUESTED, TARGET_AT_TS]);
    });
  });

  describe('under the call deadline', () => {
    it('sends each later hop with what remains of the deadline', async () => {
      vi.useFakeTimers();
      serve({
        [REQUESTED]: () => {
          vi.setSystemTime(Date.now() + 40_000);
          return archived(301, PROMPT_TS, TARGET_AT_TS)();
        },
        [TARGET_AT_TS]: page('<p>home page</p>'),
      });

      await fetchContent(REQUESTED);

      expect(fetchWithTimeout.mock.calls.map((c) => c[1])).toEqual([30_000, 15_000]);
    });

    it('sends no further hop once the deadline has passed', async () => {
      vi.useFakeTimers();
      serve({
        [REQUESTED]: () => {
          vi.setSystemTime(Date.now() + 55_000);
          return archived(301, PROMPT_TS, TARGET_AT_TS)();
        },
        [TARGET_AT_TS]: page('<p>home page</p>'),
      });

      const err = await failure(fetchContent(REQUESTED));

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'Wayback Machine did not finish within the 55 s call deadline.',
      });
      expect(requested()).toEqual([REQUESTED]);
    });

    it('stays a cancellation when the caller leaves mid-chain, sending no further hop', async () => {
      const controller = new AbortController();
      serve({
        [REQUESTED]: archived(301, PROMPT_TS, TARGET_AT_TS),
        [TARGET_AT_TS]: (request) =>
          new Promise((_, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason));
            controller.abort();
          }),
      });

      const err = await failure(fetchContent(REQUESTED, controller.signal));

      expect(err).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(requested()).toEqual([REQUESTED, TARGET_AT_TS]);
    });
  });

  describe('the id_ read of a text capture', () => {
    const RFC = 'https://www.rfc-editor.org/rfc/rfc2616.txt';
    /** RFC 2616 §2.1, as its text/plain capture holds it: line breaks and ABNF angle brackets. */
    const RULE =
      '   *rule\n      The character "*" preceding an element indicates repetition. The\n      full form is "<n>*<m>element" indicating at least <n> and at most\n      <m> occurrences of element.\n';

    it('builds the id_ URL from the capture a redirect reached, and keeps a text body as stored', async () => {
      serve({
        [at('2020', RFC)]: nearest(at('20201230144805', RFC)),
        [at('20201230144805', RFC)]: page('rewritten', 'text/plain'),
        [`${WEB}/20201230144805id_/${RFC}`]: page(RULE, 'text/plain'),
      });

      const content = await fetchContent(at('2020', RFC));

      expect(content).toMatchObject({
        text: RULE,
        replayUrl: at('20201230144805', RFC),
        timestamp: '20201230144805',
      });
      expect(requested()).toEqual([
        at('2020', RFC),
        at('20201230144805', RFC),
        `${WEB}/20201230144805id_/${RFC}`,
      ]);
    });

    it('follows a redirect of the id_ form itself', async () => {
      serve({
        [at('20201230144805', RFC)]: page('rewritten', 'text/plain'),
        [`${WEB}/20201230144805id_/${RFC}`]: nearest(`${WEB}/20201230144806id_/${RFC}`),
        [`${WEB}/20201230144806id_/${RFC}`]: page(RULE, 'text/plain'),
      });

      const content = await fetchContent(at('20201230144805', RFC));

      expect(content).toMatchObject({ text: RULE, replayUrl: at('20201230144805', RFC) });
      expect(requested()).toHaveLength(3);
    });

    it('fails an id_ chain that loops as content it could not read, never as no capture', async () => {
      const rawA = `${WEB}/20201230144805id_/${RFC}`;
      const rawB = `${WEB}/20201230144806id_/${RFC}`;
      serve({
        [at('20201230144805', RFC)]: page('rewritten', 'text/plain'),
        [rawA]: nearest(rawB),
        [rawB]: nearest(rawA),
      });

      const err = await withRetries(() => failure(fetchContent(at('20201230144805', RFC))));

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: `The Wayback Machine replayed this capture but the redirects of its unmodified form, ${rawA}, reached no readable capture.`,
        data: {
          retryable: false,
          recovery: {
            hint: `Wayback replayed this capture but refused its unmodified form, so a retry is unlikely to help; open ${at('20201230144805', RFC)} to read the capture, or pick another one with ia_find_snapshots in history mode.`,
          },
        },
      });
      expect(err.message).not.toContain('HTTP');
      expect(requested()).toEqual([at('20201230144805', RFC), rawA, rawB]);
    });
  });
});

describe('fetchContent on the runtime’s own fetch (#63)', () => {
  /** Answers as Wayback does for an archived 301 whose site sent a relative Location: root-relative, scheme embedded. */
  let server: Server;
  let base = '';
  let hits = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      if (req.url === '/web/20250805171636/http://example.com/docs/report.pdf') {
        res.writeHead(301, {
          location: '/web/20250805171636/http://redirected.example.org/',
          'memento-datetime': 'Tue, 05 Aug 2025 17:16:36 GMT',
        });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>page of the target</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no loopback port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('receives a root-relative Location embedding http:// as the 3xx it is, resolving it against the URL that sent it', async () => {
    hits = 0;

    const err = await failure(
      fetchContent(`${base}/web/20250805171636/http://example.com/docs/report.pdf`),
    );

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        status: 301,
        deadEnd: {
          kind: 'bad_location',
          status: 301,
          location: `${base}/web/20250805171636/http://redirected.example.org/`,
          captureTimestamp: '20250805171636',
        },
      },
    });
    expect(hits).toBe(1);
  }, 30_000);
});
