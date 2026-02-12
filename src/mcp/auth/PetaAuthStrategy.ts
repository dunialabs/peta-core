import { IAuthStrategy, TokenInfo } from './IAuthStrategy.js';
import { createLogger } from '../../logger/index.js';
import { Server } from '@prisma/client';
import { CryptoService } from '../../security/CryptoService.js';
import { AuthUtils } from '../../utils/AuthUtils.js';
import { PETA_AUTH_CONFIG } from '../../config/petaAuthConfig.js';

interface PetaOAuthConfig {
  userToken: string;
  server: Server;
  clientId: string;
  key: string;
  accessToken?: string;
  expiresAt?: number;
}

const logger = createLogger('PetaAuthStrategy');

export class PetaAuthStrategy implements IAuthStrategy {
  constructor(private config: PetaOAuthConfig) {
    this.validateConfig();
  }

  private validateConfig(): void {
    if (!this.config.userToken || this.config.userToken.trim() === '') {
      throw new Error('Peta OAuth: userToken is required');
    }
    if (!this.config.clientId) {
      throw new Error('Peta OAuth: clientId is required');
    }
    if (!this.config.key) {
      throw new Error('Peta OAuth: key is required');
    }

    if (this.config.expiresAt !== undefined) {
      this.config.expiresAt = this.normalizeExpiresAt(this.config.expiresAt);
    }
  }

  private normalizeExpiresAt(expiresAt: number): number {
    // Treat values that look like seconds as seconds.
    return expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt;
  }

  private isCachedTokenValid(): boolean {
    if (!this.config.accessToken || !this.config.expiresAt) {
      return false;
    }

    const now = Date.now();
    const EXPIRY_BUFFER = 5 * 60 * 1000;
    return now < this.config.expiresAt - EXPIRY_BUFFER;
  }

  async getInitialToken(): Promise<TokenInfo> {
    return await this.refreshToken();
  }

  async refreshToken(): Promise<TokenInfo> {
    if (this.isCachedTokenValid()) {
      const expiresIn = Math.floor((this.config.expiresAt! - Date.now()) / 1000);
      logger.info({
        serverId: this.config.server.serverId,
        expiresIn
      }, 'Using cached Peta OAuth token');

      return {
        accessToken: this.config.accessToken!,
        expiresIn,
        expiresAt: this.config.expiresAt!
      };
    }

    const tokenInfo = await this.refreshTokenFromPeta();
    this.config.accessToken = tokenInfo.accessToken;
    this.config.expiresAt = tokenInfo.expiresAt;
    return tokenInfo;
  }

  private async refreshTokenFromPeta(): Promise<TokenInfo> {
    const provider = AuthUtils.getOAuthProvider(this.config.server.authType);
    if (!provider) {
      throw new Error('Invalid OAuth provider');
    }

    const requestBody: {
      clientId: string;
      provider: string;
      key: string;
      tokenUrl?: string;
    } = {
      clientId: this.config.clientId,
      provider: provider,
      key: this.config.key
    };

    if (provider === 'zendesk' || provider === 'canvas') {
      const tokenUrl = this.getTokenUrlFromConfigTemplate();
      if (tokenUrl) {
        requestBody.tokenUrl = tokenUrl;
      } else {
        logger.warn({
          serverId: this.config.server.serverId,
          provider
        }, 'Missing tokenUrl for dynamic OAuth provider');
      }
    }

    try {
      const response = await fetch(`${PETA_AUTH_CONFIG.BASE_URL}/v1/oauth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const result = await response.json();
      if (!response.ok || !result?.accessToken || !result?.expiresAt) {
        logger.warn({
          status: response.status,
          provider,
          serverId: this.config.server.serverId
        }, 'Peta OAuth refresh failed');
        throw new Error('Failed to refresh OAuth token');
      }

      const expiresAt = result.expiresAt;
      const expiresIn = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));

      logger.info({
        serverId: this.config.server.serverId,
        provider,
        expiresAt: new Date(expiresAt).toISOString()
      }, 'Peta OAuth refresh succeeded');

      return {
        accessToken: result.accessToken,
        expiresIn,
        expiresAt
      };
    } catch (error: any) {
      logger.error({ error: error?.message || error }, 'Peta OAuth refresh request failed');
      throw new Error('Failed to refresh OAuth token');
    }
  }

  private getTokenUrlFromConfigTemplate(): string | undefined {
    const configTemplate = this.config.server.configTemplate;
    if (!configTemplate) {
      return undefined;
    }

    try {
      const templateValue = JSON.parse(configTemplate);
      const tokenUrl = templateValue?.oAuthConfig?.tokenUrl;
      return typeof tokenUrl === 'string' && tokenUrl.trim() !== '' ? tokenUrl : undefined;
    } catch (error: any) {
      logger.warn({ error: error?.message || error }, 'Invalid configTemplate JSON');
      return undefined;
    }
  }

  cleanup(): void {
    // No cleanup needed for Peta OAuth
  }
}
