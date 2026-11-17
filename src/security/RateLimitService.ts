import { createLogger } from '../logger/index.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

const DEFAULT_MAX_TRACKED_USERS = 10_000;
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 100_000;

export function normalizeRateLimit(rateLimit: number): number {
  if (!Number.isFinite(rateLimit)) return 1;
  return Math.min(Math.max(Math.floor(rateLimit), 1), DEFAULT_MAX_REQUESTS_PER_MINUTE);
}

export class RateLimitService {
  private userRequestCounts: Map<string, {
    count: number;
    windowStart: number;
    lastRequestTime: number;
  }> = new Map();
  
  private readonly WINDOW_SIZE = 60 * 1000; // 1 minute, milliseconds
  private readonly MAX_TRACKED_USERS = Math.max(
    1,
    Number.parseInt(process.env.PETA_MAX_RATE_LIMIT_USERS ?? String(DEFAULT_MAX_TRACKED_USERS), 10) || DEFAULT_MAX_TRACKED_USERS,
  );
  
  // Logger for RateLimitService
  private logger = createLogger('RateLimitService');
  
  constructor() {
    // Start scheduled cleanup task
    this.startCleanupTimer();
  }
  
  async checkRateLimit(userId: string, rateLimit: number): Promise<RateLimitResult> {
    const now = Date.now();
    const effectiveRateLimit = normalizeRateLimit(rateLimit);
    const userCount = this.userRequestCounts.get(userId);
    
    if (!userCount) {
      this.cleanupExpiredCounts(now);
      if (this.userRequestCounts.size >= this.MAX_TRACKED_USERS) {
        return {
          allowed: false,
          remaining: 0,
          resetTime: now + this.WINDOW_SIZE,
          retryAfter: 60,
        };
      }
      // First request, create count record
      this.userRequestCounts.set(userId, {
        count: 1,
        windowStart: now,
        lastRequestTime: now
      });
      
      return {
        allowed: true,
        remaining: effectiveRateLimit - 1,
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
        remaining: effectiveRateLimit - 1,
        resetTime: now + this.WINDOW_SIZE
      };
    }
    
    // Check if rate limit exceeded
    if (userCount.count >= effectiveRateLimit) {
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
      remaining: effectiveRateLimit - userCount.count,
      resetTime: userCount.windowStart + this.WINDOW_SIZE
    };
  }
  
  private startCleanupTimer(): void {
    const timer = setInterval(() => {
      this.cleanupExpiredCounts();
    }, 5 * 60 * 1000); // Clean up every 5 minutes
    timer.unref?.();
  }
  
  private cleanupExpiredCounts(now: number = Date.now()): void {
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
