export const MODERN_MCP_PROTOCOL_VERSION = '2026-07-28';

export const MODERN_MCP_CONFIG = {
  enabled: process.env.MCP_2026_ENABLED === 'true',
  downstreamEnabled: (process.env.MCP_2026_DOWNSTREAM_ENABLED ?? process.env.MCP_2026_ENABLED) === 'true',
  supportedVersions: (process.env.MCP_2026_SUPPORTED_VERSIONS ?? MODERN_MCP_PROTOCOL_VERSION)
    .split(',')
    .map((version) => version.trim())
    .filter((version) => version.length > 0),
  allowedClientIds: (process.env.MCP_2026_ALLOWED_CLIENT_IDS ?? '')
    .split(',')
    .map((clientId) => clientId.trim())
    .filter((clientId) => clientId.length > 0),
  allowedTenantIds: (process.env.MCP_2026_ALLOWED_TENANT_IDS ?? '')
    .split(',')
    .map((tenantId) => tenantId.trim())
    .filter((tenantId) => tenantId.length > 0),
  defaultListTtlMs: 0,
  defaultCacheScope: 'private',
} as const;

export function isModernMcpVersion(version: string | undefined): boolean {
  return Boolean(version && MODERN_MCP_CONFIG.supportedVersions.includes(version));
}
