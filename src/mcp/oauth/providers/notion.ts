/**
 * Notion OAuth Provider Adapter
 *
 * Token URL: https://api.notion.com/v1/oauth/token
 * Auth Method: Basic Auth (client_id:client_secret)
 * Content-Type: application/json
 * Returns expires_in: No (tokens don't expire, but can be revoked)
 * Default expiry: 30 days (2592000 seconds)
 */

import type { ExchangeContext, ProviderAdapter, ProviderRequest } from '../types.js';

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60; // 2592000

export const notionAdapter: ProviderAdapter = {
  name: 'notion',
  tokenUrl: 'https://api.notion.com/v1/oauth/token',
  defaultExpiresIn: THIRTY_DAYS_SECONDS,

  buildRequest(ctx: ExchangeContext): ProviderRequest {
    const credentials = Buffer.from(`${ctx.clientId}:${ctx.clientSecret}`).toString('base64');

    const body = {
      grant_type: 'authorization_code',
      code: ctx.code,
      redirect_uri: ctx.redirectUri,
    };

    return {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(body),
    };
  },
};
