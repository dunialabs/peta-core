import { jest } from '@jest/globals';

const sessionLoggerData = [];

jest.unstable_mockModule('../dist/mcp/core/ClientSession.js', () => ({
  ClientSession: class {
    constructor(sessionId, userId, token, authContext) {
      this.sessionId = sessionId;
      this.userId = userId;
      this.token = token;
      this.authContext = authContext;
    }
    updateLastUserInfoRefresh() {}
    setProxySession() {}
  },
}));

jest.unstable_mockModule('../dist/mcp/core/ProxySession.js', () => ({
  ProxySession: class {},
}));

jest.unstable_mockModule('../dist/mcp/core/PersistentEventStore.js', () => ({
  PersistentEventStore: class {},
}));

jest.unstable_mockModule('../dist/mcp/core/GlobalRequestRouter.js', () => ({
  GlobalRequestRouter: class {},
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: { instance: {} },
}));

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({
  UserRepository: {},
}));

jest.unstable_mockModule('../dist/mcp/services/CapabilitiesService.js', () => ({
  CapabilitiesService: class {},
}));

jest.unstable_mockModule('../dist/mcp/services/DiscoveryConfigService.js', () => ({
  discoveryConfigService: { getActiveProfile: jest.fn().mockResolvedValue(null) },
}));

jest.unstable_mockModule('../dist/log/SessionLogger.js', () => ({
  SessionLogger: class {
    constructor(data) {
      sessionLoggerData.push(data);
    }
    async logSessionLifecycle() {}
  },
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: { getInstance: () => ({ enqueueLog: jest.fn() }) },
}));

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

const { SessionStore } = await import('../dist/mcp/core/SessionStore.js');

describe('SessionStore token masking', () => {
  beforeEach(() => {
    sessionLoggerData.length = 0;
  });

  test('fully redacts a short token in the session audit logger context', async () => {
    const token = '1234567890abcdef';
    await SessionStore.instance.createSession(
      `session-${Date.now()}`,
      'user-1',
      token,
      {
        userId: 'user-1',
        token,
        role: 1,
        status: 1,
        permissions: {},
        userPreferences: {},
        launchConfigs: '{}',
        authenticatedAt: new Date(),
        expiresAt: null,
        rateLimit: 10,
      },
      '127.0.0.1',
      'test-agent',
    );

    expect(sessionLoggerData[0].tokenMask).toBe('[redacted]');
  });
});
