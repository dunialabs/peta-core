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
const { ServerStatus } = await import('../dist/types/enums.js');
const { LogService } = await import('../dist/log/LogService.js');

describe('ServerManager temporary resource subscription isolation', () => {
  const manager = ServerManager.instance;

  beforeAll(async () => {
    await Promise.resolve();
    manager.stopIdleCheck?.();
  });

  afterAll(async () => {
    manager.stopIdleCheck?.();
    await LogService.getInstance().shutdown();
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

  test('coalesces concurrent first subscribers into one downstream subscription', async () => {
    let finishSubscription;
    const subscribed = new Promise((resolve) => { finishSubscription = resolve; });
    const context = createTemporaryContext('scope-a', 'user-a');
    context.connection.subscribeResource = jest.fn(() => subscribed);
    manager.temporaryServers.set('temp-server:user-a', context);

    const first = manager.subscribeResource('temp-server', 'resource://shared', 'session-a', 'user-a');
    const second = manager.subscribeResource('temp-server', 'resource://shared', 'session-b', 'user-a');
    await new Promise((resolve) => setImmediate(resolve));

    expect(context.connection.subscribeResource).toHaveBeenCalledTimes(1);
    finishSubscription();
    await Promise.all([first, second]);
    expect(manager.resourceSubscriptions.values().next().value.subscribedSessions.size).toBe(2);
  });

  test('waits for an in-flight first subscription before the last subscriber unsubscribes', async () => {
    let finishSubscription;
    const subscribed = new Promise((resolve) => { finishSubscription = resolve; });
    const context = createTemporaryContext('scope-a', 'user-a');
    context.connection.subscribeResource = jest.fn(() => subscribed);
    manager.temporaryServers.set('temp-server:user-a', context);

    const subscription = manager.subscribeResource('temp-server', 'resource://shared', 'session-a', 'user-a');
    await new Promise((resolve) => setImmediate(resolve));
    const unsubscription = manager.unsubscribeResource('temp-server', 'resource://shared', 'session-a', 'user-a');

    expect(context.connection.unsubscribeResource).not.toHaveBeenCalled();
    finishSubscription();
    await Promise.all([subscription, unsubscription]);
    expect(context.connection.unsubscribeResource).toHaveBeenCalledTimes(1);
    expect(manager.resourceSubscriptions.size).toBe(0);
  });

  test('public reconnect preserves subscription scope and restores it once', async () => {
    const context = createTemporaryContext('scope-a', 'user-a');
    const firstConnection = context.connection;
    context.stopTokenRefresh = jest.fn();
    context.closeConnection = jest.fn(async (status) => {
      context.status = status;
      context.connection = undefined;
    });
    context.serverEntity = {
      serverId: 'temp-server',
      serverName: 'Temporary server',
      allowUserInput: true,
      configTemplate: '{}',
    };
    context.capabilitiesConfig = {
      tools: { existing: { enabled: true } },
      resources: {},
      prompts: {},
    };
    context.updateCapabilities = (capabilities) => {
      context.capabilities = capabilities;
    };
    context.updateTools = jest.fn(async () => {});
    context.updateResources = jest.fn(async () => {});
    context.updateResourceTemplates = jest.fn(async () => {});
    context.updatePrompts = jest.fn(async () => {});
    context.clearError = jest.fn();
    context.clearTimeout = jest.fn();
    manager.temporaryServers.set('temp-server:user-a', context);

    await manager.subscribeResource('temp-server', 'resource://shared', 'session-a', 'user-a');
    expect(firstConnection.subscribeResource).toHaveBeenCalledTimes(1);

    const reconnectedClient = {
      getServerCapabilities: () => ({ resources: { subscribe: true } }),
      setNotificationHandler: jest.fn(),
      listTools: jest.fn(async () => ({ tools: [] })),
      listResources: jest.fn(async () => ({ resources: [] })),
      listResourceTemplates: jest.fn(async () => ({ resourceTemplates: [] })),
      subscribeResource: jest.fn(async () => {}),
      unsubscribeResource: jest.fn(async () => {}),
    };
    const createServerConnection = manager.createServerConnection;
    manager.createServerConnection = jest.fn(async (reconnectContext) => {
      reconnectContext.connection = reconnectedClient;
      await manager.updateServerCapabilities(reconnectContext);
      await manager.updateServerCapabilities(reconnectContext);
    });

    try {
      const reconnectedContext = await manager.reconnectTemporaryServer(
        context.serverEntity,
        'user-a',
        'new-token',
      );

      expect(reconnectedContext).toBe(context);
      expect(reconnectedContext.id).toBe('scope-a');
      expect(reconnectedClient.subscribeResource).toHaveBeenCalledTimes(1);
      expect(manager.resourceSubscriptions.values().next().value.subscribedSessions).toEqual(
        new Set(['session-a']),
      );
    } finally {
      manager.createServerConnection = createServerConnection;
    }
  });

  test('keeps a failed reconnect subscription retryable', async () => {
    const context = createTemporaryContext('scope-a', 'user-a');
    context.stopTokenRefresh = jest.fn();
    context.closeConnection = jest.fn(async () => {
      context.connection = undefined;
    });
    manager.temporaryServers.set('temp-server:user-a', context);
    await manager.subscribeResource('temp-server', 'resource://shared', 'session-a', 'user-a');
    await manager.disconnectServerContext(context, ServerStatus.Offline, {
      serverId: 'temp-server',
      userId: 'user-a',
    });

    const reconnectError = new Error('reconnect subscription failed');
    context.connection = {
      getServerCapabilities: () => ({ resources: { subscribe: true } }),
      setNotificationHandler: jest.fn(),
      listTools: jest.fn(async () => ({ tools: [] })),
      listResources: jest.fn(async () => ({ resources: [] })),
      listResourceTemplates: jest.fn(async () => ({ resourceTemplates: [] })),
      subscribeResource: jest.fn(async () => { throw reconnectError; }),
    };

    await expect(manager.updateServerCapabilities(context)).rejects.toBe(reconnectError);
    const state = manager.resourceSubscriptions.values().next().value;
    expect(state.downstreamSubscribed).toBe(false);
    expect(state.downstreamSubscription).toBeUndefined();
    expect(state.subscribedSessions).toEqual(new Set(['session-a']));

    const retrySubscription = jest.fn(async () => {});
    context.connection = {
      subscribeResource: retrySubscription,
      unsubscribeResource: jest.fn(async () => {}),
    };
    await manager.subscribeResource('temp-server', 'resource://shared', 'session-a', 'user-a');

    expect(retrySubscription).toHaveBeenCalledTimes(1);
    expect(state.downstreamSubscribed).toBe(true);
  });
});
