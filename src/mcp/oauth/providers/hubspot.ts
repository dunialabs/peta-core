/**
 * HubSpot OAuth Provider Adapter
 *
 * Token URL: https://api.hubapi.com/oauth/v3/token
 * Auth Method: Form params (client_id/client_secret in body)
 * Content-Type: application/x-www-form-urlencoded
 * Returns expires_in: Yes
 */

import type { ExchangeContext, ProviderAdapter, ProviderRequest } from '../types.js';

const THIRTY_MINUTES_SECONDS = 30 * 60;

export const hubspotAdapter: ProviderAdapter = {
  name: 'hubspot',
  tokenUrl: 'https://api.hubapi.com/oauth/v3/token',
  defaultExpiresIn: THIRTY_MINUTES_SECONDS,

  buildRequest(ctx: ExchangeContext): ProviderRequest {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
      code: ctx.code,
      redirect_uri: ctx.redirectUri,
    });

    return {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    };
  },
};
