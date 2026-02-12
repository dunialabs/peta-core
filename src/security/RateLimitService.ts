import { createLogger } from '../logger/index.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

export class RateLimitService {
  private userRequestCounts: Map<string, {
    count: number;
    windowStart: number;
    lastRequestTime: number;
  }> = new Map();
  
  private readonly WINDOW_SIZE = 60 * 1000; // 1 minute, milliseconds
  
  // Logger for RateLimitService
  private logger = createLogger('RateLimitService');
  
  constructor() {
    // Start scheduled cleanup task
    this.startCleanupTimer();
  }
  
  async checkRateLimit(userId: string, rateLimit: number): Promise<RateLimitResult> {
    const now = Date.now();
    const userCount = this.userRequestCounts.get(userId);
    
    if (!userCount) {
      // First request, create count record
      this.userRequestCounts.set(userId, {
        count: 1,
        windowStart: now,
        lastRequestTime: now
      });
      
      return {
        allowed: true,
        remaining: rateLimit - 1,
        resetTime: now + this.WINDOW_SIZE
      };
    }
    
    // Check if time window needs to be reset
    if (now - userCount.windowStart >= this.WINDOW_SIZE) {
      // Reset count
      userCount.count = 1;
      userCount.windowStart = now;
      userCount.lastRequestTime = now;
      
      return {
        allowed: true,
        remaining: rateLimit - 1,
        resetTime: now + this.WINDOW_SIZE
      };
    }
    
    // Check if rate limit exceeded
    if (userCount.count >= rateLimit) {
      const resetTime = userCount.windowStart + this.WINDOW_SIZE;
      const retryAfter = Math.ceil((resetTime - now) / 1000);

      return {
        allowed: false,
        remaining: 0,
        resetTime,
        retryAfter
      };
    }
    
    // Increment count
    userCount.count++;
    userCount.lastRequestTime = now;
    
    return {
      allowed: true,
      remaining: rateLimit - userCount.count,
      resetTime: userCount.windowStart + this.WINDOW_SIZE
    };
  }
  
  private startCleanupTimer(): void {
    setInterval(() => {
      this.cleanupExpiredCounts();
    }, 5 * 60 * 1000); // Clean up every 5 minutes
  }
  
  private async cleanupExpiredCounts(): Promise<void> {
    const now = Date.now();
    const expiredUsers: string[] = [];
    
    for (const [userId, count] of this.userRequestCounts.entries()) {
      if (now - count.lastRequestTime > this.WINDOW_SIZE * 2) {
        expiredUsers.push(userId);
      }
    }
    
    for (const userId of expiredUsers) {
      this.userRequestCounts.delete(userId);
    }
    
    if (expiredUsers.length > 0) {
      this.logger.debug({ count: expiredUsers.length }, 'Cleaned up expired rate limit records');
    }
  }
}
