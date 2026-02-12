/**
 * OAuth Authorization Code Exchange
 *
 * Unified entry point for exchanging authorization codes for access tokens
 * across different OAuth providers.
 */

import type { ExchangeContext, ExchangeResult, ProviderAdapter } from './types.js';
import { getProviderAdapter } from './providers/registry.js';
import { oauthHttpPost } from './http.js';
import { resolveExpires } from './utils.js';
import { OAuthExchangeError } from './errors.js';

/**
 * Resolve the token URL with the following priority:
 * 1. ctx.tokenUrl (explicit override, highest priority)
 * 2. adapter.getTokenUrl(ctx) (dynamic URL builder)
 * 3. adapter.tokenUrl (static URL)
 *
 * @throws OAuthExchangeError if no token URL can be resolved
 */
function resolveTokenUrl(ctx: ExchangeContext, adapter: ProviderAdapter): string {
  // Priority 1: Explicit tokenUrl in context
  if (ctx.tokenUrl) {
    return ctx.tokenUrl;
  }

  // Priority 2: Dynamic URL builder
  if (adapter.getTokenUrl) {
    return adapter.getTokenUrl(ctx);
  }

  // Priority 3: Static URL from adapter
  if (adapter.tokenUrl) {
    return adapter.tokenUrl;
  }

  // No URL available
  throw new OAuthExchangeError(
    `No token URL available for provider '${ctx.provider}'. ` +
      `This provider requires ctx.tokenUrl to be specified.`,
    {
      type: 'http',
      provider: ctx.provider,
    }
  );
}

/**
 * Exchange an authorization code for access and refresh tokens
 *
 * @param ctx - Exchange context with provider details and authorization code
 * @returns Exchange result with tokens and expiration info
 * @throws OAuthExchangeError on HTTP errors, parse errors, unknown provider, or missing tokenUrl
 *
 * @example
 * ```typescript
 * // For providers with fixed URLs (Google, Notion, etc.), tokenUrl is optional:
 * const result = await exchangeAuthorizationCode({
 *   provider: 'notion',
 *   clientId: 'your-client-id',
 *   clientSecret: 'your-client-secret',
 *   code: 'authorization-code',
 *   redirectUri: 'https://your-app.com/callback',
 * });
 *
 * // For providers with dynamic URLs (Zendesk, Canvas), tokenUrl is required:
 * const result = await exchangeAuthorizationCode({
 *   provider: 'zendesk',
 *   tokenUrl: 'https://mycompany.zendesk.com/oauth/tokens',
 *   clientId: 'your-client-id',
 *   clientSecret: 'your-client-secret',
 *   code: 'authorization-code',
 *   redirectUri: 'https://your-app.com/callback',
 * });
 *
 * // result: { accessToken, refreshToken?, expiresIn?, expiresAt?, raw }
 * ```
 */
export async function exchangeAuthorizationCode(
  ctx: ExchangeContext
): Promise<ExchangeResult> {
  const adapter = getProviderAdapter(ctx.provider);
  const tokenUrl = resolveTokenUrl(ctx, adapter);
  const request = adapter.buildRequest(ctx);
  const response = await oauthHttpPost(tokenUrl, request, ctx.provider);
  const { data } = response;

  if (typeof data.access_token !== 'string' || data.access_token.trim() === '') {
    throw new OAuthExchangeError('No access token found in response', {
      type: 'parse',
      provider: ctx.provider,
      responseBody: JSON.stringify(data),
    });
  }
  // Extract tokens from response
  const accessToken = data.access_token as string;
  const refreshToken = data.refresh_token as string | undefined;

  // Resolve expiration
  const responseExpiresIn =
    typeof data.expires_in === 'number' ? data.expires_in : undefined;
  const { expiresIn, expiresAt } = resolveExpires(
    responseExpiresIn,
    adapter.defaultExpiresIn
  );

  return {
    accessToken,
    refreshToken,
    expiresIn,
    expiresAt,
    raw: data,
  };
}
