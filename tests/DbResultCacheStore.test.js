import { jest } from '@jest/globals';

const getEntry = jest.fn();

jest.unstable_mockModule('../dist/repositories/ResultCacheRepository.js', () => ({
  ResultCacheRepository: {
    getEntry,
    upsertEntry: jest.fn(),
    deleteEntry: jest.fn(),
    cleanupExpired: jest.fn(),
  },
}));

jest.unstable_mockModule('../dist/repositories/ResultCacheAdmissionRepository.js', () => ({
  ResultCacheAdmissionRepository: {
    recordAttempt: jest.fn(),
    getCount: jest.fn(),
    clearAdmission: jest.fn(),
    cleanupExpired: jest.fn(),
  },
}));

jest.unstable_mockModule('../dist/repositories/CacheNamespaceVersionRepository.js', () => ({
  CacheNamespaceVersionRepository: {
    getVersion: jest.fn(),
    bumpVersion: jest.fn(),
  },
}));

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  }),
}));

const { DbResultCacheStore } = await import('../dist/mcp/core/cache/stores/DbResultCacheStore.js');

describe('DbResultCacheStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normalizes Uint8Array payload blobs into Buffers', async () => {
    const json = '{"ok":true}';
    getEntry.mockResolvedValue({
      payload_blob: new Uint8Array(Buffer.from(json, 'utf8')),
      payload_encoding: 'json',
      expires_at: new Date(Date.now() + 30_000),
    });

    const store = new DbResultCacheStore();
    const result = await store.get('cache-key');

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result?.toString('utf8')).toBe(json);
  });
});
