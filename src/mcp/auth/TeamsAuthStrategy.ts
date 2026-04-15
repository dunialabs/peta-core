import { createLogger } from '../../logger/index.js';
import { IAuthStrategy, TokenInfo } from './IAuthStrategy.js';

interface TeamsOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

interface TeamsTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

const logger = createLogger('TeamsAuthStrategy');

export class TeamsAuthStrategy implements IAuthStrategy {
  private static readonly TOKEN_ENDPOINT =
    'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  private static readonly DEFAULT_EXPIRES_IN = 60 * 60; // 1 hour
  private configChanged: boolean = false;

  constructor(private config: TeamsOAuthConfig) {
    this.validateConfig();
  }

  private validateConfig(): void {
    if (!this.config.clientId) {
      throw new Error('Teams OAuth: clientId is required');
    }
    if (!this.config.clientSecret) {
      throw new Error('Teams OAuth: clientSecret is required');
    }
    if (!this.config.refreshToken) {
      throw new Error('Teams OAuth: refreshToken is required');
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

        logger.debug(
          {
            clientIdPrefix: this.config.clientId.substring(0, 8),
            expiresInSeconds: expiresIn,
          },
          'Using cached Teams token',
        );

        return {
          accessToken: this.config.accessToken,
          expiresIn,
          expiresAt: this.config.expiresAt,
        };
      }
    }

    try {
      const response = await fetch(TeamsAuthStrategy.TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
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
        throw new Error(`Teams OAuth token refresh failed (${response.status}): ${errorText}`);
      }

      const data: TeamsTokenResponse = await response.json();
      if (!data.access_token) {
        throw new Error('Teams OAuth token refresh failed: missing access_token');
      }

      const expiresIn =
        typeof data.expires_in === 'number'
          ? data.expires_in
          : TeamsAuthStrategy.DEFAULT_EXPIRES_IN;
      const expiresAt = Date.now() + expiresIn * 1000;

      this.config.accessToken = data.access_token;
      this.config.expiresAt = expiresAt;

      if (data.refresh_token) {
        this.config.refreshToken = data.refresh_token;
      }

      this.configChanged = true;

      logger.info(
        {
          expiresInSeconds: expiresIn,
          refreshTokenRotated: !!data.refresh_token,
        },
        'Teams token refreshed',
      );

      return {
        accessToken: data.access_token,
        expiresIn,
        expiresAt,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Teams OAuth token refresh error: ${error.message}`);
      }
      throw new Error('Teams OAuth token refresh error: Unknown error');
    }
  }

  getCurrentOAuthConfig(): TeamsOAuthConfig | undefined {
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
    // No cleanup needed for Teams OAuth
  }
}
