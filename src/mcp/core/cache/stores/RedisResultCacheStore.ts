import Redis from 'ioredis';
import { createLogger } from '../../../../logger/index.js';
import type { ResultCacheStore } from './ResultCacheStore.js';

const ADMISSION_RECORD_LUA = `
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
return count
`;

export class RedisResultCacheStore implements ResultCacheStore {
  private readonly logger = createLogger('RedisResultCacheStore');
  private readonly client: Redis;

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
    });

    this.client.on('error', (error) => {
      this.logger.warn({ error }, 'Redis client error');
    });
  }

  async get(entryKey: string): Promise<Buffer | null> {
    return this.client.getBuffer(entryKey);
  }

  async set(entryKey: string, value: Buffer, ttlSeconds: number): Promise<void> {
    await this.client.set(entryKey, value, 'EX', ttlSeconds);
  }

  async delete(entryKey: string): Promise<void> {
    await this.client.del(entryKey);
  }

  async recordAdmissionAttempt(admissionKey: string, windowSeconds: number): Promise<number> {
    const result = await this.client.eval(ADMISSION_RECORD_LUA, 1, admissionKey, windowSeconds);
    return Number(result) || 0;
  }

  async getAdmissionCount(admissionKey: string): Promise<number> {
    const raw = await this.client.get(admissionKey);
    if (!raw) {
      return 0;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async clearAdmission(admissionKey: string): Promise<void> {
    await this.client.del(admissionKey);
  }

  async getNamespaceVersion(namespaceKey: string): Promise<number> {
    const raw = await this.client.get(namespaceKey);
    if (!raw) {
      return 0;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async bumpNamespaceVersion(namespaceKey: string): Promise<number> {
    return this.client.incr(namespaceKey);
  }

  async healthcheck(): Promise<{ ok: boolean; details?: string }> {
    try {
      await this.client.ping();
      return { ok: true, details: 'redis store ok' };
    } catch (error) {
      this.logger.warn({ error }, 'Redis cache healthcheck failed');
      return { ok: false, details: 'redis store unavailable' };
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
