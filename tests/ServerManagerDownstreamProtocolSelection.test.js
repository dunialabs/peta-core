import { jest } from '@jest/globals';

process.env.MCP_2026_ENABLED = 'true';
process.env.MCP_2026_DOWNSTREAM_ENABLED = 'true';

const findEnabled = jest.fn().mockResolvedValue([]);
const findByServerId = jest.fn();
const updateServer = jest.fn(async (serverId, data) => ({ serverId, ...data }));
const findAllServers = jest.fn().mockResolvedValue([]);
const transportFactoryCreate = jest.fn();
const modernConnect = jest.fn();

class FakeClient {
  async connect(transport) {
    this.transport = transport;
  }

  async ping() {}
  async close() {}
  getServerVersion() { return undefined; }
  getServerCapabilities() { return {}; }
  setNotificationHandler() {}
  async listTools() { return { tools: [] }; }
  async listResources() { return { resources: [] }; }
  async listResourceTemplates() { return { resourceTemplates: [] }; }
  async listPrompts() { return { prompts: [] }; }
}

function fakeModernClient() {
  return {
    protocolEra: 'modern',
    getServerVersion: () => ({ name: 'Modern Downstream', version: '1.0.0' }),
    getServerCapabilities: () => ({}),
    setNotificationHandler: jest.fn(),
    ping: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
  };
}

jest.unstable_mockModule('../dist/repositories/ServerRepository.js', () => ({
  ServerRepository: {
    findEnabled,
    findByServerId,
    update: updateServer,
    findAll: findAllServers,
    updateCapabilities: jest.fn(async () => {}),
  },
}));

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({
  UserRepository: {
    findById: jest.fn(),
    updateLaunchConfigs: jest.fn(),
  },
}));

jest.unstable_mockModule('../dist/mcp/core/DownstreamTransportFactory.js', () => ({
  DownstreamTransportFactory: {
    detectTransportType: (config) => config.type ?? (config.url ? 'http' : 'stdio'),
    create: transportFactoryCreate,
    canFallbackHttpToSse: jest.fn(() => false),
    createSSEFallbackTransport: jest.fn(),
  },
}));

jest.unstable_mockModule('../dist/mcp/core/ModernHttpDownstreamClient.js', () => ({
  ModernHttpDownstreamClient: { connect: modernConnect },
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: FakeClient,
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
    notifyUserPermissionChangedByServer: jest.fn(),
  },
}));

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/mcp/core/CustomStdioRunnerService.js', () => ({
  customStdioRunnerService: {
    resolveLaunchPlan: (_serverEntity, launchConfig) => ({ launchConfig, runnerMetadata: undefined }),
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

function makeServer(overrides = {}) {
  return {
    serverId: 'protocol-server',
    serverName: 'Protocol Server',
    enabled: true,
    allowUserInput: false,
    lazyStartEnabled: false,
    transportType: null,
    launchConfig: 'encrypted-launch-config',
    capabilities: '{}',
    configTemplate: '{}',
    category: ServerCategory.CustomRemote,
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

describe('ServerManager downstream protocol selection', () => {
  const manager = ServerManager.instance;

  beforeEach(() => {
    manager.stopIdleCheck?.();
    manager.serverContexts.clear();
    manager.serverLoggers.clear();
    manager.temporaryServers.clear();
    manager.temporaryServerLoggers.clear();
    manager.resourceSubscriptions.clear();
    manager.serverWaitQueues.clear();
    manager.plannedTransportCloses = new WeakSet();
    manager.setOwnerToken('owner-token');
    manager.initializeAuthentication = jest.fn(async () => {});
    manager.updateServerCapabilities = jest.fn(async () => {});
    findByServerId.mockReset();
    updateServer.mockClear();
    transportFactoryCreate.mockReset();
    modernConnect.mockReset();
    modernConnect.mockResolvedValue(fakeModernClient());
    transportFactoryCreate.mockResolvedValue({
      transport: { send: jest.fn(async () => {}), close: jest.fn(async () => {}) },
      transportType: 'http',
    });
  });

  test('uses modern HTTP downstream client when auto probe succeeds', async () => {
    const server = makeServer();
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'auto' }));

    const context = await manager.addServer(server, 'owner-token');

    expect(modernConnect).toHaveBeenCalledTimes(1);
    expect(transportFactoryCreate).not.toHaveBeenCalled();
    expect(context.connection.protocolEra).toBe('modern');
    expect(context.status).toBe(ServerStatus.Online);
  });

  test('does not probe modern downstream when launch config forces legacy', async () => {
    const server = makeServer();
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'legacy' }));

    const context = await manager.addServer(server, 'owner-token');

    expect(modernConnect).not.toHaveBeenCalled();
    expect(transportFactoryCreate).toHaveBeenCalledTimes(1);
    expect(context.connection.protocolEra).toBe('legacy');
  });

  test('falls back to legacy HTTP when auto modern probe fails', async () => {
    const server = makeServer();
    modernConnect.mockRejectedValueOnce(new Error('404 not found'));
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'auto' }));

    const context = await manager.addServer(server, 'owner-token');

    expect(modernConnect).toHaveBeenCalledTimes(1);
    expect(transportFactoryCreate).toHaveBeenCalledTimes(1);
    expect(context.connection.protocolEra).toBe('legacy');
  });

  test('does not fall back when explicit modern downstream probe fails', async () => {
    const server = makeServer();
    modernConnect.mockRejectedValueOnce(new Error('modern failed'));
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'modern' }));

    await expect(manager.addServer(server, 'owner-token')).rejects.toThrow('modern failed');
    expect(transportFactoryCreate).not.toHaveBeenCalled();
  });

  test('rejects explicit modern protocol on non-http transports', async () => {
    const server = makeServer({ category: ServerCategory.CustomStdio });
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ command: 'node', args: ['server.js'], mcpProtocol: 'modern' }));

    await expect(manager.addServer(server, 'owner-token')).rejects.toThrow('launchConfig.mcpProtocol=modern is only supported for HTTP downstream servers');
    expect(modernConnect).not.toHaveBeenCalled();
    expect(transportFactoryCreate).not.toHaveBeenCalled();
  });
});
