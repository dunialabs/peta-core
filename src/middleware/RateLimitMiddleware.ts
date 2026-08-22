import { Request, Response, NextFunction } from 'express';
import { RateLimitService } from '../security/RateLimitService.js';
import { MCPEventLogType } from '../types/enums.js';
import { LogService } from '../log/LogService.js';
import { createLogger } from '../logger/index.js';
import { maskToken } from '../utils/tokenMask.js';

export class RateLimitMiddleware {
  // Logger for RateLimitMiddleware
  private logger = createLogger('RateLimitMiddleware');
  
  constructor(
    private rateLimitService: RateLimitService
  ) {}
  
  checkRateLimit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Ensure authentication middleware has passed
      if (!req.authContext) {
        return next();
      }
      
      const { userId, rateLimit } = req.authContext;
      
      // Check rate limit
      const result = await this.rateLimitService.checkRateLimit(userId, rateLimit);
      
      if (!result.allowed) {
        // Set rate limit response headers
        res.setHeader('X-RateLimit-Limit', rateLimit.toString());
        res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
        res.setHeader('X-RateLimit-Reset', new Date(result.resetTime).toISOString());
        res.setHeader('Retry-After', result.retryAfter?.toString() || '60');

        // Log AuthRateLimit (3003) when rate limit exceeded
        LogService.getInstance().enqueueLog({
          action: MCPEventLogType.AuthRateLimit,
          userId: userId,
          sessionId: req.clientSession?.sessionId,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          tokenMask: maskToken(req.authContext.token),
          error: `Rate limit exceeded: ${rateLimit} requests/min, currentCount: ${rateLimit - result.remaining}`,
        });

        // Return 429 status code
        res.status(429).json({
          error: {
            code: -32603,
            message: 'Rate limit exceeded',
            details: {
              rateLimit: rateLimit,
              retryAfter: result.retryAfter
            }
          }
        });
        return;
      }
      
      // Set rate limit response headers
      res.setHeader('X-RateLimit-Limit', rateLimit.toString());
      res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
      res.setHeader('X-RateLimit-Reset', new Date(result.resetTime).toISOString());
      
      next();
    } catch (error) {
      this.logger.error({ error }, 'Rate limit middleware error');
      next(error);
    }
  };
}
