/**
 * Zendesk OAuth Provider Adapter
 *
 * Token URL: https://{subdomain}.zendesk.com/oauth/tokens (DYNAMIC - requires ctx.tokenUrl)
 * Auth Method: JSON body params (client_id/client_secret in body)
 * Content-Type: application/json
 * Returns expires_in: Yes
 *
 * IMPORTANT: Zendesk uses subdomain-based token URLs. The ctx.tokenUrl parameter
 * is REQUIRED and must contain the full URL including the subdomain.
 * Example: https://mycompany.zendesk.com/oauth/tokens
 */

import type { ExchangeContext, ProviderAdapter, ProviderRequest } from '../types.js';

export const zendeskAdapter: ProviderAdapter = {
  name: 'zendesk',

  buildRequest(ctx: ExchangeContext): ProviderRequest {
    const body = {
      grant_type: 'authorization_code',
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
      code: ctx.code,
      redirect_uri: ctx.redirectUri,
    };

    return {
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    };
  },
};
