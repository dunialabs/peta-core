import { jest } from '@jest/globals';

class FakeServer {
  static instances = [];

  constructor() {
    this.notificationHandlers = new Map();
    this.requestHandlers = new Map();
    this.notification = jest.fn(async () => {});
    FakeServer.instances.push(this);
  }

  async connect(transport) {
    this.transport = transport;
  }

  setRequestHandler(schema, handler) {
    this.requestHandlers.set(schema, handler);
  }

  setNotificationHandler(schema, handler) {
    this.notificationHandlers.set(schema, handler);
  }

  getClientCapabilities() {
    return undefined;
  }

  getClientVersion() {
    return undefined;
  }

  async close() {}

  async ping() {
    return {};
  }
}

class FakeTransport {
  constructor(options) {
    this.options = options;
  }

  async handleRequest() {}
}

const getServerContext = jest.fn();
const cleanupSessionSubscriptions = jest.fn(async () => {});

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: FakeServer,
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: FakeTransport,
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: {
    instance: {
      ensureServerAvailable: jest.fn(async () => {}),
      getServerContext,
      cleanupSessionSubscriptions,
    },
  },
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      enqueueLog: jest.fn(),
      generateUniformRequestId: jest.fn(() => 'uniform-1'),
    }),
  },
}));

jest.unstable_mockModule('../dist/config/config.js', () => ({
  APP_INFO: {
    name: 'peta-core-test',
    version: '1.0.0-test',
  },
}));

jest.unstable_mockModule('../dist/socket/SocketNotifier.js', () => ({
  socketNotifier: {},
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

jest.unstable_mockModule('../dist/mcp/services/PolicyEngine.js', () => ({
  policyEngine: {},
}));

jest.unstable_mockModule('../dist/mcp/services/ApprovalService.js', () => ({
  approvalService: {},
  ApprovalRateLimitError: class ApprovalRateLimitError extends Error {},
}));

jest.unstable_mockModule('../dist/mcp/services/DiscoveryNativeToolHandlers.js', () => ({
  handleCatalogSearch: jest.fn(),
  handleCatalogDescribe: jest.fn(),
  handleCatalogExecute: jest.fn(),
}));

jest.unstable_mockModule('../dist/mcp/services/DiscoveryConfigService.js', () => ({
  discoveryConfigService: {
    getActiveProfile: jest.fn(async () => null),
  },
}));

jest.unstable_mockModule('../dist/mcp/core/cache/ResultCacheService.js', () => ({
  ResultCacheService: {
    instance: {
      enabled: false,
    },
  },
}));

const { ProxySession } = await import('../dist/mcp/core/ProxySession.js');

function createProxySession() {
  return new ProxySession(
    'session-1',
    'user-1',
    {
      authContext: {},
      userId: 'user-1',
      connectionInitialized: jest.fn(),
      getAvailableServers: jest.fn(() => []),
    },
    { logClientRequest: jest.fn(async () => {}) },
    {
      storeEvent: jest.fn(async () => 'event-1'),
      replayEventsAfter: jest.fn(async () => '_GET_stream'),
    },
    async () => {},
  );
}

describe('ProxySession progress and cancellation routing', () => {
  let proxySession;

  afterEach(async () => {
    FakeServer.instances.length = 0;
    getServerContext.mockReset();
    cleanupSessionSubscriptions.mockClear();

    if (proxySession) {
      await proxySession.cleanup();
      proxySession = undefined;
    }
  });

  test('forwardProgressToClient restores the original progress token', async () => {
    proxySession = createProxySession();
    const upstreamServer = FakeServer.instances[0];
    const proxyRequestId = proxySession.requestIdMapper.registerClientRequest(
      7,
      'tools/call',
      'server-1',
    );
    proxySession.requestIdMapper.setOriginalProgressToken(proxyRequestId, 'client-progress-1');

    await proxySession.forwardProgressToClient({
      params: {
        progressToken: proxyRequestId,
        progress: 50,
      },
    });

    expect(upstreamServer.notification).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          progressToken: 'client-progress-1',
          progress: 50,
        }),
      }),
      expect.objectContaining({
        relatedRequestId: 7,
      }),
    );
  });

  test('handleCancelledNotification forwards downstream request id for numeric client request ids', async () => {
    const downstreamClient = {
      notification: jest.fn(async () => {}),
    };
    getServerContext.mockReturnValue({
      connection: downstreamClient,
    });

    proxySession = createProxySession();
    const proxyRequestId = proxySession.requestIdMapper.registerClientRequest(
      7,
      'tools/call',
      'server-1',
    );
    proxySession.registerDownstreamRequestId(proxyRequestId, 42, 'server-1');

    await proxySession.handleCancelledNotification({
      params: {
        requestId: 7,
        reason: 'client_cancelled',
      },
    });

    expect(downstreamClient.notification).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          requestId: 42,
        }),
      }),
      expect.objectContaining({
        relatedRequestId: proxyRequestId,
      }),
    );
  });
});
