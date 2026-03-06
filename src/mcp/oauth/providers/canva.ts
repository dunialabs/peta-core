/**
 * Canva OAuth Provider Adapter
 *
 * Token URL: https://api.canva.com/rest/v1/oauth/token
 * Auth Method: Basic Auth (client_id:client_secret)
 * Content-Type: application/x-www-form-urlencoded
 * Returns expires_in: Yes
 *
 * Note: Canva authorization_code exchange requires PKCE code_verifier.
 */

import type { ExchangeContext, ProviderAdapter, ProviderRequest } from '../types.js';

export const canvaAdapter: ProviderAdapter = {
  name: 'canva',
  tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',

  buildRequest(ctx: ExchangeContext): ProviderRequest {
    const credentials = Buffer.from(`${ctx.clientId}:${ctx.clientSecret}`).toString('base64');

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: ctx.code,
      redirect_uri: ctx.redirectUri,
    });

    if (ctx.codeVerifier) {
      params.set('code_verifier', ctx.codeVerifier);
    }

    return {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body: params,
    };
  },
};
