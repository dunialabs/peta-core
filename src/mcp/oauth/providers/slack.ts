/**
 * Slack OAuth Provider Adapter
 *
 * Token URL: https://slack.com/api/oauth.v2.access
 * Auth Method: Form params (client_id/client_secret in body)
 * Content-Type: application/x-www-form-urlencoded
 *
 * Slack may return a bot token at the response root and a user token in
 * authed_user.*. SlackAuth uses user-mode by default.
 */

import { OAuthExchangeError } from '../errors.js';
import type {
  ExchangeContext,
  NormalizedTokenResponse,
  ProviderAdapter,
  ProviderRequest,
} from '../types.js';

const TWELVE_HOURS_SECONDS = 12 * 60 * 60;

function normalizeSlackTokenResponse(
  data: Record<string, unknown>,
  provider: string,
  tokenMode: ExchangeContext['tokenMode']
): NormalizedTokenResponse {
  const authedUser =
    typeof data.authed_user === 'object' && data.authed_user !== null
      ? (data.authed_user as Record<string, unknown>)
      : undefined;

  const resolvedMode =
    tokenMode === 'auto'
      ? authedUser && typeof authedUser.access_token === 'string'
        ? 'user'
        : 'bot'
      : tokenMode ?? 'user';

  const tokenPayload: Record<string, unknown> =
    resolvedMode === 'user' ? authedUser ?? {} : data;
  const accessToken = tokenPayload?.access_token;

  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    const missingPath =
      resolvedMode === 'user' ? 'authed_user.access_token' : 'access_token';
    throw new OAuthExchangeError(
      `Slack OAuth response missing ${missingPath} for tokenMode='${resolvedMode}'`,
      {
        type: 'parse',
        provider,
        responseBody: JSON.stringify(data),
      }
    );
  }

  return {
    accessToken,
    refreshToken:
      typeof tokenPayload.refresh_token === 'string'
        ? tokenPayload.refresh_token
        : undefined,
    expiresIn:
      typeof tokenPayload.expires_in === 'number'
        ? tokenPayload.expires_in
        : undefined,
  };
}

export const slackAdapter: ProviderAdapter = {
  name: 'slack',
  tokenUrl: 'https://slack.com/api/oauth.v2.access',
  defaultExpiresIn: TWELVE_HOURS_SECONDS,

  buildRequest(ctx: ExchangeContext): ProviderRequest {
    const params = new URLSearchParams({
      code: ctx.code,
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
      redirect_uri: ctx.redirectUri,
    });

    return {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    };
  },

  parseResponse(data: Record<string, unknown>, ctx: ExchangeContext): NormalizedTokenResponse {
    return normalizeSlackTokenResponse(data, ctx.provider, ctx.tokenMode);
  },
};
