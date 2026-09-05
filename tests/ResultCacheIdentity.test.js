import { jest } from '@jest/globals';

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

const { ResultCacheService } = await import('../dist/mcp/core/cache/ResultCacheService.js');
const { CacheKeyBuilder } = await import('../dist/mcp/core/cache/CacheKeyBuilder.js');
const { CacheSerializer } = await import('../dist/mcp/core/cache/CacheSerializer.js');
const { MemoryResultCacheStore } = await import('../dist/mcp/core/cache/stores/MemoryResultCacheStore.js');

const config = {
  enabled: true,
  backend: 'memory',
  strictStartup: false,
  defaultTtlSeconds: 60,
  defaultAdmissionPolicy: 'immediate',
  defaultAdmissionWindowSeconds: 60,
  maxEntryBytes: 262144,
  keyPrefix: 'identity-test',
  compress: 'false',
  compressionMinBytes: 4096,
  dbSweepIntervalSeconds: 60,
  dbSweepBatchSize: 1000,
  memoryMaxEntries: 10,
};

const capabilities = {
  tools: {
    lookup: {
      enabled: true,
      cache: { enabled: true },
    },
    lookupWithExplicitTimestampExclusion: {
      enabled: true,
      cache: { enabled: true, key: { denyFields: ['timestamp'] } },
    },
  },
  resources: {},
  prompts: {},
};

describe('ResultCacheService identity', () => {
  afterEach(async () => {
    ResultCacheService.resetForTesting();
  });

  test('keeps tool-owned metadata and common business fields in the cache identity', async () => {
    const store = new MemoryResultCacheStore(10, 0);
    const service = ResultCacheService.initialize(config, store);
    const policy = service.resolveToolPolicy(capabilities, 'lookup');
    const scope = { userId: 'user' };
    const original = {
      timestamp: '2026-09-05T00:00:00.000Z',
      requestId: 'request-a',
      nonce: 'nonce-a',
      _meta: { tenant: 'acme' },
    };

    expect(policy).not.toBeNull();
    await service.storeResult('tool', 'server', 'lookup', scope, policy, original, { result: 'first' });

    await expect(service.lookup('tool', 'server', 'lookup', scope, policy, original)).resolves.toMatchObject({
      hit: true,
      entry: { payload: { result: 'first' } },
    });
    await expect(service.lookup('tool', 'server', 'lookup', scope, policy, {
      ...original,
      timestamp: '2026-09-05T00:00:01.000Z',
      requestId: 'request-b',
      nonce: 'nonce-b',
      _meta: { tenant: 'other' },
    })).resolves.toMatchObject({ hit: false });

    await store.close();
  });

  test('excludes a field only when the entity cache policy explicitly requests it', async () => {
    const store = new MemoryResultCacheStore(10, 0);
    const service = ResultCacheService.initialize(config, store);
    const policy = service.resolveToolPolicy(capabilities, 'lookupWithExplicitTimestampExclusion');
    const scope = { userId: 'user' };

    expect(policy).toMatchObject({ denyFields: ['timestamp'] });
    await service.storeResult(
      'tool',
      'server',
      'lookupWithExplicitTimestampExclusion',
      scope,
      policy,
      { timestamp: 'first', query: 'same' },
      { result: 'first' },
    );
    await expect(service.lookup(
      'tool',
      'server',
      'lookupWithExplicitTimestampExclusion',
      scope,
      policy,
      { timestamp: 'second', query: 'same' },
    )).resolves.toMatchObject({
      hit: true,
      entry: { payload: { result: 'first' } },
    });

    await store.close();
  });

  test('does not read entries stored under the previous cache key version', async () => {
    const store = new MemoryResultCacheStore(10, 0);
    const service = ResultCacheService.initialize(config, store);
    const policy = service.resolveToolPolicy(capabilities, 'lookup');
    const scope = { userId: 'user' };
    const request = {};
    const keyBuilder = new CacheKeyBuilder();
    const serializer = new CacheSerializer();
    const requestHash = keyBuilder.canonicalizeParams(request, policy.denyFields, policy.allowFields);
    const entityHash = keyBuilder.buildEntityHash('lookup');
    const scopeHash = keyBuilder.buildScopeHash('user');
    const legacyKey = `identity-test:rc:v1:tool:server:${entityHash}:user:${scopeHash}:gv0:sv0:ev0:${requestHash}`;
    const legacyEntry = serializer.createEnvelope({
      operation: 'tool',
      serverId: 'server',
      entityId: 'lookup',
      scopeType: 'user',
      scopeHash,
      ttlSeconds: 60,
      admissionPolicy: 'immediate',
      admittedAfterObservations: 0,
      requestHash,
      payload: { result: 'legacy' },
      payloadBytes: 19,
    });

    await store.set(legacyKey, serializer.serialize(legacyEntry, false, 4096), 60);

    await expect(service.lookup('tool', 'server', 'lookup', scope, policy, request)).resolves.toMatchObject({
      hit: false,
    });

    await store.close();
  });

  test('keeps an own __proto__ request key in cache identity', () => {
    const keyBuilder = new CacheKeyBuilder();
    const prototypeKey = JSON.parse('{"__proto__":{"tenant":"acme"}}');

    expect(keyBuilder.canonicalizeParams(prototypeKey, [])).not.toBe(
      keyBuilder.canonicalizeParams({}, []),
    );
  });
});
