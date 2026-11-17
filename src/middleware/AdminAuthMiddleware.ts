import { Request, Response, NextFunction } from 'express';
import { TokenValidator } from '../security/TokenValidator.js';
import { UserRole } from '../types/enums.js';
import { AdminActionType } from '../types/admin.types.js';
import { createLogger } from '../logger/index.js';
import crypto from 'node:crypto';

declare global {
  namespace Express {
    interface Request {
      bootstrapToken?: string;
    }
  }
}

function allowsUnauthenticatedAdminAction(req: Request): boolean {
  if (req.baseUrl !== '/admin' || req.method !== 'POST' || !req.body || typeof req.body !== 'object') {
    return false;
  }

  switch (req.body.action) {
    case AdminActionType.GET_OWNER:
    case AdminActionType.GET_PROXY:
      return true;
    default:
      return false;
  }
}

function isLoopback(address: string | undefined): boolean {
  const normalized = address?.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1';
}

function allowsOwnerBootstrap(req: Request): boolean {
  if (req.body?.action !== AdminActionType.CREATE_USER || req.body?.data?.role !== UserRole.Owner) return false;
  if (req.headers.authorization !== undefined) return false;
  const configured = process.env.PETA_BOOTSTRAP_SECRET;
  const presented = req.headers['x-peta-bootstrap-secret'];
  if (!configured || configured.length < 32 || typeof presented !== 'string') return false;
  if (!isLoopback(req.socket.remoteAddress)) return false;
  const presentedBytes = Buffer.from(presented);
  const configuredBytes = Buffer.from(configured);
  return presentedBytes.length === configuredBytes.length && crypto.timingSafeEqual(presentedBytes, configuredBytes);
}

function allowsBootstrapSetupAction(req: Request): boolean {
  if (req.body?.action !== AdminActionType.CREATE_PROXY) {
    return false;
  }
  if (req.headers.authorization !== undefined || !isLoopback(req.socket.remoteAddress)) return false;

  const configured = process.env.PETA_BOOTSTRAP_SECRET;
  const presented = req.headers['x-peta-bootstrap-secret'];
  if (!configured || configured.length < 32 || typeof presented !== 'string') return false;

  const presentedBytes = Buffer.from(presented);
  const configuredBytes = Buffer.from(configured);
  return presentedBytes.length === configuredBytes.length && crypto.timingSafeEqual(presentedBytes, configuredBytes);
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
      if (allowsOwnerBootstrap(req)) {
        req.bootstrapToken = process.env.PETA_BOOTSTRAP_SECRET;
        next();
        return;
      }
      if (allowsBootstrapSetupAction(req)) {
        req.bootstrapToken = process.env.PETA_BOOTSTRAP_SECRET;
        next();
        return;
      }
      if (authHeader === undefined && allowsUnauthenticatedAdminAction(req)) {
        next();
        return;
      }

      if (typeof authHeader !== 'string' || !/^Bearer\s+/i.test(authHeader) || !authHeader.replace(/^Bearer\s+/i, '').trim()) {
        res.status(401).json({
          success: false,
          message: 'Bearer token is required',
          timestamp: Math.floor(Date.now() / 1000),
        });
        return;
      }

      const token = authHeader.replace(/^Bearer\s+/i, '').trim();

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
          message: 'Invalid or expired token',
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
