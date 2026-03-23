import { createLogger } from '../../logger/index.js';
import { IAuthStrategy, TokenInfo } from './IAuthStrategy.js';

interface PipedriveOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  apiDomain?: string;
}

interface PipedriveTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  api_domain?: string;
  token_type?: string;
  scope?: string;
}

const logger = createLogger('PipedriveAuthStrategy');

/**
 * Pipedrive OAuth authentication strategy.
 *
 * Both authorization code exchange and refresh use the same token endpoint.
 */
export class PipedriveAuthStrategy implements IAuthStrategy {
  private static readonly TOKEN_ENDPOINT = 'https://oauth.pipedrive.com/oauth/token';
  private static readonly DEFAULT_EXPIRES_IN = 60 * 60; // 1 hour
  private configChanged: boolean = false;

  constructor(private config: PipedriveOAuthConfig) {
    this.validateConfig();
  }

  private validateConfig(): void {
    if (!this.config.clientId) {
      throw new Error('Pipedrive OAuth: clientId is required');
    }
    if (!this.config.clientSecret) {
      throw new Error('Pipedrive OAuth: clientSecret is required');
    }
    if (!this.config.refreshToken) {
      throw new Error('Pipedrive OAuth: refreshToken is required');
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
        }, 'Using cached Pipedrive token');

        return {
          accessToken: this.config.accessToken,
          expiresIn,
          expiresAt: this.config.expiresAt,
        };
      }
    }

    try {
      const credentials = Buffer.from(
        `${this.config.clientId}:${this.config.clientSecret}`
      ).toString('base64');
      const response = await fetch(PipedriveAuthStrategy.TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.config.refreshToken,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Pipedrive OAuth token refresh failed (${response.status}): ${errorText}`
        );
      }

      const data: PipedriveTokenResponse = await response.json();
      if (!data.access_token) {
        throw new Error('Pipedrive OAuth token refresh failed: missing access_token');
      }

      const expiresIn = typeof data.expires_in === 'number'
        ? data.expires_in
        : PipedriveAuthStrategy.DEFAULT_EXPIRES_IN;
      const expiresAt = Date.now() + expiresIn * 1000;
      const apiDomain =
        typeof data.api_domain === 'string' && data.api_domain.trim() !== ''
          ? data.api_domain
          : this.config.apiDomain;

      this.config.accessToken = data.access_token;
      this.config.expiresAt = expiresAt;
      this.config.apiDomain = apiDomain;

      if (data.refresh_token) {
        this.config.refreshToken = data.refresh_token;
      }

      this.configChanged = true;

      logger.info({
        expiresInSeconds: expiresIn,
        hasApiDomain: !!apiDomain,
        refreshTokenRotated: !!data.refresh_token,
      }, 'Pipedrive token refreshed');

      return {
        accessToken: data.access_token,
        expiresIn,
        expiresAt,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Pipedrive OAuth token refresh error: ${error.message}`);
      }
      throw new Error('Pipedrive OAuth token refresh error: Unknown error');
    }
  }

  getCurrentOAuthConfig(): PipedriveOAuthConfig | undefined {
    if (!this.configChanged) {
      return undefined;
    }

    return {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      refreshToken: this.config.refreshToken,
      accessToken: this.config.accessToken,
      expiresAt: this.config.expiresAt,
      apiDomain: this.config.apiDomain,
    };
  }

  markConfigAsPersisted(): void {
    this.configChanged = false;
  }

  cleanup(): void {
    // No cleanup needed for Pipedrive OAuth
  }
}
