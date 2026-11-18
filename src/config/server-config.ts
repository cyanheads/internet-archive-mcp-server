/**
 * @fileoverview Server-specific configuration for internet-archive-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  userAgent: z
    .string()
    .optional()
    .describe('Custom User-Agent string for Internet Archive API requests.'),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe(
      'Timeout for each upstream HTTP request, in milliseconds. A whole tool call or resource read ends within 55 s, or within this timeout when it is longer.',
    ),
  maxSnapshotChars: z.coerce
    .number()
    .int()
    .min(1)
    .default(50_000)
    .describe(
      'Default and maximum characters per ia_get_text and ia_get_snapshot page (a larger max_chars is served at it).',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    userAgent: 'IA_USER_AGENT',
    requestTimeoutMs: 'IA_REQUEST_TIMEOUT_MS',
    maxSnapshotChars: 'IA_MAX_SNAPSHOT_CHARS',
  });
  return _config;
}

/** Returns the User-Agent header value, falling back to the default. */
export function getUserAgent(version: string): string {
  const cfg = getServerConfig();
  return (
    cfg.userAgent ??
    `internet-archive-mcp-server/${version} (github.com/cyanheads/internet-archive-mcp-server)`
  );
}
