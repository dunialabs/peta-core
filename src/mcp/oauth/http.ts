/**
 * OAuth HTTP Utility
 *
 * Simple HTTP POST function for OAuth token exchange requests.
 */

import type { HttpResponse, ProviderRequest } from './types.js';
import { OAuthExchangeError } from './errors.js';

/**
 * Perform an HTTP POST request for OAuth token exchange
 *
 * @param url - Token endpoint URL
 * @param request - Request headers and body
 * @param provider - Provider name (for error messages)
 * @returns Parsed HTTP response
 * @throws OAuthExchangeError on HTTP or parse errors
 */
export async function oauthHttpPost(
  url: string,
  request: ProviderRequest,
  provider: string
): Promise<HttpResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown fetch error';
    throw new OAuthExchangeError(
      `OAuth token exchange failed for ${provider}: ${message}`,
      {
        type: 'http',
        provider,
        cause: error instanceof Error ? error : undefined,
      }
    );
  }

  const raw = await response.text();

  let data: Record<string, unknown> = {};
  if (raw) {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      throw OAuthExchangeError.parse(
        provider,
        raw,
        error instanceof Error ? error : undefined
      );
    }
  }

  if (!response.ok) {
    throw OAuthExchangeError.http(provider, response.status, raw);
  }
  if (data.error) {
    throw OAuthExchangeError.parse(
      provider,
      raw,
      new Error(String(data.error))
    );
  }

  return {
    status: response.status,
    data,
    raw,
    headers: response.headers,
  };
}
