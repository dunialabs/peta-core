import { createLogger } from '../../logger/index.js';
import { IAuthStrategy, TokenInfo } from './IAuthStrategy.js';
import {
  fetchIntercomTokenMetadata,
  INTERCOM_SYNTHETIC_EXPIRES_IN,
} from './IntercomTokenHelper.js';

interface IntercomOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  intercomRegion?: string;
}

const logger = createLogger('IntercomAuthStrategy');

export class IntercomAuthStrategy implements IAuthStrategy {
  private configChanged: boolean = false;

  constructor(private config: IntercomOAuthConfig) {
    this.validateConfig();
  }

  private validateConfig(): void {
    if (!this.config.clientId) {
      throw new Error('Intercom OAuth: clientId is required');
    }
    if (!this.config.clientSecret) {
      throw new Error('Intercom OAuth: clientSecret is required');
    }
    if (!this.config.accessToken) {
      throw new Error('Intercom OAuth: accessToken is required');
    }
  }

  async getInitialToken(): Promise<TokenInfo> {
    return await this.refreshToken();
  }

  async refreshToken(): Promise<TokenInfo> {
    // 1. Check if there is cached accessToken and expiresAt
    if (this.config.accessToken && this.config.expiresAt) {
      const now = Date.now();

      // 2. Determine if expired (consider expired 5 minutes early to avoid edge cases)
      const EXPIRY_BUFFER = 5 * 60 * 1000; // 5 minutes
      if (now < this.config.expiresAt - EXPIRY_BUFFER) {
        // 3. Not expired, return cached token directly
        const expiresIn = Math.floor((this.config.expiresAt - now) / 1000);

        console.log(`[IntercomAuthStrategy] Using cached token for ${this.config.clientId?.substring(0, 8)}..., expires in ${Math.floor(expiresIn / 3600)} hours`);

        return {
          accessToken: this.config.accessToken,
          expiresIn: expiresIn,
          expiresAt: this.config.expiresAt,
        };
      }

      console.log(`[IntercomAuthStrategy] Cached token expired or expiring soon, refreshing...`);
    }

    const metadata = await fetchIntercomTokenMetadata(this.config.accessToken!);
    const expiresAt = Date.now() + INTERCOM_SYNTHETIC_EXPIRES_IN * 1000;

    this.config.expiresAt = expiresAt;
    this.config.intercomRegion = metadata.intercomRegion;
    this.configChanged = true;

    logger.info(
      {
        intercomRegion: metadata.intercomRegion,
        expiresInSeconds: INTERCOM_SYNTHETIC_EXPIRES_IN,
      },
      'Intercom token validated',
    );

    return {
      accessToken: this.config.accessToken!,
      expiresIn: INTERCOM_SYNTHETIC_EXPIRES_IN,
      expiresAt,
    };
  }

  getCurrentOAuthConfig(): IntercomOAuthConfig | undefined {
    if (!this.configChanged) {
      return undefined;
    }

    return {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      refreshToken: this.config.refreshToken,
      accessToken: this.config.accessToken,
      expiresAt: this.config.expiresAt,
      intercomRegion: this.config.intercomRegion,
    };
  }

  markConfigAsPersisted(): void {
    this.configChanged = false;
  }

  cleanup(): void {
    // No cleanup needed for Intercom OAuth
  }
}
