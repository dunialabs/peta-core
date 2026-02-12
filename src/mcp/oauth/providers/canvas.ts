/**
 * Canvas LMS OAuth Provider Adapter
 *
 * Token URL: https://{instance}/login/oauth2/token (DYNAMIC - requires ctx.tokenUrl)
 * Auth Method: Form params (client_id/client_secret in body)
 * Content-Type: application/x-www-form-urlencoded
 * Returns expires_in: Yes (typically 1 hour / 3600 seconds)
 *
 * IMPORTANT: Canvas uses instance-specific token URLs. The ctx.tokenUrl parameter
 * is REQUIRED and must contain the full URL for the specific Canvas instance.
 * Example: https://canvas.instructure.com/login/oauth2/token
 */

import type { ExchangeContext, ProviderAdapter, ProviderRequest } from '../types.js';

export const canvasAdapter: ProviderAdapter = {
  name: 'canvas',

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
