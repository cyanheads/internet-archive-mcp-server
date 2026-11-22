/**
 * @fileoverview Tests for the ia_get_snapshot tool.
 * @module tests/tools/ia-get-snapshot.tool.test
 */

import { JsonRpcErrorCode, notFound, timeout } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { markdown } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iaGetSnapshot } from '@/mcp-server/tools/definitions/ia-get-snapshot.tool.js';
import type { CallDeadline } from '@/services/call-deadline.js';
import { expectLinearDoubling } from '../helpers/cpu-time.js';

vi.mock('@/services/wayback/wayback-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/wayback/wayback-service.js')>()),
  getWaybackService: vi.fn(),
}));

// Server config: a deterministic IA_MAX_SNAPSHOT_CHARS, so page sizes don't depend on the environment.
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    requestTimeoutMs: 30_000,
    maxSnapshotChars: 50_000,
    userAgent: undefined,
  }),
  getUserAgent: vi.fn().mockReturnValue('test-agent/0.0.0'),
}));

import { getWaybackService } from '@/services/wayback/wayback-service.js';

const mockService = {
  findClosest: vi.fn(),
  fetchContent: vi.fn(),
  buildReplayUrl: vi.fn(),
};

/** The call deadline the handler starts and passes on: 55 s at the 30 s request timeout. */
const CALL_DEADLINE = expect.objectContaining({ budgetSeconds: 55, requestTimeoutMs: 30_000 });

beforeEach(() => {
  vi.clearAllMocks();
  (getWaybackService as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
});

describe('iaGetSnapshot', () => {
  it('uses direct path (no Availability API) when exact 14-digit timestamp is given', async () => {
    // With a full 14-digit timestamp, the handler skips findClosest and calls buildReplayUrl
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200101120000/https://example.com',
    );
    mockService.fetchContent.mockResolvedValue({
      text: 'Hello world, this is the archived page text.',
      replayUrl: 'https://web.archive.org/web/20200101120000/https://example.com',
      status: '200',
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: '20200101120000',
    });
    const result = await iaGetSnapshot.handler(input, ctx);

    expect(mockService.findClosest).not.toHaveBeenCalled();
    expect(mockService.buildReplayUrl).toHaveBeenCalledWith(
      '20200101120000',
      'https://example.com',
    );
    expect(result.text).toBe('Hello world, this is the archived page text.');
    expect(result.replay_url).toBe(
      'https://web.archive.org/web/20200101120000/https://example.com',
    );
    expect(result.resolved_timestamp).toBe('20200101120000');
    expect(result.resolved_status).toBe('200');
  });

  it('uses Availability API for imprecise timestamps (fewer than 14 digits)', async () => {
    mockService.findClosest.mockResolvedValue({
      snapshotUrl: 'https://web.archive.org/web/20200101120000/https://example.com',
      timestamp: '20200101120000',
      status: '200',
    });
    mockService.fetchContent.mockResolvedValue({
      text: 'Hello world, this is the archived page text.',
      replayUrl: 'https://web.archive.org/web/20200101120000/https://example.com',
      status: '200',
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: '20200101', // 8 digits — imprecise, uses Availability API
    });
    const result = await iaGetSnapshot.handler(input, ctx);

    expect(mockService.findClosest).toHaveBeenCalledWith(
      'https://example.com',
      '20200101',
      ctx,
      CALL_DEADLINE,
    );
    expect(mockService.buildReplayUrl).not.toHaveBeenCalled();
    expect(result.resolved_timestamp).toBe('20200101120000');
    expect(result.resolved_status).toBe('200');
  });

  it('resolves the trimmed timestamp on the closest-capture path', async () => {
    const replayUrl = 'https://web.archive.org/web/20200101120000/https://example.com';
    mockService.findClosest.mockResolvedValue({
      snapshotUrl: replayUrl,
      timestamp: '20200101120000',
      status: '200',
    });
    mockService.fetchContent.mockResolvedValue({ text: 'page', replayUrl, status: '200' });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: ' 20200101 ',
    });
    await iaGetSnapshot.handler(input, ctx);

    expect(mockService.findClosest).toHaveBeenCalledWith(
      'https://example.com',
      '20200101',
      ctx,
      CALL_DEADLINE,
    );
  });

  it('throws no_snapshot_available when Availability API returns no closest capture', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.findClosest.mockRejectedValue(
      notFound('No snapshot available for https://unknown.example near 20200101.', {
        reason: 'no_snapshot_available',
      }),
    );

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://unknown.example',
      timestamp: '20200101',
    });

    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toThrow();
  });

  it('throws content_fetch_failed when archived page fetch fails (exact timestamp)', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    // With a 14-digit timestamp, the handler uses buildReplayUrl + fetchContent (no findClosest)
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200101120000/https://example.com',
    );
    mockService.fetchContent.mockRejectedValue(
      serviceUnavailable('Fetch failed.', { reason: 'content_fetch_failed' }),
    );

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: '20200101120000',
    });

    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'content_fetch_failed',
        recovery: { hint: expect.stringContaining('retry') },
      },
    });
  });

  it('maps Wayback 404 on exact-timestamp direct path to no_snapshot_available', async () => {
    // fetchContent receives a 404 from Wayback — should surface as no_snapshot_available
    // rather than the raw NotFound McpError with no recovery hint.
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200601000000/https://thisurldoesnotexist99999.com',
    );
    mockService.fetchContent.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.NotFound,
        'Fetch failed for https://web.archive.org/web/20200601000000/... Status: 404',
        { statusCode: 404, errorSource: 'FetchHttpError' },
      ),
    );

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://thisurldoesnotexist99999.com',
      timestamp: '20200601000000',
    });

    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_snapshot_available' },
    });
  });

  it('maps a 503 on exact-timestamp path to content_fetch_failed, not no_snapshot_available', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200601000000/https://example.com',
    );
    mockService.fetchContent.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Fetch failed for https://web.archive.org/web/20200601000000/... Status: 503',
        { statusCode: 503, errorSource: 'FetchHttpError' },
      ),
    );

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: '20200601000000',
    });

    // The upstream 503 keeps its ServiceUnavailable code but reaches the caller
    // as the declared contract entry, carrying its recovery hint.
    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'content_fetch_failed' },
    });
  });

  it('propagates an unmapped upstream error unchanged', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200601000000/https://example.com',
    );
    // A caller-side deadline: the one Timeout the service leaves as the fetch threw it.
    const timeoutError = new McpError(
      JsonRpcErrorCode.Timeout,
      "fetch GET https://web.archive.org/web/20200601000000/... timed out on the caller's signal.",
      { errorSource: 'FetchSignalTimeout' },
    );
    mockService.fetchContent.mockRejectedValue(timeoutError);

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({
      url: 'https://example.com',
      timestamp: '20200601000000',
    });

    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toThrow(timeoutError);
  });

  it('names the capture and its archived status when the page fetch hit an archived error page', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    const archived = notFound('The capture at 20190419141856 is an archived HTTP 503 page.', {
      status: 503,
      captureTimestamp: '20190419141856',
    });
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20190419141856/https://httpstat.us/503',
    );
    mockService.fetchContent.mockRejectedValue(archived);

    const result = await runToolContract(iaGetSnapshot, {
      url: 'https://httpstat.us/503',
      timestamp: '20190419141856',
    });

    const recovery = iaGetSnapshot.errors?.find((e) => e.reason === 'no_snapshot_available')
      ?.recovery as string;
    const message =
      'The capture of https://httpstat.us/503 at 20190419141856 is an archived HTTP 503 error page';
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringContaining(message),
        data: { reason: 'no_snapshot_available', recovery: { hint: recovery } },
      },
    });
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain(message);
    expect(text).toContain(`Recovery: ${recovery}`);
    expect(recovery).toContain('status_filter "200"');
  });

  it('fails a non-text capture as non_text_capture naming its media type and replay URL, on both surfaces', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    const replayUrl =
      'https://web.archive.org/web/20200101164020/https://www.irs.gov/pub/irs-pdf/f1040.pdf';
    const nonText = notFound(`The capture at ${replayUrl} is application/pdf, not text.`, {
      mediaType: 'application/pdf',
      replayUrl,
    });
    mockService.buildReplayUrl.mockReturnValue(replayUrl);
    mockService.fetchContent.mockRejectedValue(nonText);

    const result = await runToolContract(iaGetSnapshot, {
      url: 'https://www.irs.gov/pub/irs-pdf/f1040.pdf',
      timestamp: '20200101164020',
    });

    const recovery = iaGetSnapshot.errors?.find((e) => e.reason === 'non_text_capture')
      ?.recovery as string;
    expect(recovery).toContain('ia_find_snapshots');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: expect.stringMatching(/application\/pdf.*not text/),
        data: {
          reason: 'non_text_capture',
          mediaType: 'application/pdf',
          replayUrl,
          recovery: { hint: recovery },
        },
      },
    });
    const { message } = (result.structuredContent as { error: { message: string } }).error;
    expect(message).toContain(replayUrl);
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('application/pdf');
    expect(text).toContain(`Recovery: ${recovery}`);
  });

  it('maps a page-fetch 404 on the lookup path to no_snapshot_available too', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockService.findClosest.mockResolvedValue({
      snapshotUrl: 'https://web.archive.org/web/20200101000000/https://example.com/',
      timestamp: '20200101000000',
      status: '200',
    });
    const missing = new McpError(
      JsonRpcErrorCode.NotFound,
      'Fetch failed for https://web.archive.org/…. Status: 404',
      { status: 404, body: '<html>playback</html>', errorSource: 'FetchHttpError' },
    );
    mockService.fetchContent.mockRejectedValue(missing);

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'example.com', timestamp: '20200101' });
    const err = await iaGetSnapshot.handler(input, ctx).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'No capture found at example.com for timestamp 20200101.',
      data: { reason: 'no_snapshot_available' },
    });
    expect((err as InstanceType<typeof McpError>).data).not.toHaveProperty('body');
    expect((err as Error).cause).toBe(missing);
  });

  it('reports the served capture when Wayback redirected an exact timestamp', async () => {
    const served = 'https://web.archive.org/web/20200104000551/https://example.com/';
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200104000000/example.com',
    );
    mockService.fetchContent.mockResolvedValue({
      text: 'Example Domain',
      replayUrl: served,
      timestamp: '20200104000551',
      status: '200',
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'example.com', timestamp: '20200104000000' });
    const result = await iaGetSnapshot.handler(input, ctx);

    expect(result.replay_url).toBe(served);
    expect(result.resolved_timestamp).toBe('20200104000551');
    const text = (iaGetSnapshot.format!(result)[0] as { text: string }).text;
    expect(text).toContain(`**Replay URL:** [${served}](<${served}>)`);
    expect(text).toContain('**Resolved Timestamp:** 20200104000551');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('reports the served capture, status included, on the resolution path too', async () => {
    // The lookup resolved a 301 capture; Wayback followed it and served a different one.
    mockService.findClosest.mockResolvedValue({
      snapshotUrl: 'https://web.archive.org/web/20200101230622/http://nasa.gov/',
      timestamp: '20200101230622',
      status: '301',
    });
    mockService.fetchContent.mockResolvedValue({
      text: 'NASA',
      replayUrl: 'https://web.archive.org/web/20200101230626/https://www.nasa.gov/',
      timestamp: '20200101230626',
      status: '200',
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'nasa.gov', timestamp: '20200101' });
    const result = await iaGetSnapshot.handler(input, ctx);

    expect(result.replay_url).toBe(
      'https://web.archive.org/web/20200101230626/https://www.nasa.gov/',
    );
    expect(result.resolved_timestamp).toBe('20200101230626');
    expect(result.resolved_status).toBe('200');
    const text = (iaGetSnapshot.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Resolved Timestamp:** 20200101230626 | **Status:** 200');
  });

  it('reports the status Wayback served on the exact-timestamp path instead of assuming 200', async () => {
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200104000551/https://example.com/',
    );
    mockService.fetchContent.mockResolvedValue({
      text: 'Example Domain',
      replayUrl: 'https://web.archive.org/web/20200104000551/https://example.com/',
      timestamp: '20200104000551',
      status: '203',
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'example.com', timestamp: '20200104000551' });
    await expect(iaGetSnapshot.handler(input, ctx)).resolves.toMatchObject({
      resolved_status: '203',
    });
  });

  it('discloses a body cut at the byte ceiling in a notice', async () => {
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20240601000205/https://edition.cnn.com/',
    );
    mockService.fetchContent.mockResolvedValue({
      text: 'CNN',
      replayUrl: 'https://web.archive.org/web/20240601000205/https://edition.cnn.com/',
      timestamp: '20240601000205',
      status: '200',
      truncatedAtBytes: 4_194_304,
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'cnn.com', timestamp: '20240601000205' });
    await iaGetSnapshot.handler(input, ctx);

    expect(getEnrichment(ctx)).toMatchObject({
      notice: expect.stringContaining('first 4,194,304 bytes'),
    });
  });

  it('adds no notice for a body read in full', async () => {
    mockService.buildReplayUrl.mockReturnValue(
      'https://web.archive.org/web/20200104000551/https://example.com/',
    );
    mockService.fetchContent.mockResolvedValue({
      text: 'Example Domain',
      replayUrl: 'https://web.archive.org/web/20200104000551/https://example.com/',
      timestamp: '20200104000551',
      status: '200',
    });

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'example.com', timestamp: '20200104000551' });
    await iaGetSnapshot.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('keeps the service’s own next step when the lookup was rate-limited', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    // Shaped as the service's rateLimitError throws it: no `retryable` — the retry predicate,
    // not the error, answers a 429 after one request.
    const limited = serviceUnavailable('Availability API returned HTTP 429 (rate limited).', {
      reason: 'availability_unavailable',
      status: 429,
      retryAfter: '120',
      recovery: {
        hint: 'The Availability API is rate-limiting requests; wait 120 seconds before retrying.',
      },
    });
    mockService.findClosest.mockRejectedValue(limited);

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'https://example.com', timestamp: '20200101' });
    const err = await iaGetSnapshot.handler(input, ctx).catch((e: unknown) => e);

    expect(err).toMatchObject({
      message: 'Availability API returned HTTP 429 (rate limited).',
      data: {
        reason: 'content_fetch_failed',
        retryAfter: '120',
        recovery: { hint: expect.stringContaining('wait 120 seconds') },
      },
    });
    expect((err as { data: object }).data).not.toHaveProperty('retryable');
  });

  it('keeps the message and history-mode hint of an incomplete CDX fallback', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    const message =
      'The Availability API found no capture of example.com near 20200101, and the CDX closest-capture check did not complete: CDX API returned HTTP 503.';
    const hint =
      'List nearby captures with ia_find_snapshots in history mode, passing from and to around the timestamp.';
    mockService.findClosest.mockRejectedValue(
      serviceUnavailable(message, { reason: 'cdx_unavailable', recovery: { hint } }),
    );

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'example.com', timestamp: '20200101' });

    await expect(iaGetSnapshot.handler(input, ctx)).rejects.toMatchObject({
      message,
      data: { reason: 'content_fetch_failed', recovery: { hint } },
    });
  });

  it('maps a ServiceUnavailable from closest resolution to content_fetch_failed', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    const unavailable = serviceUnavailable('Wayback Availability API returned HTTP 503.', {
      reason: 'availability_unavailable',
    });
    mockService.findClosest.mockRejectedValue(unavailable);

    const ctx = createMockContext({ errors: iaGetSnapshot.errors });
    const input = iaGetSnapshot.input.parse({ url: 'https://example.com', timestamp: '20200101' });
    const err = await iaGetSnapshot.handler(input, ctx).catch((e: unknown) => e);

    expect(err).toMatchObject({
      data: {
        reason: 'content_fetch_failed',
        recovery: { hint: expect.stringContaining('retry') },
      },
    });
    expect((err as Error).cause).toBe(unavailable);
    expect(mockService.fetchContent).not.toHaveBeenCalled();
  });

  it('propagates a closest-resolution miss and a cancellation unchanged', async () => {
    const { notFound, requestCancelled } = await import('@cyanheads/mcp-ts-core/errors');
    const input = iaGetSnapshot.input.parse({ url: 'https://example.com', timestamp: '20200101' });

    const miss = notFound('No snapshot available for https://example.com near 20200101.', {
      reason: 'no_snapshot_available',
    });
    mockService.findClosest.mockRejectedValueOnce(miss);
    await expect(
      iaGetSnapshot.handler(input, createMockContext({ errors: iaGetSnapshot.errors })),
    ).rejects.toBe(miss);

    const cancelled = requestCancelled(
      'fetch GET https://archive.org/wayback/available was aborted.',
    );
    mockService.findClosest.mockRejectedValueOnce(cancelled);
    await expect(
      iaGetSnapshot.handler(input, createMockContext({ errors: iaGetSnapshot.errors })),
    ).rejects.toBe(cancelled);
  });

  describe('the call deadline (#55)', () => {
    it('starts one deadline and passes that same one to the lookup and the page fetch', async () => {
      const replayUrl = 'https://web.archive.org/web/20200101120000/https://example.com';
      mockService.findClosest.mockResolvedValue({
        snapshotUrl: replayUrl,
        timestamp: '20200101120000',
        status: '200',
      });
      mockService.fetchContent.mockResolvedValue({ text: 'page', replayUrl, status: '200' });

      await runToolContract(iaGetSnapshot, { url: 'https://example.com', timestamp: '20200101' });

      expect(mockService.fetchContent).toHaveBeenCalledWith(
        replayUrl,
        expect.anything(),
        CALL_DEADLINE,
      );
      expect(mockService.fetchContent.mock.calls[0]?.[2]).toBe(
        mockService.findClosest.mock.calls[0]?.[3],
      );
    });

    it('passes the deadline to the page fetch of an exact timestamp, which needs no lookup', async () => {
      const replayUrl = 'https://web.archive.org/web/20200101120000/https://example.com';
      mockService.buildReplayUrl.mockReturnValue(replayUrl);
      mockService.fetchContent.mockResolvedValue({ text: 'page', replayUrl, status: '200' });

      await runToolContract(iaGetSnapshot, {
        url: 'https://example.com',
        timestamp: '20200101120000',
      });

      expect(mockService.fetchContent).toHaveBeenCalledWith(
        replayUrl,
        expect.anything(),
        CALL_DEADLINE,
      );
    });

    it('answers a page fetch the deadline cut as content_fetch_failed with its message, on both surfaces', async () => {
      const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
      mockService.buildReplayUrl.mockReturnValue(
        'https://web.archive.org/web/20200101120000/https://example.com',
      );
      // Shaped as the service's transportError throws it for the replay: no reason, no `retryable`.
      mockService.fetchContent.mockRejectedValue(
        serviceUnavailable('Wayback Machine did not finish within the 55 s call deadline.'),
      );

      const result = await runToolContract(iaGetSnapshot, {
        url: 'example.com',
        timestamp: '20200101120000',
      });

      const message =
        'Could not fetch the archived page for example.com near 20200101120000: Wayback Machine did not finish within the 55 s call deadline.';
      const recovery = iaGetSnapshot.errors?.find((e) => e.reason === 'content_fetch_failed')
        ?.recovery as string;
      const { error } = result.structuredContent as { error: { data: object } };
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message,
        data: { reason: 'content_fetch_failed', recovery: { hint: recovery } },
      });
      expect(error.data).not.toHaveProperty('retryable');
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(`Error: ${message}`);
      expect(text).toContain(`Recovery: ${recovery}`);
      expect(text).not.toContain('not retryable');
    });

    it('binds the deadline to the caller’s signal, so once the caller cancels it neither refuses a request nor claims a failure', async () => {
      vi.useFakeTimers();
      try {
        const replayUrl = 'https://web.archive.org/web/20200101120000/https://example.com';
        mockService.buildReplayUrl.mockReturnValue(replayUrl);
        mockService.fetchContent.mockResolvedValue({ text: 'page', replayUrl, status: '200' });
        const caller = new AbortController();

        await runToolContract(
          iaGetSnapshot,
          { url: 'https://example.com', timestamp: '20200101120000' },
          { context: { signal: caller.signal } },
        );
        const deadline = mockService.fetchContent.mock.calls[0]?.[2] as CallDeadline;
        const expiry = timeout('Deadline exceeded.', { reason: 'retry_deadline_exceeded' });
        vi.advanceTimersByTime(55_000);

        expect(() => deadline.assertTimeLeft()).toThrow(/call deadline ran out/);
        expect(deadline.isExpiry(expiry)).toBe(true);
        caller.abort();
        expect(() => deadline.assertTimeLeft()).not.toThrow();
        expect(deadline.isExpiry(expiry)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('blank inputs', () => {
    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
    ])('rejects the %s url as invalid_arguments without any Wayback call', async (_label, url) => {
      const result = await runToolContract(iaGetSnapshot, { url, timestamp: '20200104000551' });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: unknown }).error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('url: Must not be blank');
      expect(mockService.buildReplayUrl).not.toHaveBeenCalled();
      expect(mockService.findClosest).not.toHaveBeenCalled();
      expect(mockService.fetchContent).not.toHaveBeenCalled();
    });

    it('trims surrounding whitespace from the url', async () => {
      const replayUrl = 'https://web.archive.org/web/20200104000551/https://example.com';
      mockService.buildReplayUrl.mockReturnValue(replayUrl);
      mockService.fetchContent.mockResolvedValue({ text: 'page', replayUrl, status: '200' });

      const result = await runToolContract(iaGetSnapshot, {
        url: ' https://example.com  ',
        timestamp: '20200104000551',
      });

      expect(result.isError).toBeFalsy();
      expect(mockService.buildReplayUrl).toHaveBeenCalledWith(
        '20200104000551',
        'https://example.com',
      );
    });

    it.each([
      ['empty', ''],
      ['whitespace-only', '  '],
    ])(
      'resolves the %s timestamp to the latest capture, looking it up with no timestamp',
      async (_label, timestamp) => {
        const replayUrl = 'https://web.archive.org/web/20260101000000/https://example.com';
        mockService.findClosest.mockResolvedValue({
          snapshotUrl: replayUrl,
          timestamp: '20260101000000',
          status: '200',
        });
        mockService.fetchContent.mockResolvedValue({ text: 'latest', replayUrl, status: '200' });

        const result = await runToolContract(iaGetSnapshot, {
          url: 'https://example.com',
          timestamp,
        });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ resolved_timestamp: '20260101000000' });
        expect(mockService.findClosest).toHaveBeenCalledWith(
          'https://example.com',
          undefined,
          expect.anything(),
          CALL_DEADLINE,
        );
      },
    );

    it('names the resolved latest capture, never an undefined timestamp, when its page fetch fails', async () => {
      const { notFound, serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
      const replayUrl = 'https://web.archive.org/web/20260101000000/https://example.com';
      mockService.findClosest.mockResolvedValue({
        snapshotUrl: replayUrl,
        timestamp: '20260101000000',
        status: '200',
      });

      mockService.fetchContent.mockRejectedValueOnce(
        serviceUnavailable('Wayback Machine returned HTTP 503.'),
      );
      const unavailable = await runToolContract(iaGetSnapshot, {
        url: 'example.com',
        timestamp: '',
      });
      expect((unavailable.structuredContent as { error: unknown }).error).toMatchObject({
        message:
          'Could not fetch the archived page for example.com near 20260101000000: Wayback Machine returned HTTP 503.',
        data: { reason: 'content_fetch_failed' },
      });

      mockService.fetchContent.mockRejectedValueOnce(notFound('Not found.'));
      const missing = await runToolContract(iaGetSnapshot, { url: 'example.com', timestamp: '' });
      expect((missing.structuredContent as { error: unknown }).error).toMatchObject({
        message: 'No capture found at example.com for timestamp 20260101000000.',
        data: { reason: 'no_snapshot_available' },
      });
    });
  });

  describe('a Wayback capture URL as url (#59)', () => {
    const ORIGINAL = 'https://digital.ucd.ie/';
    const CAPTURE = `https://web.archive.org/web/20241231012939/${ORIGINAL}`;
    const serveCapture = (timestamp = '20241231012939') => {
      const replayUrl = `https://web.archive.org/web/${timestamp}/${ORIGINAL}`;
      mockService.buildReplayUrl.mockReturnValue(replayUrl);
      mockService.fetchContent.mockResolvedValue({
        text: 'UCD',
        replayUrl,
        timestamp,
        status: '200',
      });
    };
    const errorOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.structuredContent as { error: unknown }).error;
    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

    it.each([
      ['blank', ''],
      ['its own digits', '20241231012939'],
      ['its own digits as an ISO date-time', '2024-12-31T01:29:39Z'],
    ])(
      'reads the capture it names, by its original URL, for a timestamp %s',
      async (_label, timestamp) => {
        serveCapture();

        const result = await runToolContract(iaGetSnapshot, { url: CAPTURE, timestamp });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          text: 'UCD',
          resolved_timestamp: '20241231012939',
        });
        expect(mockService.buildReplayUrl).toHaveBeenCalledWith('20241231012939', ORIGINAL);
        expect(mockService.findClosest).not.toHaveBeenCalled();
      },
    );

    it('resolves a capture URL’s shorter timestamp through the closest lookup on the original', async () => {
      const replayUrl = `https://web.archive.org/web/20250101010646/${ORIGINAL}`;
      mockService.findClosest.mockResolvedValue({
        snapshotUrl: replayUrl,
        timestamp: '20250101010646',
        status: '200',
      });
      mockService.fetchContent.mockResolvedValue({ text: 'UCD', replayUrl, status: '200' });

      await runToolContract(iaGetSnapshot, {
        url: `https://web.archive.org/web/2024/${ORIGINAL}`,
        timestamp: '',
      });

      expect(mockService.findClosest).toHaveBeenCalledWith(
        ORIGINAL,
        '2024',
        expect.anything(),
        CALL_DEADLINE,
      );
    });

    it.each([
      ['a prefix of the URL’s timestamp', CAPTURE, '2024'],
      ['another capture', CAPTURE, '20250101000000'],
      [
        'a capture inside the URL’s period',
        `https://web.archive.org/web/2024/${ORIGINAL}`,
        '20241231012939',
      ],
    ])(
      'fails a timestamp naming %s as ambiguous_timestamp on both surfaces, before any request',
      async (_label, url, timestamp) => {
        const result = await runToolContract(iaGetSnapshot, { url, timestamp });

        const recovery = iaGetSnapshot.errors?.find(
          (e) => e.reason === 'ambiguous_timestamp',
        )?.recovery;
        expect(recovery).toBeDefined();
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining(ORIGINAL),
          data: { reason: 'ambiguous_timestamp', recovery: { hint: recovery } },
        });
        const text = textOf(result);
        expect(text).toContain(`Recovery: ${recovery}`);
        expect(text).toContain('(reason ambiguous_timestamp');
        expect(mockService.buildReplayUrl).not.toHaveBeenCalled();
        expect(mockService.findClosest).not.toHaveBeenCalled();
        expect(mockService.fetchContent).not.toHaveBeenCalled();
      },
    );

    it('fails a capture URL’s impossible timestamp as invalid_timestamp naming url and that timestamp, before any request', async () => {
      const result = await runToolContract(iaGetSnapshot, {
        url: `https://web.archive.org/web/20241399/${ORIGINAL}`,
        timestamp: '',
      });

      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('20241399'),
        data: {
          reason: 'invalid_timestamp',
          field: 'url',
          recovery: { hint: expect.stringContaining('/web/') },
        },
      });
      const text = textOf(result);
      expect(text).toContain('20241399');
      expect(text).toMatch(/^Recovery: .*\/web\//m);
      expect(mockService.findClosest).not.toHaveBeenCalled();
      expect(mockService.fetchContent).not.toHaveBeenCalled();
    });

    it('names the original URL when the capture it names cannot be read', async () => {
      const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
      mockService.buildReplayUrl.mockReturnValue(CAPTURE);
      mockService.fetchContent.mockRejectedValue(notFound('Not found.'));

      const result = await runToolContract(iaGetSnapshot, { url: CAPTURE, timestamp: '' });

      expect(errorOf(result)).toMatchObject({
        message: `No capture found at ${ORIGINAL} for timestamp 20241231012939.`,
        data: { reason: 'no_snapshot_available' },
      });
    });

    it('names the original URL, never the capture URL, when the capture it names cannot be fetched', async () => {
      const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
      mockService.buildReplayUrl.mockReturnValue(CAPTURE);
      // The replay answered 503 on every attempt, as the service reports it once retries are spent.
      mockService.fetchContent.mockRejectedValue(
        serviceUnavailable('Wayback Machine returned HTTP 503. (failed after 4 attempts)', {
          status: 503,
          retryAttempts: 4,
        }),
      );

      const result = await runToolContract(iaGetSnapshot, { url: CAPTURE, timestamp: '' });

      const message = `Could not fetch the archived page for ${ORIGINAL} near 20241231012939: Wayback Machine returned HTTP 503. (failed after 4 attempts)`;
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message,
        data: { reason: 'content_fetch_failed' },
      });
      expect(textOf(result)).toContain(`Error: ${message}`);
    });

    it('names the original URL in the next-page notice, which then reads the next page', async () => {
      const PAGE_URL = 'https://en.wikipedia.org/wiki/World_War_II';
      const served = `https://web.archive.org/web/20200101030925/${PAGE_URL}`;
      mockService.buildReplayUrl.mockReturnValue(served);
      mockService.fetchContent.mockResolvedValue({
        text: 'x'.repeat(60_000),
        replayUrl: served,
        timestamp: '20200101030925',
        status: '200',
      });

      const first = await runToolContract(iaGetSnapshot, {
        url: `https://web.archive.org/web/20200101030000/${PAGE_URL}`,
        timestamp: '',
      });
      const notice = (first.structuredContent as { notice?: string }).notice;
      expect(notice).toBe(
        `More text follows: call ia_get_snapshot again with url \`${PAGE_URL}\`, timestamp 20200101030925 (resolved_timestamp), and char_offset 50000 for the next page.`,
      );

      const next = await runToolContract(iaGetSnapshot, {
        url: PAGE_URL,
        timestamp: '20200101030925',
        char_offset: 50_000,
      });
      expect(next.isError).toBeFalsy();
      expect(next.structuredContent).toMatchObject({ char_offset: 50_000, has_more: false });
    });

    // A capture of a Wayback capture URL: its original is itself a capture URL, which would read
    // back at its own timestamp, so the notice names the capture served instead.
    const INNER = 'https://web.archive.org/web/20191124173151/https://news.example.com/story';
    const NESTED = `https://web.archive.org/web/20201112015604/${INNER}`;
    it.each<[label: string, url: string, redirects: unknown[] | undefined]>([
      ['served as asked', NESTED, undefined],
      [
        'reached through an archived redirect',
        'https://web.archive.org/web/20201112015603/https://web.archive.org/web/2019/https://news.example.com/story',
        [{ status: 302, captureTimestamp: '20201112015603', target: INNER }],
      ],
    ])(
      'names a next page that reads back when the original of the capture %s is a capture URL',
      async (_label, url, redirects) => {
        mockService.buildReplayUrl.mockReturnValue(NESTED);
        mockService.fetchContent.mockResolvedValue({
          text: 'x'.repeat(60_000),
          replayUrl: NESTED,
          timestamp: '20201112015604',
          status: '200',
          ...(redirects && { redirects }),
        });

        const first = await runToolContract(iaGetSnapshot, { url, timestamp: '' });
        const notice = (first.structuredContent as { notice?: string }).notice ?? '';
        const printed =
          /More text follows: call ia_get_snapshot again with url `([^`]+)`, timestamp (\d{14}) \(resolved_timestamp\), and char_offset (\d+)/.exec(
            notice,
          );
        expect(printed).not.toBeNull();
        const [, nextUrl, nextTimestamp, nextOffset] = printed as RegExpExecArray;

        mockService.buildReplayUrl.mockClear();
        const next = await runToolContract(iaGetSnapshot, {
          url: nextUrl,
          timestamp: nextTimestamp,
          char_offset: Number(nextOffset),
        });
        expect(next.isError).toBeFalsy();
        expect(next.structuredContent).toMatchObject({ char_offset: 50_000, has_more: false });
        expect(mockService.buildReplayUrl).toHaveBeenCalledWith('20201112015604', INNER);
      },
    );
  });

  describe('Wayback URLs that name no single capture', () => {
    it('looks up a timegate URL itself, unchanged', async () => {
      const url = 'https://web.archive.org/web/https://digital.ucd.ie/';
      const replayUrl = `https://web.archive.org/web/20200101000000/${url}`;
      mockService.findClosest.mockResolvedValue({
        snapshotUrl: replayUrl,
        timestamp: '20200101000000',
        status: '200',
      });
      mockService.fetchContent.mockResolvedValue({ text: 'page', replayUrl, status: '200' });

      const result = await runToolContract(iaGetSnapshot, { url, timestamp: '20200101' });

      expect(result.isError).toBeFalsy();
      expect(mockService.findClosest).toHaveBeenCalledWith(
        url,
        '20200101',
        expect.anything(),
        CALL_DEADLINE,
      );
    });
  });

  describe('timestamp forms (#48)', () => {
    it('reads an ISO UTC date-time naming a second as an exact timestamp, skipping the lookup', async () => {
      const replayUrl = 'https://web.archive.org/web/20200615123456/https://example.com';
      mockService.buildReplayUrl.mockReturnValue(replayUrl);
      mockService.fetchContent.mockResolvedValue({ text: 'page', replayUrl, status: '200' });

      const result = await runToolContract(iaGetSnapshot, {
        url: 'https://example.com',
        timestamp: '2020-06-15T12:34:56Z',
      });

      expect(result.isError).toBeFalsy();
      expect(mockService.buildReplayUrl).toHaveBeenCalledWith(
        '20200615123456',
        'https://example.com',
      );
      expect(mockService.findClosest).not.toHaveBeenCalled();
    });

    it('resolves an ISO date through the closest lookup as its digits', async () => {
      const replayUrl = 'https://web.archive.org/web/20200615000524/https://www.nasa.gov/';
      mockService.findClosest.mockResolvedValue({
        snapshotUrl: replayUrl,
        timestamp: '20200615000524',
        status: '200',
      });
      mockService.fetchContent.mockResolvedValue({ text: 'page', replayUrl, status: '200' });

      await runToolContract(iaGetSnapshot, {
        url: 'https://www.nasa.gov/',
        timestamp: '2020-06-15',
      });

      expect(mockService.findClosest).toHaveBeenCalledWith(
        'https://www.nasa.gov/',
        '20200615',
        expect.anything(),
        CALL_DEADLINE,
      );
    });

    it.each([
      ['a month name', 'January 2015'],
      ['an impossible month', '20151345'],
      ['15 digits', '201506150527291'],
      ['slash separators', '2015/01/01'],
    ])(
      'rejects %s as invalid_timestamp on both surfaces without any Wayback call',
      async (_label, timestamp) => {
        const result = await runToolContract(iaGetSnapshot, { url: 'example.com', timestamp });

        const recovery = iaGetSnapshot.errors?.find(
          (e) => e.reason === 'invalid_timestamp',
        )?.recovery;
        expect(recovery).toBeDefined();
        expect((result.structuredContent as { error: unknown }).error).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringMatching(/^timestamp .*1–14 digits.*ISO 8601/),
          data: { reason: 'invalid_timestamp', field: 'timestamp', recovery: { hint: recovery } },
        });
        const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
        expect(text).toContain(`Recovery: ${recovery}`);
        expect(mockService.findClosest).not.toHaveBeenCalled();
        expect(mockService.buildReplayUrl).not.toHaveBeenCalled();
        expect(mockService.fetchContent).not.toHaveBeenCalled();
      },
    );
  });

  describe('paging (#44)', () => {
    const PAGE_URL = 'https://en.wikipedia.org/wiki/World_War_II';
    const REPLAY = `https://web.archive.org/web/20200101030920/${PAGE_URL}`;
    /** The length of the World War II capture's text; each position's letter follows from its index. */
    const TEXT = Array.from({ length: 177_671 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(
      '',
    );

    type Page = {
      text: string;
      char_offset: number;
      max_chars: number;
      has_more: boolean;
      total_chars: number;
      notice?: string;
    };
    const serve = (text = TEXT, extra: Record<string, unknown> = {}) => {
      mockService.buildReplayUrl.mockReturnValue(REPLAY);
      mockService.fetchContent.mockResolvedValue({
        text,
        replayUrl: REPLAY,
        timestamp: '20200101030920',
        status: '200',
        ...extra,
      });
    };
    const read = async (input: Record<string, unknown> = {}) => {
      const result = await runToolContract(iaGetSnapshot, {
        url: PAGE_URL,
        timestamp: '20200101030920',
        ...input,
      });
      expect(result.isError).toBeFalsy();
      const content = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      return { page: result.structuredContent as Page, content };
    };

    it('serves the first 50,000 characters without the new inputs, naming the next page', async () => {
      serve();

      const { page, content } = await read();

      expect(page).toMatchObject({
        text: TEXT.slice(0, 50_000),
        char_offset: 0,
        max_chars: 50_000,
        has_more: true,
        total_chars: 177_671,
      });
      expect(page.notice).toContain('char_offset 50000');
      expect(page.notice).toContain('timestamp 20200101030920');
      expect(content).toContain(page.notice);
      expect(content).toContain(
        '**Offset:** 0 | **Max Chars:** 50,000 | **Total Chars:** 177,671 — more follows (next offset: 50,000)',
      );
    });

    it('joins its pages at 0, 50000, 100000, and 150000 into the whole text, with no gap or overlap', async () => {
      serve();

      const pages: Page[] = [];
      for (const char_offset of [0, 50_000, 100_000, 150_000]) {
        pages.push((await read({ char_offset })).page);
      }

      expect(pages.map((p) => p.text).join('')).toBe(TEXT);
      expect(pages.map((p) => p.has_more)).toEqual([true, true, true, false]);
      const last = pages[3] as Page;
      expect(last).toMatchObject({ char_offset: 150_000, max_chars: 50_000, total_chars: 177_671 });
      expect(last.text).toHaveLength(27_671);
      expect(last.notice).toBeUndefined();
    });

    it('says the last page reaches the end of the text on both surfaces', async () => {
      serve();

      const { page, content } = await read({ char_offset: 150_000 });

      expect(page.has_more).toBe(false);
      expect(content).toContain(
        '**Offset:** 150,000 | **Max Chars:** 50,000 | **Total Chars:** 177,671 — end of text',
      );
    });

    it.each([177_671, 177_672, 9_999_999])(
      'serves empty text with has_more false for char_offset %i, at or past the end',
      async (char_offset) => {
        serve();

        const { page } = await read({ char_offset });

        expect(page).toMatchObject({
          text: '',
          char_offset,
          has_more: false,
          total_chars: 177_671,
        });
        expect(page.notice).toBeUndefined();
      },
    );

    it('serves an empty capture as one empty page', async () => {
      serve('');

      const { page, content } = await read();

      expect(page).toMatchObject({ text: '', has_more: false, total_chars: 0 });
      expect(content).toContain('**Total Chars:** 0 — end of text');
    });

    it('serves a smaller max_chars as asked and names the next offset', async () => {
      serve();

      const { page } = await read({ char_offset: 10, max_chars: 25 });

      expect(page).toMatchObject({
        text: TEXT.slice(10, 35),
        char_offset: 10,
        max_chars: 25,
        has_more: true,
      });
      expect(page.notice).toContain('char_offset 35');
    });

    it('serves a max_chars above IA_MAX_SNAPSHOT_CHARS at the maximum, joining every notice that fires', async () => {
      serve(TEXT, { truncatedAtBytes: 4_194_304 });

      const { page, content } = await read({ max_chars: 100_000_000 });

      expect(page).toMatchObject({ max_chars: 50_000, has_more: true });
      expect(page.text).toHaveLength(50_000);
      const notice = page.notice ?? '';
      expect(notice).toContain('first 4,194,304 bytes');
      expect(notice).toContain('max_chars 100,000,000');
      expect(notice).toContain("this server's maximum of 50,000");
      expect(notice).toContain('char_offset 50000');
      expect(content).toContain(notice);
    });

    it('keeps the clamp notice alone when the clamped page reaches the end', async () => {
      serve('short text');

      const { page } = await read({ max_chars: 60_000 });

      expect(page).toMatchObject({ text: 'short text', max_chars: 50_000, has_more: false });
      expect(page.notice).toContain('max_chars 60,000');
      expect(page.notice).not.toContain('char_offset');
    });

    it('names no next page when a page ends exactly at the end of the text', async () => {
      serve();

      const { page, content } = await read({ char_offset: 127_671 });

      expect(page).toMatchObject({ char_offset: 127_671, has_more: false, total_chars: 177_671 });
      expect(page.text).toHaveLength(50_000);
      expect(page.notice).toBeUndefined();
      expect(content).toContain('**Total Chars:** 177,671 — end of text');
    });

    it('adds no clamp notice for a max_chars equal to the maximum', async () => {
      serve();

      const { page } = await read({ max_chars: 50_000 });

      expect(page.max_chars).toBe(50_000);
      expect(page.notice).toBe(
        `More text follows: call ia_get_snapshot again with url \`${PAGE_URL}\`, timestamp 20200101030920 (resolved_timestamp), and char_offset 50000 for the next page.`,
      );
    });

    it('names the maximum as the clamped page size', async () => {
      serve('short text');

      const { page } = await read({ max_chars: 60_000 });

      expect(page.notice).toBe(
        "max_chars 60,000 is above this server's maximum of 50,000 characters per call, so this page holds up to 50,000.",
      );
    });

    it('names the next page by the capture Wayback served and the offset past this page, on both surfaces', async () => {
      const served = `https://web.archive.org/web/20200101030925/${PAGE_URL}`;
      serve(TEXT, { replayUrl: served, timestamp: '20200101030925' });

      const { page, content } = await read({ timestamp: '20200101030000', char_offset: 50_000 });

      expect(page.notice).toBe(
        `More text follows: call ia_get_snapshot again with url \`${PAGE_URL}\`, timestamp 20200101030925 (resolved_timestamp), and char_offset 100000 for the next page.`,
      );
      expect(content).toContain(
        `> More text follows: call ia_get_snapshot again with url \`${PAGE_URL}\`, timestamp 20200101030925`,
      );
      expect(content).toContain(
        '**Offset:** 50,000 | **Max Chars:** 50,000 | **Total Chars:** 177,671 — more follows (next offset: 100,000)',
      );
    });

    it('names a url holding a backtick in a code span that reads back as exactly that url, on both surfaces', async () => {
      serve();

      const { page, content } = await read({ url: 'https://example.com/a`b' });

      // CommonMark: a span opened by two backticks ends at the next run of exactly two, so the one inside stays literal.
      const notice =
        'More text follows: call ia_get_snapshot again with url ``https://example.com/a`b``, timestamp 20200101030920 (resolved_timestamp), and char_offset 50000 for the next page.';
      expect(page.notice).toBe(notice);
      expect(content).toContain(`> ${notice}`);
    });

    it('pages by UTF-16 code units, as ia_get_text does, so split surrogate pairs rejoin', async () => {
      const astral = '😀a😀';
      serve(astral);

      const pages: string[] = [];
      for (let char_offset = 0; char_offset < astral.length; char_offset++) {
        const { page } = await read({ char_offset, max_chars: 1 });
        expect(page.total_chars).toBe(5);
        pages.push(page.text);
      }

      expect(pages).toEqual(['\ud83d', '\ude00', 'a', '\ud83d', '\ude00']);
      expect(pages.join('')).toBe(astral);
    });

    it.each([
      ['a negative char_offset', 'char_offset', -1],
      ['a fractional char_offset', 'char_offset', 1.5],
      ['a zero max_chars', 'max_chars', 0],
      ['a fractional max_chars', 'max_chars', 2.5],
    ])('rejects %s by its constraint, without a Wayback call', async (_label, field, value) => {
      const result = await runToolContract(iaGetSnapshot, {
        url: PAGE_URL,
        timestamp: '20200101030920',
        [field]: value,
      });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: unknown }).error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain(`${field}:`);
      expect(text).not.toContain('Unrecognized key');
      expect(mockService.fetchContent).not.toHaveBeenCalled();
    });
  });

  describe('archived redirects (#63)', () => {
    const URL_ASKED = 'http://example.com/docs/report.pdf';
    const ASKED_AT = '20250805171636';
    const SERVED = 'https://web.archive.org/web/20250828072413/http://redirected.example.org/';
    const TO_TARGET = {
      status: 301,
      captureTimestamp: ASKED_AT,
      target: 'http://redirected.example.org/',
    };
    const NOTICE =
      'The capture at 20250805171636 is an archived HTTP 301 redirect to `http://redirected.example.org/`, and the text comes from the capture Wayback served for that URL (replay_url).';

    type Result = Awaited<ReturnType<typeof runToolContract>>;
    const textOf = (result: Result) =>
      result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

    const serveRedirected = (
      text: string,
      redirects: unknown[],
      extra: Record<string, unknown> = {},
    ) => {
      mockService.buildReplayUrl.mockReturnValue(
        `https://web.archive.org/web/${ASKED_AT}/${URL_ASKED}`,
      );
      mockService.fetchContent.mockResolvedValue({
        text,
        replayUrl: SERVED,
        timestamp: '20250828072413',
        status: '200',
        redirects,
        ...extra,
      });
    };
    const read = (input: Record<string, unknown> = {}) =>
      runToolContract(iaGetSnapshot, { url: URL_ASKED, timestamp: ASKED_AT, ...input });

    it('names the archived redirect and its target in a notice, on both surfaces', async () => {
      serveRedirected('home page', [TO_TARGET]);

      const result = await read();

      expect(result.structuredContent).toMatchObject({
        text: 'home page',
        replay_url: SERVED,
        resolved_timestamp: '20250828072413',
        resolved_status: '200',
        notice: NOTICE,
      });
      expect(textOf(result)).toContain(`> ${NOTICE}`);
    });

    it('names each archived redirect a chain passed, in order', async () => {
      serveRedirected('final', [
        TO_TARGET,
        {
          status: 302,
          captureTimestamp: '20250805171640',
          target: 'https://final.example.net/a`b',
        },
      ]);

      const result = await read();

      const notice =
        'The capture at 20250805171636 is an archived HTTP 301 redirect to `http://redirected.example.org/`, whose capture at 20250805171640 is an archived HTTP 302 redirect to ``https://final.example.net/a`b``, and the text comes from the capture Wayback served for that URL (replay_url).';
      expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
      expect(textOf(result)).toContain(`> ${notice}`);
    });

    it('opens the notice with the archived redirect when the read-limit and max_chars notices fire too, on both surfaces', async () => {
      serveRedirected('home page', [TO_TARGET], { truncatedAtBytes: 4_194_304 });

      const result = await read({ max_chars: 60_000 });

      const notice = `${NOTICE} The archived page is longer than 4,194,304 bytes; the text comes from its first 4,194,304 bytes. Open replay_url for the full page. max_chars 60,000 is above this server's maximum of 50,000 characters per call, so this page holds up to 50,000.`;
      expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
      expect(textOf(result)).toContain(`> ${notice}`);
    });

    it('names the served capture’s original URL in the next-page notice after an archived redirect', async () => {
      serveRedirected('a'.repeat(60_000), [TO_TARGET]);

      const result = await read();

      const next =
        'More text follows: call ia_get_snapshot again with url `http://redirected.example.org/`, timestamp 20250828072413 (resolved_timestamp), and char_offset 50000 for the next page.';
      expect((result.structuredContent as { notice?: string }).notice).toBe(`${NOTICE} ${next}`);
      expect(textOf(result)).toContain(next);
    });

    it.each<[label: string, redirects: unknown[] | undefined, message: string]>([
      [
        'served without a redirect, in the message it has always had',
        undefined,
        `The capture of ${URL_ASKED} that Wayback served is application/pdf, not text, so it has no text to return; the original file is at ${SERVED}.`,
      ],
      [
        'reached through an archived redirect, opening with the redirect',
        [TO_TARGET],
        `The capture of ${URL_ASKED} at ${ASKED_AT} is an archived HTTP 301 redirect to http://redirected.example.org/; the capture Wayback served for that URL is application/pdf, not text, so it has no text to return; the original file is at ${SERVED}.`,
      ],
    ])('fails a non-text capture %s, on both surfaces', async (_label, redirects, message) => {
      mockService.buildReplayUrl.mockReturnValue(
        `https://web.archive.org/web/${ASKED_AT}/${URL_ASKED}`,
      );
      mockService.fetchContent.mockRejectedValue(
        notFound(`The capture at ${SERVED} is application/pdf, not text.`, {
          mediaType: 'application/pdf',
          replayUrl: SERVED,
          ...(redirects && { redirects }),
        }),
      );

      const result = await read();

      const hint = iaGetSnapshot.errors?.find((e) => e.reason === 'non_text_capture')?.recovery;
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message,
          data: {
            reason: 'non_text_capture',
            mediaType: 'application/pdf',
            replayUrl: SERVED,
            recovery: { hint },
          },
        },
      });
      const text = textOf(result);
      expect(text).toContain(`Error: ${message}`);
      expect(text).toContain(`Recovery: ${hint}`);
    });

    const recovery = () =>
      iaGetSnapshot.errors?.find((e) => e.reason === 'no_snapshot_available')?.recovery as string;
    const LOOP_A = `https://web.archive.org/web/${ASKED_AT}/http://loop-a.example.com/`;

    it.each<[ending: string, data: Record<string, unknown>, message: string]>([
      [
        'a target Wayback never archived',
        {
          status: 404,
          redirects: [
            { status: 302, captureTimestamp: ASKED_AT, target: 'http://parked.example.org/?s=1' },
          ],
          deadEnd: { kind: 'not_archived' },
        },
        'The capture of http://example.com/docs/report.pdf at 20250805171636 is an archived HTTP 302 redirect to http://parked.example.org/?s=1; the Wayback Machine has not archived that URL.',
      ],
      [
        'an archived error page of the target',
        {
          status: 404,
          redirects: [TO_TARGET],
          deadEnd: { kind: 'archived_error', status: 404, captureTimestamp: '20250805171640' },
        },
        'The capture of http://example.com/docs/report.pdf at 20250805171636 is an archived HTTP 301 redirect to http://redirected.example.org/; its capture at 20250805171640 is an archived HTTP 404 error page.',
      ],
      [
        'a refused replay of the target',
        { status: 403, redirects: [TO_TARGET], deadEnd: { kind: 'refused', status: 403 } },
        'The capture of http://example.com/docs/report.pdf at 20250805171636 is an archived HTTP 301 redirect to http://redirected.example.org/; the Wayback Machine refused to replay it with HTTP 403.',
      ],
      [
        'a loop',
        {
          status: 301,
          redirects: [
            { status: 301, captureTimestamp: ASKED_AT, target: 'http://loop-b.example.com/' },
            { status: 301, captureTimestamp: ASKED_AT, target: 'http://loop-a.example.com/' },
          ],
          deadEnd: { kind: 'loop', url: LOOP_A },
        },
        `The capture of http://example.com/docs/report.pdf at 20250805171636 is an archived HTTP 301 redirect to http://loop-b.example.com/, whose capture at 20250805171636 is an archived HTTP 301 redirect to http://loop-a.example.com/; the next redirect returns to ${LOOP_A}, which was already requested.`,
      ],
      [
        'an eleventh redirect',
        { status: 302, redirects: [], deadEnd: { kind: 'too_many_redirects' } },
        'No readable capture of http://example.com/docs/report.pdf at 20250805171636: the redirects continue past 10, the most this server follows.',
      ],
      [
        'an archived redirect with no Location',
        {
          status: 301,
          redirects: [],
          deadEnd: { kind: 'no_location', status: 301, captureTimestamp: ASKED_AT },
        },
        'No readable capture of http://example.com/docs/report.pdf at 20250805171636: the capture at 20250805171636 is an archived HTTP 301 redirect with no Location header.',
      ],
      [
        'a Wayback redirect with no Location, after an archived one',
        { status: 302, redirects: [TO_TARGET], deadEnd: { kind: 'no_location', status: 302 } },
        'The capture of http://example.com/docs/report.pdf at 20250805171636 is an archived HTTP 301 redirect to http://redirected.example.org/; the Wayback Machine answered HTTP 302 with no Location header.',
      ],
      [
        'an archived redirect to a Location that is not followed',
        {
          status: 302,
          redirects: [],
          deadEnd: {
            kind: 'bad_location',
            status: 302,
            location: 'ftp://files.example.com/report.pdf',
            captureTimestamp: ASKED_AT,
          },
        },
        'No readable capture of http://example.com/docs/report.pdf at 20250805171636: the capture at 20250805171636 is an archived HTTP 302 redirect to ftp://files.example.com/report.pdf, which is not an http(s) Wayback Machine URL, so it is not followed.',
      ],
      [
        'a Wayback redirect off the Wayback hosts, after an archived one',
        {
          status: 302,
          redirects: [TO_TARGET],
          deadEnd: {
            kind: 'bad_location',
            status: 302,
            location: 'https://redirected.example.org/elsewhere',
          },
        },
        'The capture of http://example.com/docs/report.pdf at 20250805171636 is an archived HTTP 301 redirect to http://redirected.example.org/; the Wayback Machine redirected to https://redirected.example.org/elsewhere, which is not an http(s) Wayback Machine URL, so it is not followed.',
      ],
    ])(
      'fails redirects ending on %s as no_snapshot_available naming the chain, on both surfaces',
      async (_ending, data, message) => {
        mockService.buildReplayUrl.mockReturnValue(
          `https://web.archive.org/web/${ASKED_AT}/${URL_ASKED}`,
        );
        const deadEnd = notFound("The replay's redirects reached no readable capture.", data);
        mockService.fetchContent.mockRejectedValue(deadEnd);

        const result = await read();

        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.NotFound,
            message,
            data: { reason: 'no_snapshot_available', recovery: { hint: recovery() } },
          },
        });
        const text = textOf(result);
        expect(text).toContain(message);
        expect(text).toContain(`Recovery: ${recovery()}`);
      },
    );
  });

  describe('links (#67)', () => {
    const PAGE_URL = 'http://info.cern.ch/hypertext/WWW/TheProject.html';
    const TIMESTAMP = '20151231164925';
    const REPLAY = `https://web.archive.org/web/${TIMESTAMP}/${PAGE_URL}`;
    const TEXT =
      'The World Wide Web project\nThe WorldWideWeb (W3) is a wide-area hypermedia information retrieval initiative. Everything there is online about W3 is linked directly or indirectly to this document, including an executive summary of the project.';

    type ServiceLink = { offset: number; text: string; url: string };
    type Page = {
      text: string;
      char_offset: number;
      max_chars: number;
      has_more: boolean;
      total_chars: number;
      links?: { text: string; url: string }[];
      total_links?: number;
      notice?: string;
    };

    const link = (label: string, url: string): ServiceLink => ({
      offset: TEXT.indexOf(label),
      text: label,
      url,
    });
    const LINKS = [
      link('hypermedia', 'http://info.cern.ch/hypertext/WWW/WhatIs.html'),
      link('executive summary', 'http://info.cern.ch/hypertext/WWW/Summary.html'),
    ];
    const NEXT_PAGE = (charOffset: number, links: boolean) =>
      `More text follows: call ia_get_snapshot again with url \`${PAGE_URL}\`, timestamp ${TIMESTAMP} (resolved_timestamp), ${links ? `char_offset ${charOffset}, and include_links true` : `and char_offset ${charOffset}`} for the next page.`;

    /** Serves `text` as the capture, with `links` only when the fetch asks for them, as the service does. */
    const serve = (text = TEXT, links: ServiceLink[] = LINKS) => {
      mockService.buildReplayUrl.mockReturnValue(REPLAY);
      mockService.fetchContent.mockImplementation(
        async (_url: string, _ctx: unknown, _deadline: unknown, options?: { links?: boolean }) => ({
          text,
          replayUrl: REPLAY,
          timestamp: TIMESTAMP,
          status: '200',
          ...(options?.links && { links }),
        }),
      );
    };
    const read = async (input: Record<string, unknown> = {}) => {
      const result = await runToolContract(iaGetSnapshot, {
        url: PAGE_URL,
        timestamp: TIMESTAMP,
        ...input,
      });
      expect(result.isError).toBeFalsy();
      const content = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      return { page: result.structuredContent as Page, content };
    };

    it('without include_links, fetches the page as before and returns neither links nor total_links, on both surfaces', async () => {
      serve();

      const { page, content } = await read({ max_chars: 100 });

      expect(mockService.fetchContent.mock.calls[0]).toHaveLength(3);
      expect(page).toStrictEqual({
        text: TEXT.slice(0, 100),
        replay_url: REPLAY,
        resolved_timestamp: TIMESTAMP,
        resolved_status: '200',
        char_offset: 0,
        max_chars: 100,
        has_more: true,
        total_chars: 242,
        notice: NEXT_PAGE(100, false),
      });
      expect(content).toBe(
        `**Replay URL:** [https://web.archive.org/web/20151231164925/http://info.cern.ch/hypertext/WWW/TheProject.html](<${REPLAY}>)\n**Resolved Timestamp:** 20151231164925 | **Status:** 200\n**Offset:** 0 | **Max Chars:** 100 | **Total Chars:** 242 — more follows (next offset: 100)\n\n---\n\nThe World Wide Web project\\\nThe WorldWideWeb (W3) is a wide-area hypermedia information retrieval ini\n\n\n> ${NEXT_PAGE(100, false)}`,
      );
    });

    it('with include_links, asks the service for links and returns the page’s as { text, url } with the total, on both surfaces', async () => {
      serve();

      const { page, content } = await read({ include_links: true });

      expect(mockService.fetchContent).toHaveBeenCalledWith(
        REPLAY,
        expect.anything(),
        CALL_DEADLINE,
        { links: true },
      );
      expect(page.links).toStrictEqual([
        { text: 'hypermedia', url: 'http://info.cern.ch/hypertext/WWW/WhatIs.html' },
        { text: 'executive summary', url: 'http://info.cern.ch/hypertext/WWW/Summary.html' },
      ]);
      expect(page.total_links).toBe(2);
      expect(page.notice).toBeUndefined();
      expect(content).toBe(
        `**Replay URL:** [https://web.archive.org/web/20151231164925/http://info.cern.ch/hypertext/WWW/TheProject.html](<${REPLAY}>)\n**Resolved Timestamp:** 20151231164925 | **Status:** 200\n**Offset:** 0 | **Max Chars:** 50,000 | **Total Chars:** 242 — end of text\n\n---\n\nThe World Wide Web project\\\n${TEXT.split('\n')[1]}\n\n**Links on this page:** 2 of 2\n\n- [hypermedia](<http://info.cern.ch/hypertext/WWW/WhatIs.html>)\n- [executive summary](<http://info.cern.ch/hypertext/WWW/Summary.html>)`,
      );
    });

    it('names include_links in the next-page notice, so the next call keeps listing links, on both surfaces', async () => {
      serve();

      const { page, content } = await read({ include_links: true, max_chars: 100 });

      expect(page.notice).toBe(NEXT_PAGE(100, true));
      expect(content).toContain(`> ${NEXT_PAGE(100, true)}`);
      expect(page.links).toStrictEqual([
        { text: 'hypermedia', url: 'http://info.cern.ch/hypertext/WWW/WhatIs.html' },
      ]);
      expect(page.total_links).toBe(2);
      expect(content).toContain(
        '**Links on this page:** 1 of 2\n\n- [hypermedia](<http://info.cern.ch/hypertext/WWW/WhatIs.html>)',
      );
    });

    describe('which links a page holds', () => {
      const AT = [0, 9, 10, 55, 99, 100];
      const label = (offset: number) => `at ${offset}`;
      const serve100 = () =>
        serve(
          'abcdefghij'.repeat(10),
          AT.map((offset) => ({
            offset,
            text: label(offset),
            url: `https://example.com/${offset}`,
          })),
        );

      it.each<[charOffset: number, maxChars: number, at: number[], hasMore: boolean]>([
        [0, 10, [0, 9], true],
        [10, 10, [10], true],
        [50, 10, [55], true],
        [60, 30, [], true],
        // The last page, ending exactly at the end of the text, also takes the link there.
        [90, 10, [99, 100], false],
        [95, 10, [99, 100], false],
        [0, 200, AT, false],
        // At or past the end: no page of the text, so no link.
        [100, 10, [], false],
        [150, 10, [], false],
      ])(
        'lists the links starting in the page at %i of %i characters',
        async (char_offset, max_chars, at, hasMore) => {
          serve100();

          const { page } = await read({ include_links: true, char_offset, max_chars });

          expect(page.has_more).toBe(hasMore);
          expect(page.links).toStrictEqual(
            at.map((offset) => ({ text: label(offset), url: `https://example.com/${offset}` })),
          );
          expect(page.total_links).toBe(6);
        },
      );

      it('selects by the page served when max_chars is above the maximum', async () => {
        serve('x'.repeat(60_000), [
          { offset: 49_999, text: 'last on the page', url: 'https://example.com/a' },
          { offset: 50_000, text: 'first after it', url: 'https://example.com/b' },
        ]);

        const { page } = await read({ include_links: true, max_chars: 100_000 });

        expect(page.max_chars).toBe(50_000);
        expect(page.links).toStrictEqual([
          { text: 'last on the page', url: 'https://example.com/a' },
        ]);
        expect(page.total_links).toBe(2);
      });

      it('lists an empty capture’s image-only link on its one page, and none past it', async () => {
        serve('', [{ offset: 0, text: '', url: 'https://example.com/logo' }]);

        const first = await read({ include_links: true });
        const past = await read({ include_links: true, char_offset: 1 });

        expect(first.page).toMatchObject({ text: '', has_more: false, total_links: 1 });
        expect(first.page.links).toStrictEqual([{ text: '', url: 'https://example.com/logo' }]);
        expect(first.content).toContain(
          '**Links on this page:** 1 of 1\n\n- [](<https://example.com/logo>)',
        );
        expect(past.page.links).toStrictEqual([]);
        expect(past.page.total_links).toBe(1);
      });

      it('gives every link to exactly one page of a read that follows has_more, at every page size', async () => {
        /** Deterministic PRNG (mulberry32), so a failure reproduces. */
        let seed = 67;
        const random = () => {
          seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
        };
        const ctx = () => createMockContext({ errors: iaGetSnapshot.errors });
        const page = (char_offset: number, max_chars: number) =>
          iaGetSnapshot.handler(
            iaGetSnapshot.input.parse({
              url: PAGE_URL,
              timestamp: TIMESTAMP,
              include_links: true,
              char_offset,
              max_chars,
            }),
            ctx(),
          );

        for (let trial = 0; trial < 40; trial++) {
          // The first trials are the edges: an empty text, and one or two characters.
          const total = trial < 3 ? trial : Math.floor(random() * 40);
          const count = trial < 3 ? 2 : Math.floor(random() * 12);
          // Offsets run from 0 to the end of the text inclusive, ties included (an image-only link
          // starts where the next link does).
          const offsets = Array.from({ length: count }, () =>
            Math.floor(random() * (total + 1)),
          ).sort((a, b) => a - b);
          const links = offsets.map((offset, i) => ({
            offset,
            text: `link ${i}`,
            url: `https://example.com/${i}`,
          }));
          serve('t'.repeat(total), links);
          const whole = links.map(({ text, url }) => ({ text, url }));

          for (let maxChars = 1; maxChars <= total + 2; maxChars++) {
            const seen: { text: string; url: string }[] = [];
            for (let charOffset = 0; ; charOffset += maxChars) {
              const result = await page(charOffset, maxChars);
              expect(result.total_links).toBe(count);
              seen.push(...(result.links ?? []));
              if (!result.has_more) break;
            }
            expect(seen, `${count} links over ${total} characters, pages of ${maxChars}`).toEqual(
              whole,
            );
            if (total > 0) expect((await page(total, maxChars)).links).toEqual([]);
          }
        }
      });
    });

    it('returns no links for a capture that is not HTML, on both surfaces', async () => {
      serve('{"links": ["https://example.com/"]}', []);

      const { page, content } = await read({ include_links: true });

      expect(page.links).toStrictEqual([]);
      expect(page.total_links).toBe(0);
      expect(content).toMatch(/\*\*Links on this page:\*\* 0 of 0$/);
    });

    it('rejects an include_links that is not a boolean by its type, without a Wayback call', async () => {
      const result = await runToolContract(iaGetSnapshot, {
        url: PAGE_URL,
        timestamp: TIMESTAMP,
        include_links: 'yes',
      });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: unknown }).error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('include_links:');
      expect(text).not.toContain('Unrecognized key');
      expect(mockService.fetchContent).not.toHaveBeenCalled();
    });
  });

  describe('format', () => {
    it('renders replay URL, resolved timestamp, status, paging, and text', () => {
      const output = {
        text: 'Archived page body text.',
        replay_url: 'https://web.archive.org/web/20200101120000/https://example.com',
        resolved_timestamp: '20200101120000',
        resolved_status: '200',
        char_offset: 0,
        max_chars: 50_000,
        has_more: false,
        total_chars: 24,
      };
      const blocks = iaGetSnapshot.format!(output);
      expect(blocks.some((b) => b.type === 'text')).toBe(true);
      const text = blocks.map((b) => (b as { type: string; text: string }).text).join('');
      expect(text).toContain(output.replay_url);
      expect(text).toContain(output.resolved_timestamp);
      expect(text).toContain(output.resolved_status);
      expect(text).toContain(
        '**Offset:** 0 | **Max Chars:** 50,000 | **Total Chars:** 24 — end of text',
      );
      expect(text).toContain(output.text);
    });

    it('keeps a page’s leading tab and spaces, cell tabs, and blank line, so the text reads back exactly (#66)', () => {
      const replay =
        'https://web.archive.org/web/20150103131822/http://www.iana.org/domains/reserved';
      const text =
        '\tTitle\t\tReserved Top Level DNS Names\n   1. Introduction....1\nDomain\tLanguage\n\nEnd of text';
      const [block] = iaGetSnapshot.format!({
        text,
        replay_url: replay,
        resolved_timestamp: '20150103131822',
        resolved_status: '200',
        char_offset: 0,
        max_chars: 50_000,
        has_more: false,
        total_chars: text.length,
      }) as [{ text: string }];

      // A CommonMark parse reads the text back exactly: edge whitespace as character
      // references, each line break as a hard break, the blank line as one standing alone.
      expect(block.text).toBe(
        `**Replay URL:** [${replay}](<${replay}>)\n**Resolved Timestamp:** 20150103131822 | **Status:** 200\n**Offset:** 0 | **Max Chars:** 50,000 | **Total Chars:** 89 — end of text\n\n---\n\n&#9;Title\t\tReserved Top Level DNS Names\\\n&#32;&#32;&#32;1. Introduction....1\\\nDomain\tLanguage\\\n\\\nEnd of text`,
      );
    });
  });

  describe('links list in format() in linear time (#67)', () => {
    const fill = (unit: string, n: number): string =>
      unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    const url = 'https://example.com/';

    /** Worst cases for the list: label escaping, a URL's destination escaping, and the link count. */
    const WORST_CASES: [name: string, build: (n: number) => { text: string; url: string }[]][] = [
      ['a label of brackets and backslashes', (n) => [{ text: fill('\\]', n), url }]],
      ['a label of backtick runs', (n) => [{ text: fill('``a', n), url }]],
      [
        'a label on one long line ending in a break',
        (n) => [{ text: `${fill('§1 x', n - 2)}\ny`, url }],
      ],
      ['a label of breaks throughout', (n) => [{ text: fill('  \r\n', n), url }]],
      [
        'a URL of near-entity ampersands',
        (n) => [{ text: 'a', url: `${url}?${fill('&#1234567', n)}` }],
      ],
      [
        'a URL of angle brackets and backslashes',
        (n) => [{ text: 'a', url: `${url}${fill('<\\>', n)}` }],
      ],
      [
        'many short links',
        (n) => Array.from({ length: n / 25 }, (_, i) => ({ text: `l${i}`, url: `${url}${i}` })),
      ],
    ];

    /** CPU ceiling per call: 1 µs per character, about 12× the slowest shape measured (a label of breaks throughout: 23 ms at 320k on Bun, 27 ms on Node). */
    const MAX_CPU_MS_PER_CHAR = 0.001;

    it.each(WORST_CASES)(
      'renders %s in linear time',
      async (_name, build) => {
        await expectLinearDoubling((n) => {
          const links = build(n);
          const result = {
            text: '',
            replay_url: 'https://web.archive.org/web/20200101000000/https://example.com/',
            resolved_timestamp: '20200101000000',
            resolved_status: '200',
            char_offset: 0,
            max_chars: 50_000,
            has_more: false,
            total_chars: 0,
            links,
            total_links: links.length,
          };
          return () => iaGetSnapshot.format!(result);
        }, MAX_CPU_MS_PER_CHAR);
      },
      0,
    );
  });

  describe('next-page notice url code span in linear time', () => {
    const fill = (unit: string, n: number): string =>
      unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

    /** Worst cases for sizing a code span's delimiters: backtick runs, edge spaces, and line breaks. */
    const WORST_CASES: [name: string, build: (n: number) => string][] = [
      ['one backtick run', (n) => fill('`', n)],
      ['alternating backticks', (n) => fill('a`', n)],
      ['spaces at both ends', (n) => ` ${fill('a', n - 2)} `],
      ['a long URL', (n) => `https://example.com/${fill('a/', n - 20)}`],
      ['one long line ending in a break', (n) => `${fill('§1 x', n - 2)}\ny`],
      ['breaks throughout', (n) => fill('  \r\n', n)],
    ];

    /** CPU ceiling per call: 0.5 µs per character, about 35× the slowest shape measured (4.5 ms at 320k). */
    const MAX_CPU_MS_PER_CHAR = 0.0005;

    it.each(WORST_CASES)(
      'wraps %s in linear time',
      async (_name, build) => {
        await expectLinearDoubling((n) => {
          const url = build(n);
          return () => markdown().inlineCode(url).build();
        }, MAX_CPU_MS_PER_CHAR);
      },
      0,
    );
  });
});
