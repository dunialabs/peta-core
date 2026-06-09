import { jest } from '@jest/globals';

const findEnabled = jest.fn().mockResolvedValue([]);
const findAll = jest.fn().mockResolvedValue([]);

jest.unstable_mockModule('../dist/repositories/ServerRepository.js', () => ({
  ServerRepository: {
    findEnabled,
    findAll,
  },
}));

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({
  UserRepository: {},
}));

jest.unstable_mockModule('../dist/mcp/core/DownstreamTransportFactory.js', () => ({
  DownstreamTransportFactory: {
    detectTransportType: (config) => config.type ?? (config.url ? 'http' : 'stdio'),
    create: jest.fn(),
  },
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {},
}));

jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({
  SessionStore: {
    instance: {
      getUserFirstSession: jest.fn(),
      getSessionsUsingServer: jest.fn().mockReturnValue([]),
      getUserSessions: jest.fn().mockReturnValue([]),
      getProxySession: jest.fn(),
    },
  },
}));

jest.unstable_mockModule('../dist/log/ServerLogger.js', () => ({
  ServerLogger: class {
    async logServerLifecycle() {}
    async logServerCapabilityUpdate() {}
  },
}));

jest.unstable_mockModule('../dist/socket/SocketNotifier.js', () => ({
  socketNotifier: {
    notifyUserPermissionChangedByServer: jest.fn(async () => {}),
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

jest.unstable_mockModule('../dist/mcp/core/CustomStdioRunnerService.js', () => ({
  customStdioRunnerService: {
    resolveLaunchPlan: (_serverEntity, launchConfig) => ({
      launchConfig,
      runnerMetadata: undefined,
    }),
    attachExecutionTrace: () => undefined,
    buildFailureDetails: () => undefined,
  },
}));

jest.unstable_mockModule('../dist/mcp/core/ConnectionStartupDiagnostics.js', () => ({
  createConnectionStartupDiagnostics: () => ({
    captureClose: jest.fn(),
    getPreferredMessage: (error) => error?.message ?? undefined,
    deactivate: jest.fn(),
    getSnapshot: () => ({}),
  }),
  formatConnectionDiagnosticError: (error) =>
    error instanceof Error ? error.message : String(error),
}));

const { ServerManager } = await import('../dist/mcp/core/ServerManager.js');

describe('ServerManager temporary resource subscription isolation', () => {
  const manager = ServerManager.instance;

  beforeAll(async () => {
    await Promise.resolve();
    manager.stopIdleCheck?.();
  });

  afterAll(() => {
    manager.stopIdleCheck?.();
  });

  beforeEach(() => {
    manager.stopIdleCheck?.();
    manager.serverContexts.clear();
    manager.serverLoggers.clear();
    manager.temporaryServers.clear();
    manager.temporaryServerLoggers.clear();
    manager.resourceSubscriptions.clear();
    manager.serverWaitQueues.clear();
  });

  function createTemporaryContext(scopeId, userId) {
    return {
      id: scopeId,
      userId,
      capabilities: {
        resources: {
          subscribe: true,
        },
      },
      connection: {
        subscribeResource: jest.fn(async () => {}),
        unsubscribeResource: jest.fn(async () => {}),
      },
      serverEntity: {
        serverId: 'temp-server',
      },
    };
  }

  test('subscribes the same resource separately for different temporary server instances', async () => {
    const contextA = createTemporaryContext('scope-a', 'user-a');
    const contextB = createTemporaryContext('scope-b', 'user-b');

    manager.temporaryServers.set('temp-server:user-a', contextA);
    manager.temporaryServers.set('temp-server:user-b', contextB);

    await manager.subscribeResource('temp-server', 'resource://shared', 'session-a', 'user-a');
    await manager.subscribeResource('temp-server', 'resource://shared', 'session-b', 'user-b');

    expect(contextA.connection.subscribeResource).toHaveBeenCalledTimes(1);
    expect(contextB.connection.subscribeResource).toHaveBeenCalledTimes(1);
    expect(manager.resourceSubscriptions.size).toBe(2);
  });

  test('unsubscribes each temporary server instance independently', async () => {
    const contextA = createTemporaryContext('scope-a', 'user-a');
    const contextB = createTemporaryContext('scope-b', 'user-b');

    manager.temporaryServers.set('temp-server:user-a', contextA);
    manager.temporaryServers.set('temp-server:user-b', contextB);

    await manager.subscribeResource('temp-server', 'resource://shared', 'session-a', 'user-a');
    await manager.subscribeResource('temp-server', 'resource://shared', 'session-b', 'user-b');

    await manager.unsubscribeResource('temp-server', 'resource://shared', 'session-a', 'user-a');

    expect(contextA.connection.unsubscribeResource).toHaveBeenCalledTimes(1);
    expect(contextB.connection.unsubscribeResource).not.toHaveBeenCalled();
    expect(manager.resourceSubscriptions.size).toBe(1);

    await manager.unsubscribeResource('temp-server', 'resource://shared', 'session-b', 'user-b');

    expect(contextB.connection.unsubscribeResource).toHaveBeenCalledTimes(1);
    expect(manager.resourceSubscriptions.size).toBe(0);
  });
});
