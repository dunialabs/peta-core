import { Request, Response, NextFunction } from 'express';
import { IpWhitelistService } from '../security/IpWhitelistService.js';
import { LogService } from '../log/LogService.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../logger/index.js';
import { normalizeIp, resolveClientIp } from '../security/ClientIpResolver.js';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      clientIp?: string;
    }
  }
}

/**
 * IP whitelist middleware
 * Validates if client IP is in whitelist before processing request
 */
export class IpWhitelistMiddleware {
  // Logger for IpWhitelistMiddleware
  private logger = createLogger('IpWhitelistMiddleware');
  
  constructor(
    private ipWhitelistService: IpWhitelistService,
  ) {}

  /**
   * Check IP whitelist
   */
  checkIpWhitelist = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Get client IP
      const clientIp = this.getClientIp(req);
      req.clientIp = clientIp;

      // Only log detailed logs in development environment or specific paths
      if (process.env.NODE_ENV === 'development' && req.path !== '/') {
        const userAgent = req.headers['user-agent'] || 'Unknown';
        const referer = req.headers['referer'] || 'Direct';
        this.logger.debug({
          clientIp,
          method: req.method,
          path: req.path,
          userAgent: userAgent.substring(0, 50),
          referer
        }, 'Checking IP whitelist');
      }
      
      // Check if IP is allowed
      const isAllowed = await this.ipWhitelistService.isIpAllowed(clientIp);
      
      if (!isAllowed) {
        // Log denied access
        this.logger.warn({ clientIp }, 'Access denied for IP');
        
        if (LogService.getInstance()) {
          // TODO: Log to database
          this.logger.debug({ clientIp }, 'IP whitelist rejection logged');
        }
        
        // Return 403 error (conforms to MCP protocol format)
        res.status(403).json({
          jsonrpc: '2.0',
          error: {
            code: ErrorCode.ConnectionClosed,
            message: `Access denied: IP ${clientIp} not in whitelist`
          },
          id: null
        });
        return;
      }
      
      next();
    } catch (error) {
      this.logger.error({ error }, 'Error checking IP whitelist');
      
      res.status(503).json({
        jsonrpc: '2.0',
        error: { code: ErrorCode.ConnectionClosed, message: 'IP whitelist is unavailable' },
        id: null,
      });
    }
  };

  /**
   * Get client real IP address
   */
  private getClientIp(req: Request): string {
    const peerIp = normalizeIp(req.socket.remoteAddress || req.connection.remoteAddress || '');
    return resolveClientIp(peerIp, req.headers);
  }

  /**
   * Create middleware for specific paths
   * Can be used for more granular control
   */
  createPathSpecificMiddleware(paths: string[]) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      // Check if current path needs IP whitelist validation
      const needsCheck = paths.some(path => {
        if (path.endsWith('*')) {
          // Support wildcards
          return req.path.startsWith(path.slice(0, -1));
        }
        return req.path === path;
      });
      
      if (needsCheck) {
        await this.checkIpWhitelist(req, res, next);
      } else {
        next();
      }
    };
  }

  /**
   * Get current IP whitelist status (for debugging)
   */
  async getStatus(): Promise<{
    enabled: boolean;
    whitelist: string[];
  }> {
    const whitelist = await this.ipWhitelistService.getIpWhitelist();
    const enabled = !whitelist.includes("0.0.0.0/0");
    
    return {
      enabled,
      whitelist
    };
  }
}
