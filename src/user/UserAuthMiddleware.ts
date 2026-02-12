import { Request, Response, NextFunction } from 'express';
import { TokenValidator } from '../security/TokenValidator.js';
import { UserErrorCode } from './types.js';
import { createLogger } from '../logger/index.js';

/**
 * User interface permission verification middleware
 *
 * Ensures only valid, enabled users can access user interfaces.
 * Unlike AdminAuthMiddleware, this does NOT check user roles - any valid user can access.
 */
export class UserAuthMiddleware {
  private logger = createLogger('UserAuthMiddleware');

  constructor(private tokenValidator: TokenValidator) {}

  /**
   * Verify user authentication
   *
   * Key differences from AdminAuthMiddleware:
   * - Does NOT check user role (any valid user can access)
   * - User must have valid token and be enabled
   */
  authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // 1. Extract token from Authorization header
      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({
          success: false,
          error: {
            code: UserErrorCode.UNAUTHORIZED,
            message: 'Missing or invalid authorization header'
          }
        });
        return;
      }

      const token = authHeader.substring(7);

      try {
        // 2. Validate token (this also checks if user is enabled)
        const authContext = await this.tokenValidator.validateToken(token);

        // 3. No role check - any valid, enabled user can access
        // This is the key difference from AdminAuthMiddleware

        // 4. Attach authentication context to request object
        req.authContext = authContext;

        this.logger.debug({ userId: authContext.userId }, 'User authenticated successfully');
        next();

      } catch (error) {
        // Token validation failed
        this.logger.warn({ error: error instanceof Error ? error.message : error }, 'Token validation failed');
        res.status(401).json({
          success: false,
          error: {
            code: UserErrorCode.UNAUTHORIZED,
            message: error instanceof Error ? error.message : 'Authentication failed'
          }
        });
      }
    } catch (error) {
      // Unexpected error
      this.logger.error({ error }, 'User auth middleware error');
      res.status(500).json({
        success: false,
        error: {
          code: UserErrorCode.INTERNAL_ERROR,
          message: 'Internal server error'
        }
      });
    }
  };
}
