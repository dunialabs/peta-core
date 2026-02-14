import { IAuthStrategy, TokenInfo } from './IAuthStrategy.js';
import { createLogger } from '../../logger/index.js';

/**
 * Canva OAuth configuration
 */
interface CanvaOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  scope?: string;
}

/**
 * Canva token API response
 */
interface CanvaTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

const logger = createLogger('CanvaAuthStrategy');

/**
 * Canva OAuth authentication strategy
 *
 * Uses refresh token rotation at:
 * POST https://api.canva.com/rest/v1/oauth/token
 */
export class CanvaAuthStrategy implements IAuthStrategy {
  private static readonly TOKEN_ENDPOINT = 'https://api.canva.com/rest/v1/oauth/token';
  private static readonly DEFAULT_EXPIRES_IN = 4 * 60 * 60; // 4 hours
  private configChanged: boolean = false;

  constructor(private config: CanvaOAuthConfig) {
    this.validateConfig();
  }

  private validateConfig(): void {
    if (!this.config.clientId) {
      throw new Error('Canva OAuth: clientId is required');
    }
    if (!this.config.clientSecret) {
      throw new Error('Canva OAuth: clientSecret is required');
    }
    if (!this.config.refreshToken) {
      throw new Error('Canva OAuth: refreshToken is required');
    }
  }

  async getInitialToken(): Promise<TokenInfo> {
    return await this.refreshToken();
  }

  async refreshToken(): Promise<TokenInfo> {
    if (this.config.accessToken && this.config.expiresAt) {
      const now = Date.now();
      const EXPIRY_BUFFER = 5 * 60 * 1000;
      if (now < this.config.expiresAt - EXPIRY_BUFFER) {
        const expiresIn = Math.floor((this.config.expiresAt - now) / 1000);

        logger.debug({
          clientIdPrefix: this.config.clientId.substring(0, 8),
          expiresInSeconds: expiresIn
        }, 'Using cached Canva token');

        return {
          accessToken: this.config.accessToken,
          expiresIn,
          expiresAt: this.config.expiresAt,
        };
      }
    }

    try {
      const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.config.refreshToken,
      });

      if (this.config.scope) {
        body.set('scope', this.config.scope);
      }

      const response = await fetch(CanvaAuthStrategy.TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Canva OAuth token refresh failed (${response.status}): ${errorText}`);
      }

      const data: CanvaTokenResponse = await response.json();
      if (!data.access_token) {
        throw new Error('Canva OAuth token refresh failed: missing access_token');
      }
      if (!data.refresh_token) {
        throw new Error('Canva OAuth token refresh failed: missing refresh_token');
      }

      const expiresIn = typeof data.expires_in === 'number'
        ? data.expires_in
        : CanvaAuthStrategy.DEFAULT_EXPIRES_IN;
      const expiresAt = Date.now() + expiresIn * 1000;

      this.config.accessToken = data.access_token;
      this.config.refreshToken = data.refresh_token;
      this.config.expiresAt = expiresAt;
      this.configChanged = true;

      logger.info({
        expiresInSeconds: expiresIn
      }, 'Canva token refreshed');

      return {
        accessToken: data.access_token,
        expiresIn,
        expiresAt,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Canva OAuth token refresh error: ${error.message}`);
      }
      throw new Error('Canva OAuth token refresh error: Unknown error');
    }
  }

  getCurrentOAuthConfig(): CanvaOAuthConfig | undefined {
    if (!this.configChanged) {
      return undefined;
    }

    return {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      refreshToken: this.config.refreshToken,
      accessToken: this.config.accessToken,
      expiresAt: this.config.expiresAt,
      scope: this.config.scope,
    };
  }

  markConfigAsPersisted(): void {
    this.configChanged = false;
  }

  cleanup(): void {
    // No cleanup needed for Canva OAuth
  }
}
