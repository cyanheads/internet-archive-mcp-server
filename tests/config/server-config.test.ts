/**
 * @fileoverview Tests for the server-specific environment config.
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A fresh copy of the module, so its parsed-config cache starts empty. */
const loadConfig = async () => {
  vi.resetModules();
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig();
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('IA_MAX_SNAPSHOT_CHARS', () => {
  it('defaults to 50,000 when unset', async () => {
    vi.stubEnv('IA_MAX_SNAPSHOT_CHARS', '');

    expect((await loadConfig()).maxSnapshotChars).toBe(50_000);
  });

  it.each([
    ['1', 1],
    ['120000', 120_000],
  ])('accepts %s', async (raw, parsed) => {
    vi.stubEnv('IA_MAX_SNAPSHOT_CHARS', raw);

    expect((await loadConfig()).maxSnapshotChars).toBe(parsed);
  });

  it.each([
    ['0', 'too_small'],
    ['-5', 'too_small'],
    ['2.5', 'invalid_type'],
  ])('fails startup on %s, naming the variable', async (raw, code) => {
    vi.stubEnv('IA_MAX_SNAPSHOT_CHARS', raw);

    const err = await loadConfig().catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringContaining('IA_MAX_SNAPSHOT_CHARS (maxSnapshotChars)'),
      data: { issues: [expect.objectContaining({ envVar: 'IA_MAX_SNAPSHOT_CHARS', code })] },
    });
  });
});

describe('IA_REQUEST_TIMEOUT_MS', () => {
  it('defaults to 30,000 when unset', async () => {
    vi.stubEnv('IA_REQUEST_TIMEOUT_MS', '');

    expect((await loadConfig()).requestTimeoutMs).toBe(30_000);
  });

  it.each([
    ['1', 1],
    ['3000', 3_000],
    ['120000', 120_000],
  ])('accepts %s', async (raw, parsed) => {
    vi.stubEnv('IA_REQUEST_TIMEOUT_MS', raw);

    expect((await loadConfig()).requestTimeoutMs).toBe(parsed);
  });

  it.each([
    ['0', 'too_small'],
    ['-1000', 'too_small'],
    ['1500.5', 'invalid_type'],
  ])('fails startup on %s, naming the variable', async (raw, code) => {
    vi.stubEnv('IA_REQUEST_TIMEOUT_MS', raw);

    const err = await loadConfig().catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringContaining('IA_REQUEST_TIMEOUT_MS (requestTimeoutMs)'),
      data: { issues: [expect.objectContaining({ envVar: 'IA_REQUEST_TIMEOUT_MS', code })] },
    });
  });
});
