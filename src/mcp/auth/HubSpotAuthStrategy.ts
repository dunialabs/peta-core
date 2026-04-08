import { createLogger } from '../../logger/index.js';
import { IAuthStrategy, TokenInfo } from './IAuthStrategy.js';

interface HubSpotOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

interface HubSpotTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

const logger = createLogger('HubSpotAuthStrategy');

/**
 * HubSpot OAuth authentication strategy.
 *
 * Both authorization code exchange and refresh use the same token endpoint.
 */
export class HubSpotAuthStrategy implements IAuthStrategy {
  private static readonly TOKEN_ENDPOINT = 'https://api.hubapi.com/oauth/v3/token';
  private static readonly DEFAULT_EXPIRES_IN = 30 * 60; // 30 minutes
  private configChanged: boolean = false;

  constructor(private config: HubSpotOAuthConfig) {
    this.validateConfig();
  }

  private validateConfig(): void {
    if (!this.config.clientId) {
      throw new Error('HubSpot OAuth: clientId is required');
    }
    if (!this.config.clientSecret) {
      throw new Error('HubSpot OAuth: clientSecret is required');
    }
    if (!this.config.refreshToken) {
      throw new Error('HubSpot OAuth: refreshToken is required');
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
          expiresInSeconds: expiresIn,
        }, 'Using cached HubSpot token');

        return {
          accessToken: this.config.accessToken,
          expiresIn,
          expiresAt: this.config.expiresAt,
        };
      }
    }

    try {
      const response = await fetch(HubSpotAuthStrategy.TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.config.refreshToken,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `HubSpot OAuth token refresh failed (${response.status}): ${errorText}`
        );
      }

      const data: HubSpotTokenResponse = await response.json();
      if (!data.access_token) {
        throw new Error('HubSpot OAuth token refresh failed: missing access_token');
      }

      const expiresIn = typeof data.expires_in === 'number'
        ? data.expires_in
        : HubSpotAuthStrategy.DEFAULT_EXPIRES_IN;
      const expiresAt = Date.now() + expiresIn * 1000;

      this.config.accessToken = data.access_token;
      this.config.expiresAt = expiresAt;

      if (data.refresh_token) {
        this.config.refreshToken = data.refresh_token;
      }

      this.configChanged = true;

      logger.info({
        expiresInSeconds: expiresIn,
        refreshTokenRotated: !!data.refresh_token,
      }, 'HubSpot token refreshed');

      return {
        accessToken: data.access_token,
        expiresIn,
        expiresAt,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`HubSpot OAuth token refresh error: ${error.message}`);
      }
      throw new Error('HubSpot OAuth token refresh error: Unknown error');
    }
  }

  getCurrentOAuthConfig(): HubSpotOAuthConfig | undefined {
    if (!this.configChanged) {
      return undefined;
    }

    return {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      refreshToken: this.config.refreshToken,
      accessToken: this.config.accessToken,
      expiresAt: this.config.expiresAt,
    };
  }

  markConfigAsPersisted(): void {
    this.configChanged = false;
  }

  cleanup(): void {
    // No cleanup needed for HubSpot OAuth
  }
}
