import { jest } from '@jest/globals';

const transportHandleRequest = jest.fn(async () => {});
const createdTransportOptions = [];

class FakeServer {
  static instances = [];

  constructor() {
    this.notificationHandlers = new Map();
    this.requestHandlers = new Map();
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
    return { roots: { listChanged: true } };
  }

  getClientVersion() {
    return { name: 'test-client', version: '1.0.0' };
  }

  async close() {}

  async ping() {
    return {};
  }
}

class FakeTransport {
  constructor(options) {
    this.options = options;
    createdTransportOptions.push(options);
  }

  async handleRequest(req, res, body) {
    return transportHandleRequest(req, res, body);
  }
}

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: FakeServer,
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: FakeTransport,
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: {
    instance: {
      cleanupSessionSubscriptions: jest.fn(async () => {}),
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

describe('ProxySession transport resumability wiring', () => {
  beforeEach(() => {
    transportHandleRequest.mockClear();
    createdTransportOptions.length = 0;
    FakeServer.instances.length = 0;
  });

  test('passes eventStore into StreamableHTTPServerTransport during initialize', async () => {
    const eventStore = {
      storeEvent: jest.fn(async () => 'event-1'),
      getStreamIdForEventId: jest.fn(async () => '_GET_stream'),
      replayEventsAfter: jest.fn(async () => '_GET_stream'),
    };

    const proxySession = new ProxySession(
      'session-1',
      'user-1',
      {
        authContext: {},
        connectionInitialized: jest.fn(),
      },
      {},
      eventStore,
      async () => {},
    );

    const initializeRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    };

    await proxySession.handleRequest(
      { method: 'POST', body: initializeRequest },
      {},
      initializeRequest,
    );

    expect(createdTransportOptions).toHaveLength(1);
    expect(createdTransportOptions[0].eventStore).toBe(eventStore);
    expect(transportHandleRequest).toHaveBeenCalledWith(
      expect.objectContaining({ body: initializeRequest }),
      {},
      initializeRequest,
    );
  });

  test('populates client metadata from Server.oninitialized instead of transport session callback', async () => {
    const eventStore = {
      storeEvent: jest.fn(async () => 'event-1'),
      getStreamIdForEventId: jest.fn(async () => '_GET_stream'),
      replayEventsAfter: jest.fn(async () => '_GET_stream'),
    };
    const clientSession = {
      authContext: {},
      capabilities: undefined,
      clientInfo: undefined,
      connectionInitialized: jest.fn(),
    };

    const proxySession = new ProxySession(
      'session-1',
      'user-1',
      clientSession,
      {},
      eventStore,
      async () => {},
    );

    const initializeRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    };

    await proxySession.handleRequest(
      { method: 'POST', body: initializeRequest },
      {},
      initializeRequest,
    );

    await createdTransportOptions[0].onsessioninitialized('session-1');
    expect(clientSession.capabilities).toBeUndefined();
    expect(clientSession.clientInfo).toBeUndefined();
    expect(clientSession.connectionInitialized).not.toHaveBeenCalled();

    FakeServer.instances[0].oninitialized();
    expect(clientSession.capabilities).toEqual({ roots: { listChanged: true } });
    expect(clientSession.clientInfo).toEqual({ name: 'test-client', version: '1.0.0' });
    expect(clientSession.connectionInitialized).toHaveBeenCalledWith(FakeServer.instances[0]);
  });
});
