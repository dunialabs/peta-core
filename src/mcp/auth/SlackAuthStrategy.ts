import { createLogger } from '../../logger/index.js';
import { IAuthStrategy, TokenInfo } from './IAuthStrategy.js';

interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  tokenMode?: 'user' | 'bot' | 'auto';
}

interface SlackTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  authed_user?: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
}

const logger = createLogger('SlackAuthStrategy');

export class SlackAuthStrategy implements IAuthStrategy {
  private static readonly TOKEN_ENDPOINT = 'https://slack.com/api/oauth.v2.access';
  private static readonly DEFAULT_EXPIRES_IN = 12 * 60 * 60;
  private configChanged: boolean = false;

  constructor(private config: SlackOAuthConfig) {
    this.validateConfig();
  }

  private validateConfig(): void {
    if (!this.config.clientId) {
      throw new Error('Slack OAuth: clientId is required');
    }
    if (!this.config.clientSecret) {
      throw new Error('Slack OAuth: clientSecret is required');
    }
    if (!this.config.refreshToken) {
      throw new Error('Slack OAuth: refreshToken is required');
    }
  }

  private normalizeResponse(data: SlackTokenResponse): {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  } {
    const authedUser =
      data.authed_user && typeof data.authed_user === 'object'
        ? data.authed_user
        : undefined;

    const resolvedMode =
      this.config.tokenMode === 'auto'
        ? authedUser?.access_token
          ? 'user'
          : 'bot'
        : this.config.tokenMode ?? 'user';

    const tokenPayload = resolvedMode === 'user' ? authedUser : data;
    const accessToken = tokenPayload?.access_token;

    if (!accessToken) {
      const missingPath =
        resolvedMode === 'user' ? 'authed_user.access_token' : 'access_token';
      throw new Error(
        `Slack OAuth token refresh failed: missing ${missingPath} for tokenMode='${resolvedMode}'`
      );
    }

    return {
      accessToken,
      refreshToken: tokenPayload.refresh_token,
      expiresIn: tokenPayload.expires_in,
    };
  }

  async getInitialToken(): Promise<TokenInfo> {
    return await this.refreshToken();
  }

  async refreshToken(): Promise<TokenInfo> {
    if (this.config.accessToken && this.config.expiresAt) {
      const now = Date.now();
      const expiryBuffer = 5 * 60 * 1000;

      if (now < this.config.expiresAt - expiryBuffer) {
        return {
          accessToken: this.config.accessToken,
          expiresIn: Math.floor((this.config.expiresAt - now) / 1000),
          expiresAt: this.config.expiresAt,
        };
      }
    }

    try {
      const response = await fetch(SlackAuthStrategy.TOKEN_ENDPOINT, {
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
        throw new Error(`Slack OAuth token refresh failed (${response.status}): ${errorText}`);
      }

      const data: SlackTokenResponse = await response.json();
      const normalized = this.normalizeResponse(data);
      const expiresIn = normalized.expiresIn ?? SlackAuthStrategy.DEFAULT_EXPIRES_IN;
      const expiresAt = Date.now() + expiresIn * 1000;

      this.config.accessToken = normalized.accessToken;
      this.config.expiresAt = expiresAt;
      this.config.tokenMode = this.config.tokenMode ?? 'user';

      if (normalized.refreshToken) {
        this.config.refreshToken = normalized.refreshToken;
      }

      this.configChanged = true;

      logger.info(
        {
          expiresInSeconds: expiresIn,
          refreshTokenRotated: !!normalized.refreshToken,
          tokenMode: this.config.tokenMode,
        },
        'Slack token refreshed'
      );

      return {
        accessToken: normalized.accessToken,
        expiresIn,
        expiresAt,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Slack OAuth token refresh error: ${error.message}`);
      }
      throw new Error('Slack OAuth token refresh error: Unknown error');
    }
  }

  getCurrentOAuthConfig(): SlackOAuthConfig | undefined {
    if (!this.configChanged) {
      return undefined;
    }

    return {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      refreshToken: this.config.refreshToken,
      accessToken: this.config.accessToken,
      expiresAt: this.config.expiresAt,
      tokenMode: this.config.tokenMode ?? 'user',
    };
  }

  markConfigAsPersisted(): void {
    this.configChanged = false;
  }

  cleanup(): void {
    // No cleanup needed for Slack OAuth
  }
}
