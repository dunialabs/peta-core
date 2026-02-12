import { IAuthStrategy, TokenInfo } from './IAuthStrategy.js';

/**
 * Google OAuth configuration
 */
interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

/**
 * Google Token API response
 */
interface GoogleTokenResponse {
  access_token: string;
  expires_in: number; // seconds
  scope: string;
  token_type: string;
}

/**
 * Google OAuth authentication strategy
 *
 * Implements Google OAuth 2.0 token acquisition and refresh logic
 */
export class GoogleAuthStrategy implements IAuthStrategy {
  private static readonly TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

  constructor(private config: GoogleOAuthConfig) {
    this.validateConfig();
  }

  /**
   * Validate configuration completeness
   */
  private validateConfig(): void {
    if (!this.config.clientId) {
      throw new Error('Google OAuth: clientId is required');
    }
    if (!this.config.clientSecret) {
      throw new Error('Google OAuth: clientSecret is required');
    }
    if (!this.config.refreshToken) {
      throw new Error('Google OAuth: refreshToken is required');
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
        // 3. Not expired, return cached token directly
        const expiresIn = Math.floor((this.config.expiresAt - now) / 1000);

        console.log(`[GoogleAuthStrategy] Using cached token for ${this.config.clientId?.substring(0, 8)}..., expires in ${Math.floor(expiresIn / 3600)} hours`);

        return {
          accessToken: this.config.accessToken,
          expiresIn: expiresIn,
          expiresAt: this.config.expiresAt,
        };
      }

      console.log(`[GoogleAuthStrategy] Cached token expired or expiring soon, refreshing...`);
    }
    try {
      const response = await fetch(GoogleAuthStrategy.TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.config.refreshToken,
          grant_type: 'refresh_token',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Google OAuth token refresh failed (${response.status}): ${errorText}`
        );
      }

      const data: GoogleTokenResponse = await response.json();

      // Calculate absolute expiration time
      const expiresAt = Date.now() + data.expires_in * 1000;

      return {
        accessToken: data.access_token,
        expiresIn: data.expires_in,
        expiresAt: expiresAt,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Google OAuth token refresh error: ${error.message}`);
      }
      throw new Error('Google OAuth token refresh error: Unknown error');
    }
  }

  /**
   * Cleanup resources (Google OAuth doesn't require special cleanup)
   */
  cleanup(): void {
    // No cleanup needed for Google OAuth
  }
}
