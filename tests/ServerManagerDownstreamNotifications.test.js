import { jest } from '@jest/globals';
import {
  CancelledNotificationSchema,
  ProgressNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

const findEnabled = jest.fn().mockResolvedValue([]);
const findByServerId = jest.fn();
const updateServer = jest.fn(async (serverId, data) => ({ serverId, ...data }));
const findAllServers = jest.fn().mockResolvedValue([]);
const findUserById = jest.fn();
const updateLaunchConfigs = jest.fn();
const transportFactoryCreate = jest.fn();
const getUserFirstSession = jest.fn();
const getSessionsUsingServer = jest.fn().mockReturnValue([]);
const getProxySession = jest.fn();

const createdClients = [];

function createFakeTransport() {
  return {
    onclose: undefined,
    send: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
  };
}

class FakeClient {
  constructor(_clientInfo, options) {
    this.options = options;
    this.requestHandlers = new Map();
    this.notificationHandlers = new Map();
    createdClients.push(this);
  }

  async connect(transport) {
    this.transport = transport;
  }

  async ping() {}

  async close() {}

  getServerVersion() {
    return undefined;
  }

  getServerCapabilities() {
    return {};
  }

  setRequestHandler(schema, handler) {
    this.requestHandlers.set(schema, handler);
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
      getProxySession,
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
const { ServerStatus, ServerCategory, ServerAuthType } = await import('../dist/types/enums.js');
const { ServerRepository } = await import('../dist/repositories/ServerRepository.js');
const { SessionStore } = await import('../dist/mcp/core/SessionStore.js');
const { DownstreamTransportFactory } = await import('../dist/mcp/core/DownstreamTransportFactory.js');

function makeServer(overrides = {}) {
  return {
    serverId: 'server-1',
    serverName: 'Test Server',
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

describe('ServerManager downstream notification boundary', () => {
  const manager = ServerManager.instance;

  beforeAll(async () => {
    await Promise.resolve();
    manager.stopIdleCheck?.();
  });

  afterAll(() => {
    manager.stopIdleCheck?.();
  });

  beforeEach(() => {
    createdClients.length = 0;
    findByServerId.mockReset();
    findEnabled.mockResolvedValue([]);
    updateServer.mockClear();
    findAllServers.mockResolvedValue([]);
    findUserById.mockReset();
    updateLaunchConfigs.mockReset();
    transportFactoryCreate.mockReset();
    transportFactoryCreate.mockImplementation(async () => ({
      transport: createFakeTransport(),
      transportType: 'stdio',
    }));
    getUserFirstSession.mockReset();
    getSessionsUsingServer.mockReturnValue([]);
    getProxySession.mockReset();

    manager.stopIdleCheck?.();
    manager.serverContexts.clear();
    manager.serverLoggers.clear();
    manager.temporaryServers.clear();
    manager.temporaryServerLoggers.clear();
    manager.resourceSubscriptions.clear();
    manager.serverWaitQueues.clear();
    manager.plannedTransportCloses = new WeakSet();
    manager.globalRouter = {
      handleToolsListChanged: jest.fn(),
      handleResourcesListChanged: jest.fn(),
      handleResourceUpdated: jest.fn(async () => {}),
      handlePromptsListChanged: jest.fn(),
    };
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
      getProxySession,
    };
    DownstreamTransportFactory.create = transportFactoryCreate;
  });

  test('managed connections keep reverse-request capabilities disabled and register only supported notifications', async () => {
    const server = makeServer({ serverId: 'managed-server' });
    const fakeProxySession = {
      forwardCancellationToClient: jest.fn(async () => {}),
      forwardProgressToClient: jest.fn(async () => {}),
    };
    const resourceUpdatedNotification = { params: { uri: 'resource://updated' } };

    getProxySession.mockImplementation((sessionId) =>
      sessionId === 'session-1' ? fakeProxySession : undefined,
    );
    findByServerId.mockResolvedValue(server);

    const context = await manager.ensureServerAvailable(server.serverId);
    const createdClient = createdClients[0];

    expect(createdClient.options.capabilities).toEqual({});
    expect(createdClient.requestHandlers.size).toBe(0);
    expect(createdClient.notificationHandlers.has(CancelledNotificationSchema)).toBe(true);
    expect(createdClient.notificationHandlers.has(ProgressNotificationSchema)).toBe(true);
    expect(createdClient.notificationHandlers.has(ResourceUpdatedNotificationSchema)).toBe(true);

    await createdClient.notificationHandlers.get(CancelledNotificationSchema)({
      params: { requestId: 'session-1:req-1:123' },
    });
    expect(fakeProxySession.forwardCancellationToClient).toHaveBeenCalledWith({
      params: { requestId: 'session-1:req-1:123' },
    });

    await createdClient.notificationHandlers.get(ProgressNotificationSchema)({
      params: { progressToken: 'session-1:req-1:123', progress: 50 },
    });
    expect(fakeProxySession.forwardProgressToClient).toHaveBeenCalledWith({
      params: { progressToken: 'session-1:req-1:123', progress: 50 },
    });

    await createdClient.notificationHandlers.get(ResourceUpdatedNotificationSchema)(
      resourceUpdatedNotification,
    );
    expect(manager.globalRouter.handleResourceUpdated).toHaveBeenCalledWith(
      server.serverId,
      resourceUpdatedNotification,
      context.id,
    );
    expect(context.status).toBe(ServerStatus.Online);
  });

  test('temporary connections also keep reverse-request capabilities disabled', async () => {
    const server = makeServer({
      serverId: 'temporary-server',
      allowUserInput: true,
      lazyStartEnabled: false,
    });

    await manager.createTemporaryServer('user-1', server, 'user-token');

    expect(createdClients).toHaveLength(1);
    expect(createdClients[0].options.capabilities).toEqual({});
    expect(createdClients[0].requestHandlers.size).toBe(0);
    expect(createdClients[0].notificationHandlers.has(CancelledNotificationSchema)).toBe(true);
    expect(createdClients[0].notificationHandlers.has(ProgressNotificationSchema)).toBe(true);
    expect(createdClients[0].notificationHandlers.has(ResourceUpdatedNotificationSchema)).toBe(
      true,
    );
  });
});
