/**
 * Stripe OAuth Provider Adapter
 *
 * Token URL: https://api.stripe.com/v1/oauth/token
 * Auth Method: Basic Auth (secret key as username, empty password)
 * Content-Type: application/x-www-form-urlencoded
 * Returns expires_in: Yes (typically 1 hour / 3600 seconds)
 *
 * Note: Stripe uses the platform's secret API key for Basic Auth authentication,
 * not traditional client_id/client_secret. The clientSecret parameter should
 * contain the platform's Stripe secret key (sk_live_xxx or sk_test_xxx).
 */

import type { ExchangeContext, ProviderAdapter, ProviderRequest } from '../types.js';

export const stripeAdapter: ProviderAdapter = {
  name: 'stripe',
  tokenUrl: 'https://api.stripe.com/v1/oauth/token',

  buildRequest(ctx: ExchangeContext): ProviderRequest {
    // Stripe uses the secret key as Basic Auth username with empty password
    const credentials = Buffer.from(`${ctx.clientSecret}:`).toString('base64');

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: ctx.code,
    });

    return {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body: params,
    };
  },
};
