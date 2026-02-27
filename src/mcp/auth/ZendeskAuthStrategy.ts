import { IAuthStrategy, TokenInfo } from './IAuthStrategy.js';
import { createLogger } from '../../logger/index.js';

/**
 * Zendesk OAuth configuration
 */
interface ZendeskOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl: string;
  scope?: string;
  accessToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  expiresInSeconds?: number;
  refreshTokenExpiresInSeconds?: number;
}

/**
 * Zendesk token API response
 */
interface ZendeskTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
}

const logger = createLogger('ZendeskAuthStrategy');

/**
 * Zendesk OAuth authentication strategy
 *
 * Uses dynamic endpoint:
 * POST https://{subdomain}.zendesk.com/oauth/tokens
 */
export class ZendeskAuthStrategy implements IAuthStrategy {
  private static readonly DEFAULT_EXPIRES_IN = 172800; // 2 days
  private static readonly DEFAULT_REFRESH_TOKEN_EXPIRES_IN = 7776000; // 90 days
  private configChanged: boolean = false;

  constructor(private config: ZendeskOAuthConfig) {
    this.validateConfig();
  }

  private validateConfig(): void {
    if (!this.config.clientId) {
      throw new Error('Zendesk OAuth: clientId is required');
    }
    if (!this.config.clientSecret) {
      throw new Error('Zendesk OAuth: clientSecret is required');
    }
    if (!this.config.refreshToken) {
      throw new Error('Zendesk OAuth: refreshToken is required');
    }
    if (!this.config.tokenUrl) {
      throw new Error('Zendesk OAuth: tokenUrl is required');
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
        }, 'Using cached Zendesk token');

        return {
          accessToken: this.config.accessToken,
          expiresIn,
          expiresAt: this.config.expiresAt,
        };
      }
    }

    try {
      const expiresInSeconds = this.config.expiresInSeconds ?? ZendeskAuthStrategy.DEFAULT_EXPIRES_IN;
      const refreshTokenExpiresInSeconds =
        this.config.refreshTokenExpiresInSeconds ?? ZendeskAuthStrategy.DEFAULT_REFRESH_TOKEN_EXPIRES_IN;

      const body: Record<string, string | number> = {
        grant_type: 'refresh_token',
        refresh_token: this.config.refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        expires_in: expiresInSeconds,
        refresh_token_expires_in: refreshTokenExpiresInSeconds,
      };

      if (this.config.scope) {
        body.scope = this.config.scope;
      }

      const response = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Zendesk OAuth token refresh failed (${response.status}): ${errorText}`);
      }

      const data: ZendeskTokenResponse = await response.json();
      if (!data.access_token) {
        throw new Error('Zendesk OAuth token refresh failed: missing access_token');
      }
      if (!data.refresh_token) {
        throw new Error('Zendesk OAuth token refresh failed: missing refresh_token');
      }

      const expiresIn = typeof data.expires_in === 'number'
        ? data.expires_in
        : expiresInSeconds;
      const expiresAt = Date.now() + expiresIn * 1000;

      this.config.accessToken = data.access_token;
      this.config.refreshToken = data.refresh_token;
      this.config.expiresAt = expiresAt;

      if (typeof data.refresh_token_expires_in === 'number') {
        this.config.refreshTokenExpiresAt = Date.now() + data.refresh_token_expires_in * 1000;
      } else {
        this.config.refreshTokenExpiresAt = Date.now() + refreshTokenExpiresInSeconds * 1000;
      }

      this.configChanged = true;

      logger.info({
        expiresInSeconds: expiresIn
      }, 'Zendesk token refreshed');

      return {
        accessToken: data.access_token,
        expiresIn,
        expiresAt,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Zendesk OAuth token refresh error: ${error.message}`);
      }
      throw new Error('Zendesk OAuth token refresh error: Unknown error');
    }
  }

  getCurrentOAuthConfig(): ZendeskOAuthConfig | undefined {
    if (!this.configChanged) {
      return undefined;
    }

    return {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      refreshToken: this.config.refreshToken,
      tokenUrl: this.config.tokenUrl,
      scope: this.config.scope,
      accessToken: this.config.accessToken,
      expiresAt: this.config.expiresAt,
      refreshTokenExpiresAt: this.config.refreshTokenExpiresAt,
      expiresInSeconds: this.config.expiresInSeconds,
      refreshTokenExpiresInSeconds: this.config.refreshTokenExpiresInSeconds,
    };
  }

  markConfigAsPersisted(): void {
    this.configChanged = false;
  }

  cleanup(): void {
    // No cleanup needed for Zendesk OAuth
  }
}
