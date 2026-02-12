import { AuthContext } from '../types/auth.types.js';
import { Permissions } from '../mcp/types/mcp.js';
import { UserStatus } from '../types/enums.js';
import jwt from 'jsonwebtoken';
import { UserRepository } from '../repositories/UserRepository.js';
import { prisma } from '../config/prisma.js';
import { createLogger } from '../logger/index.js';

interface OAuthTokenPayload {
  type: string;
  client_id: string;
  user_id: string;
  scopes: string[];
  iat: number;
  exp: number;
}

export class OAuthTokenValidator {
  private userRepository = UserRepository;
  
  // Logger for OAuthTokenValidator
  private logger = createLogger('OAuthTokenValidator');

  /**
   * Validate OAuth access token
   */
  async validateToken(token: string): Promise<{
    valid: boolean;
    authContext?: AuthContext;
    error?: string;
  }> {
    try {
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        this.logger.error('JWT_SECRET environment variable is not configured');
        return { valid: false, error: 'OAuth token validation is not configured on server' };
      }

      // Validate JWT format and signature
      const decoded = jwt.verify(
        token,
        jwtSecret
      ) as OAuthTokenPayload;

      // Validate token type
      if (decoded.type !== 'access_token') {
        return { valid: false, error: 'Invalid token type' };
      }

      // Check expiration time
      if (decoded.exp && Date.now() / 1000 > decoded.exp) {
        return { valid: false, error: 'Token has expired' };
      }

      const validationResult = await this.validate(token);
      if (!validationResult) {
        return { valid: false, error: 'Token has been revoked' };
      }

      // Query user information
      const user = await this.userRepository.findByUserId(decoded.user_id);
      if (!user) {
        return { valid: false, error: 'User not found' };
      }

      // Check user status
      if (user.status !== UserStatus.Enabled) {
        return { valid: false, error: 'User is not active' };
      }

      // Check if user has expired
      if (user.expiresAt && user.expiresAt > 0 && Math.floor(Date.now() / 1000) > user.expiresAt) {
        return { valid: false, error: 'User has expired' };
      }

      // Build authentication context
      const parsedPermissions = JSON.parse(user.permissions);
      const userPreferences = JSON.parse(user.userPreferences || '{}');

      const authContext: AuthContext = {
        userId: user.userId,
        token: token.substring(0, 8) + '...' + token.substring(token.length - 8),
        role: user.role,
        status: user.status,
        permissions: parsedPermissions as Permissions,
        userPreferences: userPreferences as Permissions,
        launchConfigs: user.launchConfigs,
        authenticatedAt: new Date(),
        expiresAt: user.expiresAt && user.expiresAt > 0 ? user.expiresAt : null,
        rateLimit: user.ratelimit,
        // OAuth-specific fields
        oauthClientId: decoded.client_id,
        oauthScopes: decoded.scopes,
      };

      return { valid: true, authContext };
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        return { valid: false, error: 'Invalid token signature' };
      } else if (error instanceof jwt.TokenExpiredError) {
        return { valid: false, error: 'Token has expired' };
      } else {
        this.logger.error({ error }, 'OAuth token validation error');
        return {
          valid: false,
          error: error instanceof Error ? error.message : 'Token validation failed'
        };
      }
    }
  }

  /**
   * Validate if token is valid (check if token is revoked in database)
   */
  private async validate(token: string): Promise<boolean> {
    try {
      // Find access token
      const tokenRecord = await prisma.oAuthToken.findUnique({
        where: { accessToken: token },
      });

      // If no record in database, token is invalid (all OAuth tokens are stored in database when issued)
      if (!tokenRecord) {
        return false;
      }

      // Check if token is revoked
      if (tokenRecord.revoked) {
        return false;
      }

      // Check if access token has expired
      if (tokenRecord.accessTokenExpiresAt < new Date()) {
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error({ error }, 'OAuth token database validation failed');
      return false;
    }
  }

  /**
   * Check OAuth scope permissions
   */
  hasScope(authContext: AuthContext, requiredScope: string): boolean {
    if (!authContext.oauthScopes) {
      return false;
    }
    return authContext.oauthScopes.includes(requiredScope);
  }

  /**
   * Check multiple scope permissions (any one satisfies)
   */
  hasAnyScope(authContext: AuthContext, requiredScopes: string[]): boolean {
    if (!authContext.oauthScopes) {
      return false;
    }
    return requiredScopes.some(scope => authContext.oauthScopes!.includes(scope));
  }

  /**
   * Check multiple scope permissions (all must satisfy)
   */
  hasAllScopes(authContext: AuthContext, requiredScopes: string[]): boolean {
    if (!authContext.oauthScopes) {
      return false;
    }
    return requiredScopes.every(scope => authContext.oauthScopes!.includes(scope));
  }
}
