import { Request, Response, NextFunction } from 'express';
import { IpWhitelistService } from '../security/IpWhitelistService.js';
import { LogService } from '../log/LogService.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../logger/index.js';

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
      
      // Error handling strategy: fail-open (allow access)
      // Avoid service becoming completely unavailable due to configuration errors
      this.logger.warn('Error occurred, allowing access by default (fail-open)');
      next();
    }
  };

  /**
   * Get client real IP address
   */
  private getClientIp(req: Request): string {
    // 1. Check X-Forwarded-For header (for proxy/load balancer)
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      // X-Forwarded-For may contain multiple IPs, format: client, proxy1, proxy2
      // First one is the original client IP
      const ips = (typeof forwardedFor === 'string' ? forwardedFor : forwardedFor[0]).split(',');
      const clientIp = ips[0].trim();
      return this.normalizeIp(clientIp);
    }
    
    // 2. Check X-Real-IP header (used by some proxies)
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      const ip = typeof realIp === 'string' ? realIp : realIp[0];
      return this.normalizeIp(ip);
    }
    
    // 3. Check CF-Connecting-IP (Cloudflare)
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) {
      const ip = typeof cfIp === 'string' ? cfIp : cfIp[0];
      return this.normalizeIp(ip);
    }
    
    // 4. Use socket address
    const socketIp = req.socket.remoteAddress || req.connection.remoteAddress || '';
    return this.normalizeIp(socketIp);
  }

  /**
   * Normalize IP address
   */
  private normalizeIp(ip: string): string {
    // Handle IPv6-mapped IPv4 addresses
    // Example: ::ffff:192.168.1.1 -> 192.168.1.1
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    
    // Handle IPv6 localhost
    if (ip === '::1') {
      return '127.0.0.1';
    }
    
    // Handle other formats of IPv4-mapped IPv6 addresses
    if (ip.includes(':') && ip.includes('.')) {
      // May be ::192.168.1.1 format
      const lastColon = ip.lastIndexOf(':');
      const possibleIpv4 = ip.substring(lastColon + 1);
      if (this.isValidIpv4(possibleIpv4)) {
        return possibleIpv4;
      }
    }
    
    return ip;
  }

  /**
   * Validate if it's a valid IPv4 address
   */
  private isValidIpv4(ip: string): boolean {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      return false;
    }
    
    for (const part of parts) {
      const num = parseInt(part);
      if (isNaN(num) || num < 0 || num > 255) {
        return false;
      }
    }
    
    return true;
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