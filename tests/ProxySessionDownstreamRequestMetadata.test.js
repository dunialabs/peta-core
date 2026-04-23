import { jest } from '@jest/globals';

class FakeServer {
  constructor() {
    this.notificationHandlers = new Map();
    this.requestHandlers = new Map();
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

const ensureServerAvailable = jest.fn(async () => {});
const getServerContext = jest.fn();
const cleanupSessionSubscriptions = jest.fn(async () => {});
const generateUniformRequestId = jest.fn(() => 'uniform-1');
const logClientRequest = jest.fn(async () => {});
const policyEvaluate = jest.fn(async () => ({ decision: 'ALLOW' }));
const createdProxySessions = [];

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: FakeServer,
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: FakeTransport,
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: {
    instance: {
      ensureServerAvailable,
      getServerContext,
      cleanupSessionSubscriptions,
    },
  },
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      enqueueLog: jest.fn(),
      generateUniformRequestId,
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
  policyEngine: {
    evaluate: policyEvaluate,
  },
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
      resolveToolPolicy: jest.fn(() => null),
      resolveResourcePolicy: jest.fn(() => null),
      resolvePromptPolicy: jest.fn(() => null),
    },
  },
}));

const { ProxySession } = await import('../dist/mcp/core/ProxySession.js');

function createClientSession(overrides = {}) {
  return {
    authContext: {},
    userId: 'user-1',
    connectionInitialized: jest.fn(),
    resolveToolName: jest.fn(() => ({ serverID: 'server-1', originalName: 'tool-1' })),
    canUseTool: jest.fn(() => true),
    getDangerLevel: jest.fn(() => undefined),
    resolveResourceUri: jest.fn(() => ({
      serverID: 'server-1',
      originalName: 'resource://downstream',
    })),
    canAccessResource: jest.fn(() => true),
    parseName: jest.fn(() => ({ serverID: 'server-1', originalName: 'prompt-1' })),
    canUsePrompt: jest.fn(() => true),
    ...overrides,
  };
}

function createProxySession(clientSession) {
  const proxySession = new ProxySession(
    'session-1',
    'user-1',
    clientSession,
    { logClientRequest },
    {
      storeEvent: jest.fn(async () => 'event-1'),
      replayEventsAfter: jest.fn(async () => '_GET_stream'),
    },
    async () => {},
  );
  createdProxySessions.push(proxySession);
  return proxySession;
}

function createExtra(requestId = 'req-1') {
  return {
    requestId,
    signal: new AbortController().signal,
    sendNotification: async () => undefined,
    sendRequest: async () => undefined,
  };
}

describe('ProxySession downstream request metadata', () => {
  afterEach(async () => {
    await Promise.all(createdProxySessions.splice(0).map((proxySession) => proxySession.cleanup()));
  });

  beforeEach(() => {
    ensureServerAvailable.mockClear();
    getServerContext.mockReset();
    cleanupSessionSubscriptions.mockClear();
    generateUniformRequestId.mockClear();
    logClientRequest.mockClear();
    policyEvaluate.mockClear();
  });

  test('tool calls rewrite progressToken to proxyRequestId while preserving other _meta fields', async () => {
    const connection = {
      callTool: jest.fn(async () => ({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      })),
    };
    const serverContext = {
      connection,
      capabilitiesConfig: {},
      serverEntity: { serverId: 'server-1' },
      getDangerLevel: jest.fn(() => undefined),
      clearTimeout: jest.fn(),
      recordTimeout: jest.fn(async () => false),
    };
    const clientSession = createClientSession();
    const proxySession = createProxySession(clientSession);
    const request = {
      method: 'tools/call',
      params: {
        name: 'custom-tool',
        arguments: { x: 1 },
        _meta: { clientTag: 'keep-me', progressToken: 'client-progress-1' },
      },
    };

    getServerContext.mockReturnValue(serverContext);

    await proxySession.handleToolCall(request, createExtra());

    expect(connection.callTool).toHaveBeenCalledTimes(1);
    const relatedRequestId = connection.callTool.mock.calls[0][2].relatedRequestId;
    expect(relatedRequestId).toMatch(/^session-1:req-1:\d+$/);
    expect(connection.callTool.mock.calls[0][0]).toEqual({
      name: 'tool-1',
      arguments: { x: 1 },
      _meta: { clientTag: 'keep-me', progressToken: relatedRequestId },
    });
    expect(connection.callTool.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        relatedRequestId,
      }),
    );
    expect(request.params._meta).toEqual({ clientTag: 'keep-me', progressToken: 'client-progress-1' });
  });

  test('resource reads rewrite progressToken to proxyRequestId while preserving other _meta fields', async () => {
    const connection = {
      readResource: jest.fn(async () => ({
        contents: [],
      })),
    };
    const serverContext = {
      connection,
      capabilitiesConfig: {},
      serverEntity: { serverId: 'server-1' },
      clearTimeout: jest.fn(),
      recordTimeout: jest.fn(async () => false),
    };
    const clientSession = createClientSession();
    const proxySession = createProxySession(clientSession);
    const request = {
      method: 'resources/read',
      params: {
        uri: 'gateway://resource',
        _meta: { clientTag: 'keep-me', progressToken: 'client-progress-2' },
      },
    };

    getServerContext.mockReturnValue(serverContext);

    await proxySession.handleResourceRead(request, createExtra());

    expect(connection.readResource).toHaveBeenCalledTimes(1);
    const relatedRequestId = connection.readResource.mock.calls[0][1].relatedRequestId;
    expect(relatedRequestId).toMatch(/^session-1:req-1:\d+$/);
    expect(connection.readResource.mock.calls[0][0]).toEqual({
      uri: 'resource://downstream',
      _meta: { clientTag: 'keep-me', progressToken: relatedRequestId },
    });
    expect(connection.readResource.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        relatedRequestId,
      }),
    );
    expect(request.params._meta).toEqual({ clientTag: 'keep-me', progressToken: 'client-progress-2' });
  });

  test('prompt gets rewrite progressToken to proxyRequestId while preserving other _meta fields', async () => {
    const connection = {
      getPrompt: jest.fn(async () => ({
        description: 'Prompt',
        messages: [],
      })),
    };
    const serverContext = {
      connection,
      capabilitiesConfig: {},
      serverEntity: { serverId: 'server-1' },
      clearTimeout: jest.fn(),
      recordTimeout: jest.fn(async () => false),
    };
    const clientSession = createClientSession();
    const proxySession = createProxySession(clientSession);
    const request = {
      method: 'prompts/get',
      params: {
        name: 'gateway://prompt',
        arguments: { topic: 'test' },
        _meta: { clientTag: 'keep-me', progressToken: 'client-progress-3' },
      },
    };

    getServerContext.mockReturnValue(serverContext);

    await proxySession.handlePromptGet(request, createExtra());

    expect(connection.getPrompt).toHaveBeenCalledTimes(1);
    const relatedRequestId = connection.getPrompt.mock.calls[0][1].relatedRequestId;
    expect(relatedRequestId).toMatch(/^session-1:req-1:\d+$/);
    expect(connection.getPrompt.mock.calls[0][0]).toEqual({
      name: 'prompt-1',
      arguments: { topic: 'test' },
      _meta: { clientTag: 'keep-me', progressToken: relatedRequestId },
    });
    expect(connection.getPrompt.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        relatedRequestId,
      }),
    );
    expect(request.params._meta).toEqual({ clientTag: 'keep-me', progressToken: 'client-progress-3' });
  });

  test('completion rewrites progressToken to proxyRequestId while preserving other _meta fields', async () => {
    const connection = {
      complete: jest.fn(async () => ({
        completion: { values: ['ok'] },
      })),
    };
    const serverContext = {
      connection,
      capabilitiesConfig: {},
      serverEntity: { serverId: 'server-1' },
      clearTimeout: jest.fn(),
      recordTimeout: jest.fn(async () => false),
    };
    const clientSession = createClientSession();
    const proxySession = createProxySession(clientSession);
    const request = {
      method: 'completion/complete',
      params: {
        ref: { type: 'ref/prompt', name: 'gateway://prompt' },
        argument: { name: 'topic', value: 'test' },
        _meta: { clientTag: 'keep-me', progressToken: 'client-progress-4' },
      },
    };

    getServerContext.mockReturnValue(serverContext);

    await proxySession.handleComplete(request, createExtra());

    expect(connection.complete).toHaveBeenCalledTimes(1);
    const relatedRequestId = connection.complete.mock.calls[0][1].relatedRequestId;
    expect(relatedRequestId).toMatch(/^session-1:req-1:\d+$/);
    expect(connection.complete.mock.calls[0][0]).toEqual({
      ref: { type: 'ref/prompt', name: 'prompt-1' },
      argument: { name: 'topic', value: 'test' },
      _meta: { clientTag: 'keep-me', progressToken: relatedRequestId },
    });
    expect(connection.complete.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        relatedRequestId,
      }),
    );
    expect(request.params._meta).toEqual({ clientTag: 'keep-me', progressToken: 'client-progress-4' });
  });

  test('tool calls do not inject progressToken when client did not provide one', async () => {
    const connection = {
      callTool: jest.fn(async () => ({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      })),
    };
    const serverContext = {
      connection,
      capabilitiesConfig: {},
      serverEntity: { serverId: 'server-1' },
      getDangerLevel: jest.fn(() => undefined),
      clearTimeout: jest.fn(),
      recordTimeout: jest.fn(async () => false),
    };
    const clientSession = createClientSession();
    const proxySession = createProxySession(clientSession);
    const request = {
      method: 'tools/call',
      params: {
        name: 'custom-tool',
        arguments: { x: 1 },
        _meta: { clientTag: 'keep-me' },
      },
    };

    getServerContext.mockReturnValue(serverContext);

    await proxySession.handleToolCall(request, createExtra());

    expect(connection.callTool).toHaveBeenCalledTimes(1);
    expect(connection.callTool.mock.calls[0][0]).toEqual({
      name: 'tool-1',
      arguments: { x: 1 },
      _meta: { clientTag: 'keep-me' },
    });
  });
});
