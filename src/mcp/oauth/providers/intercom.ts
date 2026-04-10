/**
 * Intercom OAuth Provider Adapter
 *
 * Token URL: https://api.intercom.io/auth/eagle/token
 * Auth Method: Form params (client_id/client_secret in body)
 * Content-Type: application/x-www-form-urlencoded
 *
 * Intercom does not return refresh_token or expires_in for OAuth tokens.
 */

import type { ExchangeContext, ProviderAdapter, ProviderRequest } from '../types.js';

export const intercomAdapter: ProviderAdapter = {
  name: 'intercom',
  tokenUrl: 'https://api.intercom.io/auth/eagle/token',

  buildRequest(ctx: ExchangeContext): ProviderRequest {
    const params = new URLSearchParams({
      code: ctx.code,
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
    });

    return {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    };
  },
};
