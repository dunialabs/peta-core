import { jest } from '@jest/globals';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

process.env.MCP_2026_ENABLED = 'true';
process.env.MCP_2026_DOWNSTREAM_ENABLED = 'true';

const findEnabled = jest.fn().mockResolvedValue([]);
const findByServerId = jest.fn();
const updateServer = jest.fn(async (serverId, data) => ({ serverId, ...data }));
const updateCapabilities = jest.fn(async () => {});
const findAllServers = jest.fn().mockResolvedValue([]);
const transportFactoryCreate = jest.fn();
const modernConnect = jest.fn();
const loggerError = jest.fn();
let legacyServerInfo;

class FakeClient {
  async connect(transport) {
    this.transport = transport;
  }

  async ping() {}
  async close() {}
  getServerVersion() { return legacyServerInfo; }
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
    updateCapabilities,
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
    detectTransportType: (config) => config.type ?? (config.mcpProtocol === 'modern' && config.url ? 'http' : (config.url ? 'http' : 'stdio')),
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
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: loggerError, fatal: jest.fn() }),
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
const { LogService } = await import('../dist/log/LogService.js');
const { ServerStatus, ServerCategory, ServerAuthType } = await import('../dist/types/enums.js');
const updateServerCapabilities = ServerManager.prototype.updateServerCapabilities;

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
    manager.plannedTransportCloses = new WeakSet();
    manager.setOwnerToken('owner-token');
    manager.initializeAuthentication = jest.fn(async () => {});
    manager.updateServerCapabilities = jest.fn(async () => {});
    findByServerId.mockReset();
    findAllServers.mockReset().mockResolvedValue([]);
    updateServer.mockClear();
    updateCapabilities.mockClear();
    loggerError.mockClear();
    transportFactoryCreate.mockReset();
    modernConnect.mockReset();
    modernConnect.mockResolvedValue(fakeModernClient());
    legacyServerInfo = undefined;
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

  test('treats a blank config template as absent during capability synchronization', async () => {
    const server = makeServer({ configTemplate: '   ' });
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'modern' }));

    const context = await manager.addServer(server, 'owner-token');
    context.connection.listTools = jest.fn(async () => undefined);
    loggerError.mockClear();

    await updateServerCapabilities.call(manager, context);

    expect(loggerError).not.toHaveBeenCalledWith(expect.anything(), 'Invalid configTemplate JSON');
    expect(updateCapabilities).toHaveBeenCalledWith(
      server.serverId,
      JSON.stringify({ tools: {}, resources: {}, prompts: {} }),
    );
  });

  test.each(['/sse', '/events'])('uses modern HTTP downstream client for an explicit modern endpoint at %s', async (path) => {
    const server = makeServer();
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({
      url: `https://downstream.example${path}`,
      mcpProtocol: 'modern',
    }));

    const context = await manager.addServer(server, 'owner-token');

    expect(modernConnect).toHaveBeenCalledWith(expect.objectContaining({
      url: new URL(`https://downstream.example${path}`),
    }));
    expect(transportFactoryCreate).not.toHaveBeenCalled();
    expect(context.connection.protocolEra).toBe('modern');
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

  test('does not fall back when auto probe receives a recognized modern JSON-RPC error', async () => {
    const server = makeServer();
    modernConnect.mockRejectedValueOnce(new McpError(-32022, 'Unsupported protocol version'));
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'auto' }));

    await expect(manager.addServer(server, 'owner-token')).rejects.toThrow('Unsupported protocol version');
    expect(transportFactoryCreate).not.toHaveBeenCalled();
  });

  test('falls back when auto probe receives a legacy-compatible JSON-RPC method error', async () => {
    const server = makeServer();
    modernConnect.mockRejectedValueOnce(new McpError(-32601, 'Method not found'));
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'auto' }));

    const context = await manager.addServer(server, 'owner-token');

    expect(transportFactoryCreate).toHaveBeenCalledTimes(1);
    expect(context.connection.protocolEra).toBe('legacy');
  });

  test('keeps a modern connection Connecting until capability synchronization succeeds', async () => {
    const server = makeServer();
    let finishSync;
    const synchronization = new Promise((resolve) => { finishSync = resolve; });
    manager.updateServerCapabilities = jest.fn(() => synchronization);
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'modern' }));

    const connection = manager.addServer(server, 'owner-token');
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.getServerContext(server.serverId).status).toBe(ServerStatus.Connecting);
    finishSync();
    await expect(connection).resolves.toMatchObject({ status: ServerStatus.Online });
  });

  test('passes the current OAuth token as a bearer header to a modern connection', async () => {
    const server = makeServer({ category: ServerCategory.Template, authType: ServerAuthType.SlackAuth });
    manager.initializeAuthentication = jest.fn(async (context) => {
      context.currentTokenInfo = { accessToken: 'fresh-token', expiresAt: Date.now() + 60_000, expiresIn: 60 };
    });
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'modern' }));

    await manager.addServer(server, 'owner-token');

    expect(modernConnect).toHaveBeenCalledWith(expect.objectContaining({
      headers: { Authorization: 'Bearer fresh-token' },
    }));
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

  test('rejects explicit modern protocol when an explicit SSE transport is configured', async () => {
    const server = makeServer();
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({
      type: 'sse',
      url: 'https://downstream.example/events',
      mcpProtocol: 'modern',
    }));

    await expect(manager.addServer(server, 'owner-token')).rejects.toThrow('launchConfig.mcpProtocol=modern is only supported for HTTP downstream servers');
    expect(modernConnect).not.toHaveBeenCalled();
    expect(transportFactoryCreate).not.toHaveBeenCalled();
  });

  test('preserves the configured name when a modern downstream reports a different name', async () => {
    const server = makeServer({ serverName: 'Operator Name' });
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'modern' }));

    const context = await manager.addServer(server, 'owner-token');

    expect(context.serverEntity.serverName).toBe('Operator Name');
  });

  test('fills a blank configured name from modern downstream metadata', async () => {
    const server = makeServer({ serverName: '   ' });
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'modern' }));

    const context = await manager.addServer(server, 'owner-token');

    expect(context.serverEntity.serverName).toBe('Modern Downstream');
    expect(updateServer).toHaveBeenCalledWith('protocol-server', { serverName: 'Modern Downstream' });
  });

  test('preserves the configured name when a legacy downstream reports a different name', async () => {
    const server = makeServer({ serverName: 'Operator Name', transportType: 'http' });
    legacyServerInfo = { name: 'Legacy Downstream', version: '1.0.0' };
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'legacy' }));

    const context = await manager.addServer(server, 'owner-token');

    expect(context.serverEntity.serverName).toBe('Operator Name');
  });

  test('fills a blank configured name from legacy downstream metadata', async () => {
    const server = makeServer({ serverName: '', transportType: 'http' });
    legacyServerInfo = { name: 'Legacy Downstream', version: '1.0.0' };
    manager.decryptLaunchConfig = jest.fn(async () => JSON.stringify({ url: 'https://downstream.example/mcp', mcpProtocol: 'legacy' }));

    const context = await manager.addServer(server, 'owner-token');

    expect(context.serverEntity.serverName).toBe('Legacy Downstream');
    expect(updateServer).toHaveBeenCalledWith('protocol-server', { serverName: 'Legacy Downstream' });
  });

  test('keys health status by server ID when configured names are duplicated', async () => {
    findAllServers.mockResolvedValue([
      makeServer({ serverId: 'server-a', serverName: 'Shared Name' }),
      makeServer({ serverId: 'server-b', serverName: 'Shared Name' }),
    ]);
    manager.serverContexts.set('server-a', { status: ServerStatus.Online });
    manager.serverContexts.set('server-b', { status: ServerStatus.Online });

    await expect(manager.getAllServersStatus()).resolves.toEqual({
      'server-a': 'Online',
      'server-b': 'Online',
    });
  });

  test('keys personal server health by server ID when configured names are duplicated', async () => {
    findAllServers.mockResolvedValue([
      makeServer({ serverId: 'server-a', serverName: 'Shared Name', allowUserInput: true }),
      makeServer({ serverId: 'server-b', serverName: 'Shared Name', allowUserInput: true }),
    ]);
    manager.temporaryServers.set('server-a:user-1', {
      serverEntity: { serverId: 'server-a' },
      status: ServerStatus.Online,
    });
    manager.temporaryServers.set('server-b:user-2', {
      serverEntity: { serverId: 'server-b' },
      status: ServerStatus.Online,
    });

    await expect(manager.getAllServersStatus()).resolves.toEqual({
      'server-a': 'Online(1)',
      'server-b': 'Online(1)',
    });
  });

  test('reports rejected managed connections as failed servers', async () => {
    const server = makeServer({ serverId: 'failed-server' });
    const originalCreateServerConnection = manager.createServerConnection;
    findEnabled.mockResolvedValueOnce([server]);
    manager.createServerConnection = jest.fn(async () => { throw new Error('connection failed'); });

    try {
      await expect(manager.connectAllServers('owner-token')).resolves.toEqual({
        successServers: [],
        failedServers: [{ serverId: 'failed-server', serverName: 'Protocol Server', proxyId: 0 }],
      });
    } finally {
      manager.createServerConnection = originalCreateServerConnection;
    }
  });

  test('reports managed servers whose context initialization fails as failed servers', async () => {
    const server = makeServer({ serverId: 'init-failed-server' });
    const originalInitializeManagedServerContext = manager.initializeManagedServerContext;
    findEnabled.mockResolvedValueOnce([server]);
    manager.initializeManagedServerContext = jest.fn(() => {
      throw new Error('context initialization failed');
    });

    try {
      await expect(manager.connectAllServers('owner-token')).resolves.toEqual({
        successServers: [],
        failedServers: [{ serverId: 'init-failed-server', serverName: 'Protocol Server', proxyId: 0 }],
      });
    } finally {
      manager.initializeManagedServerContext = originalInitializeManagedServerContext;
    }
  });
});
