/**
 * OAuth Authorization Code Exchange Module
 *
 * Provides unified token exchange functionality for external OAuth providers.
 *
 * @example
 * ```typescript
 * import { exchangeAuthorizationCode } from './mcp/oauth/index.js';
 *
 * const result = await exchangeAuthorizationCode({
 *   provider: 'notion',
 *   tokenUrl: 'https://api.notion.com/v1/oauth/token',
 *   clientId: '...',
 *   clientSecret: '...',
 *   code: '...',
 *   redirectUri: '...',
 * });
 * ```
 */

// Main entry point
export { exchangeAuthorizationCode } from './exchange.js';

// Types
export type { ExchangeContext, ExchangeResult } from './types.js';

// Errors
export { OAuthExchangeError } from './errors.js';

// Utilities (for advanced usage)
export { getSupportedProviders } from './providers/registry.js';
