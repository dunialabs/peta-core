import { Request, Response, NextFunction } from 'express';
import { TokenValidator } from '../security/TokenValidator.js';
import { UserRole } from '../types/enums.js';
import { AdminActionType } from '../types/admin.types.js';
import { createLogger } from '../logger/index.js';

function allowsUnauthenticatedAdminAction(req: Request): boolean {
  if (req.baseUrl !== '/admin' || req.method !== 'POST' || !req.body || typeof req.body !== 'object') {
    return false;
  }

  switch (req.body.action) {
    case AdminActionType.GET_OWNER:
    case AdminActionType.GET_PROXY:
    case AdminActionType.CREATE_PROXY:
    case AdminActionType.RESTORE_DATABASE:
      return true;
    case AdminActionType.CREATE_USER:
      return req.body.data?.role === UserRole.Owner;
    default:
      return false;
  }
}

/**
 * Admin interface permission verification middleware
 * Ensures only Owner role can access admin interfaces
 */
export class AdminAuthMiddleware {
  // Logger for AdminAuthMiddleware
  private logger = createLogger('AdminAuthMiddleware');
  
  constructor(private tokenValidator: TokenValidator) {}

  /**
   * Verify admin permissions
   */
  authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers['authorization'];
      if (authHeader === undefined && allowsUnauthenticatedAdminAction(req)) {
        next();
        return;
      }

      if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ') || authHeader.length === 'Bearer '.length) {
        res.status(401).json({
          success: false,
          message: 'Bearer token is required',
          timestamp: Math.floor(Date.now() / 1000),
        });
        return;
      }

      const token = authHeader.substring(7);

      try {
        const authContext = await this.tokenValidator.validateToken(token);
        
        // Only Owner and Admin roles can access admin interfaces
        if (authContext.role !== UserRole.Owner && authContext.role !== UserRole.Admin) {
          res.status(403).json({
            success: false,
            message: 'Admin access required. Only Owner role can perform admin operations.',
            timestamp: Math.floor(Date.now() / 1000)
          });
          return;
        }
        
        // Set authentication context to request object
        req.authContext = authContext;
        next();
      } catch (error) {
        res.status(401).json({
          success: false,
          message: `Invalid or expired token ${error instanceof Error ? error.message : error}`,
          timestamp: Math.floor(Date.now() / 1000)
        });
      }
    } catch (error) {
      this.logger.error({ error }, 'Admin auth middleware error');
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        timestamp: Math.floor(Date.now() / 1000)
      });
    }
  };
}
