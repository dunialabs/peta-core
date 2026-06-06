import { jest } from '@jest/globals';

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/socket/SocketNotifier.js', () => ({
  socketNotifier: { notifyUserPermissionChangedByServer: jest.fn() },
}));

jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({
  SessionStore: { instance: { getAllSessions: jest.fn(() => []) } },
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: {
    instance: {
      getResourceSubscribersForScope: jest.fn(() => new Set()),
      getResourceSubscribersForServer: jest.fn(() => new Set()),
    },
  },
}));

const { GlobalRequestRouter } = await import('../dist/mcp/core/GlobalRequestRouter.js');
const { ResultCacheService } = await import('../dist/mcp/core/cache/ResultCacheService.js');
const { modernSubscriptionBus } = await import('../dist/mcp/modern/ModernSubscriptionBus.js');

describe('GlobalRequestRouter modern subscription bus', () => {
  afterEach(() => {
    ResultCacheService.resetForTesting();
  });

  test('invalidates resource cache before publishing modern resource update events', async () => {
    const calls = [];
    const cacheService = ResultCacheService.instance;
    Object.defineProperty(cacheService, 'enabled', { configurable: true, get: () => true });
    cacheService.invalidateResource = jest.fn(async () => { calls.push('invalidate'); });
    const listener = () => { calls.push('publish'); };
    modernSubscriptionBus.onEvent(listener);

    try {
      await GlobalRequestRouter.getInstance().handleResourceUpdated('server-1', { params: { uri: 'ui://app' } }, 'scope-1');
    } finally {
      modernSubscriptionBus.offEvent(listener);
    }

    expect(calls).toEqual(['invalidate', 'publish']);
  });
});
