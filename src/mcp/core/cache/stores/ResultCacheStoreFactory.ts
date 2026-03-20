import type { ResultCacheConfig } from '../../../../config/resultCacheConfig.js';
import { createLogger } from '../../../../logger/index.js';
import { DbResultCacheStore } from './DbResultCacheStore.js';
import { MemoryResultCacheStore } from './MemoryResultCacheStore.js';
import { NoopResultCacheStore } from './NoopResultCacheStore.js';
import { RedisResultCacheStore } from './RedisResultCacheStore.js';
import type { ResultCacheStore } from './ResultCacheStore.js';

const logger = createLogger('ResultCacheStoreFactory');

export async function createResultCacheStore(config: ResultCacheConfig): Promise<ResultCacheStore> {
  if (!config.enabled) {
    logger.info('Result cache disabled, using noop store');
    return new NoopResultCacheStore();
  }

  switch (config.backend) {
    case 'memory':
      logger.info({ maxEntries: config.memoryMaxEntries }, 'Creating memory result cache store');
      return new MemoryResultCacheStore(
        config.memoryMaxEntries,
        config.dbSweepIntervalSeconds * 1000,
      );

    case 'noop':
      logger.info('Using noop result cache store');
      return new NoopResultCacheStore();

    case 'db': {
      const dbStore = new DbResultCacheStore();
      try {
        const health = await dbStore.healthcheck();
        if (!health.ok) {
          throw new Error(health.details ?? 'db cache healthcheck failed');
        }
        dbStore.startSweeper(config.dbSweepIntervalSeconds, config.dbSweepBatchSize);
        logger.info('Created DB result cache store');
        return dbStore;
      } catch (error) {
        await dbStore.close?.();
        logger.error({ error }, 'Failed to initialize DB result cache store');
        if (config.strictStartup) {
          throw error;
        }
        logger.warn('Falling back to noop result cache store');
        return new NoopResultCacheStore();
      }
    }

    case 'redis': {
      if (!config.redisUrl) {
        logger.error('REDIS_URL is required when RESULT_CACHE_BACKEND=redis');
        if (config.strictStartup) {
          throw new Error('REDIS_URL is required when RESULT_CACHE_BACKEND=redis');
        }
        return new NoopResultCacheStore();
      }
      const redisStore = new RedisResultCacheStore(config.redisUrl);
      try {
        const health = await redisStore.healthcheck();
        if (!health.ok) {
          throw new Error(health.details ?? 'redis cache healthcheck failed');
        }
        logger.info('Created Redis result cache store');
        return redisStore;
      } catch (error) {
        await redisStore.close?.();
        logger.error({ error }, 'Failed to initialize Redis result cache store');
        if (config.strictStartup) {
          throw error;
        }
        logger.warn('Falling back to noop result cache store');
        return new NoopResultCacheStore();
      }
    }

    default: {
      const exhaustive: never = config.backend;
      logger.error({ backend: exhaustive }, 'Unknown cache backend, falling back to noop');
      return new NoopResultCacheStore();
    }
  }
}
