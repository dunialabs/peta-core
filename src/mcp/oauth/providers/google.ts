/**
 * Google OAuth Provider Adapter
 *
 * Token URL: https://oauth2.googleapis.com/token
 * Auth Method: Form params (client_id/client_secret in body)
 * Content-Type: application/x-www-form-urlencoded
 * Returns expires_in: Yes
 */

import type { ExchangeContext, ProviderAdapter, ProviderRequest } from '../types.js';

export const googleAdapter: ProviderAdapter = {
  name: 'google',
  tokenUrl: 'https://oauth2.googleapis.com/token',

  buildRequest(ctx: ExchangeContext): ProviderRequest {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
      code: ctx.code,
      redirect_uri: ctx.redirectUri,
    });

    if (ctx.codeVerifier) {
      params.set('code_verifier', ctx.codeVerifier);
    }

    return {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    };
  },
};
