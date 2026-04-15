/**
 * Microsoft Teams / Microsoft Entra OAuth Provider Adapter
 *
 * Token URL: https://login.microsoftonline.com/common/oauth2/v2.0/token
 * Auth Method: Form params (client_id/client_secret in body)
 * Content-Type: application/x-www-form-urlencoded
 * Returns expires_in and refresh_token: Yes (when offline_access is granted)
 *
 * Teams authorization code exchange requires PKCE code_verifier.
 */

import type { ExchangeContext, ProviderAdapter, ProviderRequest } from '../types.js';

export const teamsAdapter: ProviderAdapter = {
  name: 'teams',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',

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
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    };
  },
};
