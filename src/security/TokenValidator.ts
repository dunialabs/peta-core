import { UserRepository } from '../repositories/UserRepository.js';
import { AuthContext, AuthError, AuthErrorType, isValidPermissions } from '../types/auth.types.js';
import { UserStatus } from '../types/enums.js';
import { CryptoService } from './CryptoService.js';
import { Permissions } from '../mcp/types/mcp.js';

export class TokenValidator {

  private userRepository = UserRepository;

  /**
   * Validate token and return authentication context
   * @param token Bearer token from Authorization header
   * @returns Authentication context or throws exception
   */
  async validateToken(token: string): Promise<AuthContext> {
    // 1. Basic format validation
    if (!token || typeof token !== 'string') {
      throw new AuthError(AuthErrorType.INVALID_TOKEN, 'Token is required and must be a string');
    }

    // 3. Calculate user ID
    const userId = await CryptoService.calculateUserId(token);

    // 4. Query user information
    const user = await this.userRepository.findByUserId(userId);
    if (!user) {
      throw new AuthError(
        AuthErrorType.USER_NOT_FOUND, 
        'User not found',
        userId
      );
    }

    // 5. Check user status
    if (user.status !== UserStatus.Enabled) {
      throw new AuthError(
        AuthErrorType.USER_DISABLED,
        `User is ${UserStatus[user.status]}`,
        userId,
        { status: user.status }
      );
    }

    // 6. Check expiration time
    if (user.expiresAt && user.expiresAt > 0 && Math.floor(Date.now() / 1000) > user.expiresAt) {
      throw new AuthError(
        AuthErrorType.USER_EXPIRED,
        'User authorization has expired',
        userId,
        { expiresAt: user.expiresAt }
      );
    }

    // 7. Parse permissions data (with type validation)
    const permissionsRaw = typeof user.permissions === 'string' 
      ? JSON.parse(user.permissions) 
      : user.permissions;
    
    if (!isValidPermissions(permissionsRaw)) {
      throw new AuthError(
        AuthErrorType.INVALID_PERMISSIONS,
        'Invalid permissions data structure in user record',
        userId
      );
    }
    const permissions = permissionsRaw as Permissions;
    const userPreferences = JSON.parse(user.userPreferences) as Permissions;

    // 9. Construct authentication context
    return {
      userId: user.userId,
      token: token.substring(0, 8) + '...' + token.substring(token.length - 8),
      role: user.role,
      status: user.status,
      permissions: permissions,
      userPreferences: userPreferences,
      launchConfigs: user.launchConfigs,
      authenticatedAt: new Date(),
      expiresAt: user.expiresAt && user.expiresAt > 0 ? user.expiresAt : null,
      rateLimit: user.ratelimit
    };
  }
}
