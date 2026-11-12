/**
 * @fileoverview Tests for the ia_get_snapshot tool.
 * @module tests/tools/ia-get-snapshot.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iaGetSnapshot } from '@/mcp-server/tools/definitions/ia-get-snapshot.tool.js';

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

    expect(mockService.findClosest).toHaveBeenCalledWith('https://example.com', '20200101', ctx);
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

    expect(mockService.findClosest).toHaveBeenCalledWith('https://example.com', '20200101', ctx);
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
        'More text follows: call ia_get_snapshot again with the same url, timestamp 20200101030920 (resolved_timestamp), and char_offset 50000 for the next page.',
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
        'More text follows: call ia_get_snapshot again with the same url, timestamp 20200101030925 (resolved_timestamp), and char_offset 100000 for the next page.',
      );
      expect(content).toContain(
        '**Offset:** 50,000 | **Max Chars:** 50,000 | **Total Chars:** 177,671 — more follows (next offset: 100,000)',
      );
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
  });
});
