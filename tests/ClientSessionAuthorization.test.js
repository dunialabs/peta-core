import { jest } from '@jest/globals';

const serverManager = {
  getServerContext: jest.fn(),
  getAvailableServers: jest.fn(),
};

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: { instance: serverManager },
}));

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/socket/SocketNotifier.js', () => ({
  socketNotifier: { notifyOnlineSessions: jest.fn() },
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: { getInstance: () => ({ generateUniformRequestId: jest.fn(() => 'test-request'), enqueueLog: jest.fn() }) },
}));

jest.unstable_mockModule('../dist/mcp/core/ProxySession.js', () => ({
  ProxySession: class {},
}));

jest.unstable_mockModule('../dist/repositories/ServerRepository.js', () => ({
  default: {},
}));

const { ClientSession } = await import('../dist/mcp/core/ClientSession.js');

function createContext(capabilitiesConfig = { tools: {}, resources: {}, prompts: {} }) {
  return {
    serverID: 'server-1',
    userId: undefined,
    status: 0,
    capabilitiesConfig,
    tools: { tools: [{ name: 'tool', inputSchema: { type: 'object' } }] },
    resources: { resources: [{ name: 'resource', uri: 'resource://one' }] },
    prompts: { prompts: [{ name: 'prompt', description: 'prompt' }] },
    getDangerLevel: jest.fn(),
    serverEntity: {
      enabled: true,
      anonymousAccess: false,
      allowUserInput: false,
    },
  };
}

function createSession() {
  const session = new ClientSession('session-1', 'user-1', 'token', {
    userId: 'user-1',
    token: 'token',
    role: 3,
    status: 1,
    permissions: {
      'server-1': { enabled: true, tools: {}, resources: {}, prompts: {} },
    },
    userPreferences: {},
    launchConfigs: '{}',
    authenticatedAt: new Date(),
    expiresAt: null,
    rateLimit: 10,
  });
  return session;
}

describe('ClientSession authorization', () => {
  beforeEach(() => {
    serverManager.getServerContext.mockReset();
    const context = createContext();
    serverManager.getServerContext.mockReturnValue(context);
    serverManager.getAvailableServers.mockReset().mockReturnValue([context]);
  });

  test('inherits server capability defaults when no item override exists', () => {
    const session = createSession();

    expect(session.canUseTool('server-1', 'tool')).toBe(true);
    expect(session.canAccessResource('server-1', 'resource')).toBe(true);
    expect(session.canUsePrompt('server-1', 'prompt')).toBe(true);
  });

  test('honors explicit server capability denies', () => {
    const session = createSession();
    const deniedContext = createContext({
      tools: { tool: { enabled: false } },
      resources: { resource: { enabled: false } },
      prompts: { prompt: { enabled: false } },
    });
    serverManager.getServerContext.mockReturnValue(deniedContext);
    serverManager.getAvailableServers.mockReturnValue([deniedContext]);

    expect(session.canUseTool('server-1', 'tool')).toBe(false);
    expect(session.canAccessResource('server-1', 'resource')).toBe(false);
    expect(session.canUsePrompt('server-1', 'prompt')).toBe(false);
    expect(session.listTools().tools).toHaveLength(0);
    expect(session.listResources().resources).toHaveLength(0);
    expect(session.listPrompts().prompts).toHaveLength(0);
  });
});
