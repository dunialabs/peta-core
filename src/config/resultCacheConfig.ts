import { createLogger } from '../logger/index.js';

export type ResultCacheBackend = 'db' | 'redis' | 'memory' | 'noop';
export type ResultCacheCompressMode = 'true' | 'false' | 'auto';
export type ResultCacheAdmissionPolicy = 'immediate' | 'second_hit';

export interface ResultCacheConfig {
  enabled: boolean;
  backend: ResultCacheBackend;
  strictStartup: boolean;
  defaultTtlSeconds: number;
  defaultAdmissionPolicy: ResultCacheAdmissionPolicy;
  defaultAdmissionWindowSeconds: number;
  maxEntryBytes: number;
  keyPrefix: string;
  compress: ResultCacheCompressMode;
  compressionMinBytes: number;
  dbSweepIntervalSeconds: number;
  dbSweepBatchSize: number;
  memoryMaxEntries: number;
  redisUrl?: string;
}

const logger = createLogger('ResultCacheConfig');

const DEFAULTS = {
  enabled: false,
  backend: 'db' as ResultCacheBackend,
  strictStartup: false,
  defaultTtlSeconds: 30,
  defaultAdmissionPolicy: 'immediate' as ResultCacheAdmissionPolicy,
  defaultAdmissionWindowSeconds: 300,
  maxEntryBytes: 262144,
  compress: 'auto' as ResultCacheCompressMode,
  compressionMinBytes: 4096,
  dbSweepIntervalSeconds: 300,
  dbSweepBatchSize: 1000,
  memoryMaxEntries: 1000,
};

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  logger.warn({ env: name, value: raw, fallback }, 'Invalid boolean env value, using fallback');
  return fallback;
}

function clampIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    logger.warn({ env: name, value: raw, fallback }, 'Invalid integer env value, using fallback');
    return fallback;
  }

  if (parsed < min || parsed > max) {
    const clamped = Math.max(min, Math.min(max, parsed));
    logger.warn(
      { env: name, value: raw, clamped, min, max },
      'Out-of-range integer env value, clamping',
    );
    return clamped;
  }

  return parsed;
}

function parseEnumEnv<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (allowed.includes(normalized as T)) {
    return normalized as T;
  }

  logger.warn(
    { env: name, value: raw, allowed, fallback },
    'Invalid enum env value, using fallback',
  );
  return fallback;
}

export function loadResultCacheConfig(): ResultCacheConfig {
  const backend = parseEnumEnv<ResultCacheBackend>('RESULT_CACHE_BACKEND', DEFAULTS.backend, [
    'db',
    'redis',
    'memory',
    'noop',
  ]);
  const strictStartup = parseBooleanEnv('RESULT_CACHE_STRICT_STARTUP', DEFAULTS.strictStartup);
  const keyPrefix =
    process.env.RESULT_CACHE_KEY_PREFIX?.trim() || `peta:${process.env.NODE_ENV || 'dev'}`;

  const config: ResultCacheConfig = {
    enabled: parseBooleanEnv('RESULT_CACHE_ENABLED', DEFAULTS.enabled),
    backend,
    strictStartup,
    defaultTtlSeconds: clampIntEnv(
      'RESULT_CACHE_DEFAULT_TTL_SECONDS',
      DEFAULTS.defaultTtlSeconds,
      1,
      86400,
    ),
    defaultAdmissionPolicy: parseEnumEnv<ResultCacheAdmissionPolicy>(
      'RESULT_CACHE_DEFAULT_ADMISSION_POLICY',
      DEFAULTS.defaultAdmissionPolicy,
      ['immediate', 'second_hit'],
    ),
    defaultAdmissionWindowSeconds: clampIntEnv(
      'RESULT_CACHE_DEFAULT_ADMISSION_WINDOW_SECONDS',
      DEFAULTS.defaultAdmissionWindowSeconds,
      1,
      86400,
    ),
    maxEntryBytes: clampIntEnv(
      'RESULT_CACHE_MAX_ENTRY_BYTES',
      DEFAULTS.maxEntryBytes,
      1024,
      5242880,
    ),
    keyPrefix,
    compress: parseEnumEnv<ResultCacheCompressMode>('RESULT_CACHE_COMPRESS', DEFAULTS.compress, [
      'true',
      'false',
      'auto',
    ]),
    compressionMinBytes: clampIntEnv(
      'RESULT_CACHE_COMPRESSION_MIN_BYTES',
      DEFAULTS.compressionMinBytes,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    dbSweepIntervalSeconds: clampIntEnv(
      'RESULT_CACHE_DB_SWEEP_INTERVAL_SECONDS',
      DEFAULTS.dbSweepIntervalSeconds,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    dbSweepBatchSize: clampIntEnv(
      'RESULT_CACHE_DB_SWEEP_BATCH_SIZE',
      DEFAULTS.dbSweepBatchSize,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    memoryMaxEntries: clampIntEnv(
      'RESULT_CACHE_MEMORY_MAX_ENTRIES',
      DEFAULTS.memoryMaxEntries,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };

  if (backend === 'redis') {
    const redisUrl = process.env.REDIS_URL?.trim();
    if (!redisUrl) {
      const message = 'REDIS_URL is required when RESULT_CACHE_BACKEND=redis';
      logger.warn({ backend, strictStartup }, message);
      if (strictStartup) {
        throw new Error(message);
      }
    } else {
      config.redisUrl = redisUrl;
    }
  }

  return config;
}

export const resultCacheConfig: ResultCacheConfig = Object.freeze(loadResultCacheConfig());
