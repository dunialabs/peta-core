import { jest } from '@jest/globals';

const findEnabled = jest.fn().mockResolvedValue([]);
const findByServerId = jest.fn();
const updateServer = jest.fn(async (serverId, data) => ({ serverId, ...data }));
const findAllServers = jest.fn().mockResolvedValue([]);
const findUserById = jest.fn();
const updateLaunchConfigs = jest.fn();
const notifyUserPermissionChangedByServer = jest.fn().mockResolvedValue(undefined);
const transportFactoryCreate = jest.fn();
const getUserFirstSession = jest.fn();
const getSessionsUsingServer = jest.fn().mockReturnValue([]);

let clientConnectImpl = async () => {};
const createdTransports = [];

function createFakeTransport() {
  const transport = {
    onclose: undefined,
    send: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
  };
  createdTransports.push(transport);
  return transport;
}

class FakeClient {
  constructor() {
    this.notificationHandlers = new Map();
  }

  async connect(transport) {
    this.transport = transport;
    await clientConnectImpl(transport);
  }

  async ping() {}

  async close() {}

  getServerVersion() {
    return undefined;
  }

  getServerCapabilities() {
    return {};
  }

  setNotificationHandler(schema, handler) {
    this.notificationHandlers.set(schema, handler);
  }

  async listTools() {
    return { tools: [] };
  }

  async listResources() {
    return { resources: [] };
  }

  async listResourceTemplates() {
    return { resourceTemplates: [] };
  }

  async listPrompts() {
    return { prompts: [] };
  }
}

jest.unstable_mockModule('../dist/repositories/ServerRepository.js', () => ({
  ServerRepository: {
    findEnabled,
    findByServerId,
    update: updateServer,
    findAll: findAllServers,
  },
}));

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({
  UserRepository: {
    findById: findUserById,
    updateLaunchConfigs,
  },
}));

jest.unstable_mockModule('../dist/mcp/core/DownstreamTransportFactory.js', () => ({
  DownstreamTransportFactory: {
    create: transportFactoryCreate,
    canFallbackHttpToSse: jest.fn(() => false),
    createSSEFallbackTransport: jest.fn(),
  },
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: FakeClient,
}));

jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({
  SessionStore: {
    instance: {
      getUserFirstSession,
      getSessionsUsingServer,
      getUserSessions: jest.fn().mockReturnValue([]),
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
    notifyUserPermissionChangedByServer,
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
  formatConnectionDiagnosticError: (error) => error instanceof Error ? error.message : String(error),
}));

const { ServerManager } = await import('../dist/mcp/core/ServerManager.js');
const { ServerStatus, ServerCategory, ServerAuthType } = await import('../dist/types/enums.js');
const { ServerRepository } = await import('../dist/repositories/ServerRepository.js');
const { SessionStore } = await import('../dist/mcp/core/SessionStore.js');
const { DownstreamTransportFactory } = await import('../dist/mcp/core/DownstreamTransportFactory.js');
const { socketNotifier } = await import('../dist/socket/SocketNotifier.js');
const { customStdioRunnerService } = await import('../dist/mcp/core/CustomStdioRunnerService.js');

function makeServer(overrides = {}) {
  return {
    serverId: 'lazy-server',
    serverName: 'Lazy Server',
    enabled: true,
    allowUserInput: false,
    lazyStartEnabled: true,
    transportType: 'stdio',
    launchConfig: 'encrypted-launch-config',
    capabilities: '{}',
    configTemplate: '{}',
    category: ServerCategory.CustomStdio,
    authType: ServerAuthType.ApiKey,
    publicAccess: true,
    anonymousAccess: false,
    proxyId: 0,
    toolTmplId: null,
    usePetaOauthConfig: false,
    cachedTools: null,
    cachedResources: null,
    cachedResourceTemplates: null,
    cachedPrompts: null,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('ServerManager lazy start lifecycle', () => {
  const manager = ServerManager.instance;

  beforeAll(async () => {
    await Promise.resolve();
    manager.stopIdleCheck?.();
  });

  afterAll(() => {
    manager.stopIdleCheck?.();
  });

  beforeEach(() => {
    createdTransports.length = 0;
    clientConnectImpl = async () => {};

    findByServerId.mockReset();
    findEnabled.mockResolvedValue([]);
    updateServer.mockClear();
    findAllServers.mockResolvedValue([]);
    findUserById.mockReset();
    updateLaunchConfigs.mockReset();
    notifyUserPermissionChangedByServer.mockClear();
    transportFactoryCreate.mockReset();
    transportFactoryCreate.mockImplementation(async () => ({
      transport: createFakeTransport(),
      transportType: 'stdio',
    }));
    getUserFirstSession.mockReset();
    getSessionsUsingServer.mockReturnValue([]);

    manager.stopIdleCheck?.();
    manager.serverContexts.clear();
    manager.serverLoggers.clear();
    manager.temporaryServers.clear();
    manager.temporaryServerLoggers.clear();
    manager.resourceSubscriptions.clear();
    manager.serverWaitQueues.clear();
    manager.plannedTransportCloses = new WeakSet();
    manager.setOwnerToken('owner-token');
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ command: 'echo', args: [] }));
    manager.initializeAuthentication = jest.fn(async () => {});
    manager.updateServerCapabilities = jest.fn(async () => {});

    ServerRepository.findByServerId = findByServerId;
    ServerRepository.findEnabled = findEnabled;
    ServerRepository.update = updateServer;
    ServerRepository.findAll = findAllServers;
    SessionStore.instance = {
      getUserFirstSession,
      getSessionsUsingServer,
      getUserSessions: jest.fn().mockReturnValue([]),
    };
    DownstreamTransportFactory.create = transportFactoryCreate;
    socketNotifier.notifyUserPermissionChangedByServer = notifyUserPermissionChangedByServer;
    customStdioRunnerService.resolveLaunchPlan = (_serverEntity, launchConfig) => ({
      launchConfig,
      runnerMetadata: undefined,
    });
    customStdioRunnerService.attachExecutionTrace = () => undefined;
    customStdioRunnerService.buildFailureDetails = () => undefined;
  });

  test('keeps a lazy managed server context after unexpected close and wakes it again', async () => {
    const server = makeServer({ serverId: 'lazy-managed' });
    findByServerId.mockResolvedValue(server);

    const firstContext = await manager.ensureServerAvailable(server.serverId);
    expect(firstContext.status).toBe(ServerStatus.Online);
    expect(manager.getServerContext(server.serverId)).toBe(firstContext);

    const originalContextId = firstContext.id;
    createdTransports[0].onclose();

    expect(firstContext.status).toBe(ServerStatus.Sleeping);
    expect(manager.getServerContext(server.serverId)).toBe(firstContext);
    expect(firstContext.id).toBe(originalContextId);

    const secondContext = await manager.ensureServerAvailable(server.serverId);
    expect(secondContext).toBe(firstContext);
    expect(secondContext.status).toBe(ServerStatus.Online);
    expect(secondContext.id).toBe(originalContextId);
    expect(transportFactoryCreate).toHaveBeenCalledTimes(2);
  });

  test('restores a lazy temporary server from the active session launch config', async () => {
    const server = makeServer({
      serverId: 'lazy-temporary',
      allowUserInput: true,
    });
    findByServerId.mockResolvedValue(server);
    getUserFirstSession.mockReturnValue({
      token: 'user-token',
      launchConfigs: {
        [server.serverId]: { encrypted: true },
      },
    });

    const context = await manager.ensureServerAvailable(server.serverId, 'user-1');

    expect(context.status).toBe(ServerStatus.Online);
    expect(context.userId).toBe('user-1');
    expect(context.userToken).toBe('user-token');
    expect(manager.getTemporaryServer(server.serverId, 'user-1')).toBe(context);
  });

  test('keeps lazy servers retryable after startup failure', async () => {
    const server = makeServer({ serverId: 'lazy-retryable' });
    findByServerId.mockResolvedValue(server);
    clientConnectImpl = async () => {
      throw new Error('authentication failed');
    };

    await expect(manager.ensureServerAvailable(server.serverId)).rejects.toThrow('authentication failed');

    const context = manager.getServerContext(server.serverId);
    expect(context).toBeDefined();
    expect(context.status).toBe(ServerStatus.Sleeping);
    expect(context.lastError).toContain('authentication failed');

    await expect(manager.ensureServerAvailable(server.serverId)).rejects.toThrow('authentication failed');
    expect(transportFactoryCreate).toHaveBeenCalledTimes(2);
  });
});
