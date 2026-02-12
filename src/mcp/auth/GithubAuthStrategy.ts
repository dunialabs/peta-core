import { IAuthStrategy, TokenInfo } from './IAuthStrategy.js';
import { createLogger } from '../../logger/index.js';

/**
 * GitHub App OAuth configuration (user access token with refresh token enabled)
 */
interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
}

/**
 * GitHub token API response
 */
interface GithubTokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  expires_in?: number; // seconds
  refresh_token?: string;
  refresh_token_expires_in?: number; // seconds
}

const logger = createLogger('GithubAuthStrategy');

/**
 * GitHub App OAuth authentication strategy
 *
 * Implements refresh token rotation for GitHub App user access tokens.
 */
export class GithubAuthStrategy implements IAuthStrategy {
  private static readonly TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
  private static readonly DEFAULT_EXPIRES_IN = 8 * 60 * 60; // 8 hours

  /**
   * Flag indicating if configuration has unpersisted changes
   */
  private configChanged: boolean = false;

  constructor(private config: GithubOAuthConfig) {
    this.validateConfig();
  }

  /**
   * Validate configuration completeness
   */
  private validateConfig(): void {
    if (!this.config.clientId) {
      throw new Error('GitHub OAuth: clientId is required');
    }
    if (!this.config.clientSecret) {
      throw new Error('GitHub OAuth: clientSecret is required');
    }
    if (!this.config.refreshToken) {
      throw new Error('GitHub OAuth: refreshToken is required');
    }
  }

  /**
   * Get initial token (exchange refresh token for access token)
   */
  async getInitialToken(): Promise<TokenInfo> {
    return await this.refreshToken();
  }

  /**
   * Refresh access token
   */
  async refreshToken(): Promise<TokenInfo> {
    // 1. Check if there is cached accessToken and expiresAt
    if (this.config.accessToken && this.config.expiresAt) {
      const now = Date.now();

      // 2. Determine if expired (consider expired 5 minutes early to avoid edge cases)
      const EXPIRY_BUFFER = 5 * 60 * 1000; // 5 minutes
      if (now < this.config.expiresAt - EXPIRY_BUFFER) {
        const expiresIn = Math.floor((this.config.expiresAt - now) / 1000);

        logger.debug({
          clientIdPrefix: this.config.clientId.substring(0, 8),
          expiresInSeconds: expiresIn
        }, 'Using cached GitHub token');

        return {
          accessToken: this.config.accessToken,
          expiresIn: expiresIn,
          expiresAt: this.config.expiresAt,
        };
      }

      logger.debug({ clientIdPrefix: this.config.clientId.substring(0, 8) }, 'Cached token expired, refreshing');
    }

    try {
      const response = await fetch(GithubAuthStrategy.TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: this.config.refreshToken,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `GitHub OAuth token refresh failed (${response.status}): ${errorText}`
        );
      }

      const data: GithubTokenResponse = await response.json();
      if (!data.access_token) {
        throw new Error('GitHub OAuth token refresh failed: missing access_token');
      }

      const expiresIn = typeof data.expires_in === 'number'
        ? data.expires_in
        : GithubAuthStrategy.DEFAULT_EXPIRES_IN;
      const expiresAt = Date.now() + expiresIn * 1000;

      // Update internal configuration
      this.config.accessToken = data.access_token;
      this.config.expiresAt = expiresAt;

      if (data.refresh_token) {
        this.config.refreshToken = data.refresh_token;
      }

      if (typeof data.refresh_token_expires_in === 'number') {
        this.config.refreshTokenExpiresAt = Date.now() + data.refresh_token_expires_in * 1000;
      }

      this.configChanged = true;

      logger.info({
        expiresInSeconds: expiresIn,
        refreshTokenRotated: !!data.refresh_token
      }, 'GitHub token refreshed');

      return {
        accessToken: data.access_token,
        expiresIn: expiresIn,
        expiresAt: expiresAt,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`GitHub OAuth token refresh error: ${error.message}`);
      }
      throw new Error('GitHub OAuth token refresh error: Unknown error');
    }
  }

  /**
   * Get current complete OAuth configuration
   */
  getCurrentOAuthConfig(): GithubOAuthConfig | undefined {
    if (!this.configChanged) {
      return undefined;
    }

    return {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      refreshToken: this.config.refreshToken,
      accessToken: this.config.accessToken,
      expiresAt: this.config.expiresAt,
      refreshTokenExpiresAt: this.config.refreshTokenExpiresAt,
    };
  }

  /**
   * Mark configuration as persisted
   */
  markConfigAsPersisted(): void {
    this.configChanged = false;
  }

  /**
   * Cleanup resources (GitHub OAuth doesn't require special cleanup)
   */
  cleanup(): void {
    // No cleanup needed for GitHub OAuth
  }
}
