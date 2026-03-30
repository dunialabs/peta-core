/**
 * Pipedrive OAuth Provider Adapter
 *
 * Token URL: https://oauth.pipedrive.com/oauth/token
 * Auth Method: HTTP Basic Auth (client_id:client_secret)
 * Content-Type: application/x-www-form-urlencoded
 * Returns expires_in and api_domain: Yes
 */

import type { ExchangeContext, ProviderAdapter, ProviderRequest } from '../types.js';

export const pipedriveAdapter: ProviderAdapter = {
  name: 'pipedrive',
  tokenUrl: 'https://oauth.pipedrive.com/oauth/token',

  buildRequest(ctx: ExchangeContext): ProviderRequest {
    const credentials = Buffer.from(`${ctx.clientId}:${ctx.clientSecret}`).toString('base64');
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: ctx.code,
      redirect_uri: ctx.redirectUri,
    });

    return {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body: params,
    };
  },
};
