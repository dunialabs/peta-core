/**
 * OAuth Authorization Code Exchange Types
 *
 * Used for exchanging authorization_code → access_token + refresh_token
 * during first-time OAuth setup with external providers.
 */

/**
 * Input context for authorization code exchange
 */
export interface ExchangeContext {
  /** Provider identifier (e.g., 'google', 'notion', 'github') */
  provider: string;
  /**
   * Provider's token endpoint URL (optional)
   * - For providers with fixed URLs (Google, Notion, etc.), this can be omitted
   * - For providers with dynamic URLs (Zendesk, Canvas), this is required
   * - If provided, takes highest priority over adapter's URL
   */
  tokenUrl?: string;
  /** OAuth client ID */
  clientId: string;
  /** OAuth client secret */
  clientSecret: string;
  /** Authorization code received from OAuth callback */
  code: string;
  /** Redirect URI used in the authorization request */
  redirectUri: string;
  /** Optional code verifier for PKCE flow */
  codeVerifier?: string;
}

/**
 * Result of a successful authorization code exchange
 */
export interface ExchangeResult {
  /** The access token for API requests */
  accessToken: string;
  /** Optional refresh token for token renewal */
  refreshToken?: string;
  /** Token lifetime in seconds (from response) */
  expiresIn?: number;
  /** Calculated expiration timestamp (Unix ms) */
  expiresAt?: number;
  /** Raw response from the provider */
  raw: Record<string, unknown>;
}

/**
 * HTTP request structure for token exchange
 */
export interface ProviderRequest {
  /** Request headers */
  headers: Record<string, string>;
  /** Request body (form-urlencoded URLSearchParams object, or JSON/form string) */
  body: string | URLSearchParams;
}

/**
 * HTTP response from oauthHttpPost
 */
export interface HttpResponse {
  /** HTTP status code */
  status: number;
  /** Parsed JSON data */
  data: Record<string, unknown>;
  /** Raw response text */
  raw: string;
  /** Response headers */
  headers: Headers;
}

/**
 * Provider adapter interface
 *
 * Each OAuth provider may have different requirements for:
 * - Authentication method (Basic Auth vs form params)
 * - Content type (form-urlencoded vs JSON)
 * - Token expiration handling
 * - Token endpoint URL (fixed or dynamic)
 */
export interface ProviderAdapter {
  /** Provider name */
  name: string;

  /**
   * Fixed token endpoint URL for this provider
   * Used for providers with static URLs (Google, Notion, Figma, GitHub, Stripe)
   */
  tokenUrl?: string;

  /**
   * Dynamic token URL builder
   * Used for providers with instance-specific URLs (Zendesk, Canvas)
   * Takes precedence over tokenUrl if both are defined
   */
  getTokenUrl?(ctx: ExchangeContext): string;

  /**
   * Build the HTTP request for token exchange
   */
  buildRequest(ctx: ExchangeContext): ProviderRequest;

  /**
   * Optional default expiration in seconds
   * Used when provider doesn't return expires_in
   */
  defaultExpiresIn?: number;
}
