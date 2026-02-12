/**
 * GitHub App OAuth Provider Adapter (user access tokens)
 *
 * Token URL: https://github.com/login/oauth/access_token
 * Auth Method: Form params (client_id/client_secret in body)
 * Content-Type: application/x-www-form-urlencoded
 * Accept: application/json (required to get JSON response)
 * Returns expires_in: Yes (default 8 hours when token expiration is enabled)
 * Returns refresh_token: Yes (when user-to-server token expiration is enabled)
 */

import type { ExchangeContext, ProviderAdapter, ProviderRequest } from '../types.js';

const EIGHT_HOURS_SECONDS = 8 * 60 * 60; // 28800

export const githubAdapter: ProviderAdapter = {
  name: 'github',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  defaultExpiresIn: EIGHT_HOURS_SECONDS,

  buildRequest(ctx: ExchangeContext): ProviderRequest {
    const params = new URLSearchParams({
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
        Accept: 'application/json',
      },
      body: params,
    };
  },
};
