import { jest } from '@jest/globals';

const serverManagerInstance = {
  availableServers: [],
  contexts: new Map(),
  subscribed: [],
  unsubscribed: [],
  getAvailableServers: jest.fn(() => serverManagerInstance.availableServers),
  getServerContext: jest.fn((serverId) => serverManagerInstance.contexts.get(serverId)),
  getServerContextByID: jest.fn((contextId) => serverManagerInstance.availableServers.find((server) => server.id === contextId)),
  getTemporaryServerContextByID: jest.fn(),
  ensureServerAvailable: jest.fn(),
  subscribeResource: jest.fn(async (serverId, resourceUri, sessionId, userId) => {
    serverManagerInstance.subscribed.push({ serverId, resourceUri, sessionId, userId });
  }),
  unsubscribeResource: jest.fn(async (serverId, resourceUri, sessionId, userId) => {
    serverManagerInstance.unsubscribed.push({ serverId, resourceUri, sessionId, userId });
  }),
};

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: { instance: serverManagerInstance },
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: { getInstance: () => ({ generateUniformRequestId: jest.fn(() => 'modern-test'), enqueueLog: jest.fn() }) },
}));

const { ModernMcpController } = await import('../dist/mcp/modern/ModernMcpController.js');
const { modernSubscriptionBus } = await import('../dist/mcp/modern/ModernSubscriptionBus.js');
const { ResultCacheService } = await import('../dist/mcp/core/cache/ResultCacheService.js');

function createServerContext() {
  return {
    id: 'ctx-1',
    serverID: 'server-1',
    userId: 'user-1',
    status: 0,
    serverEntity: { enabled: true, allowUserInput: false, publicAccess: true, anonymousAccess: false },
    capabilities: { resources: { subscribe: true } },
    connection: { protocolEra: 'legacy' },
    capabilitiesConfig: { tools: {}, resources: {}, prompts: {} },
    getDangerLevel: jest.fn(() => undefined),
    tools: { tools: [{ name: 'openApp', inputSchema: {}, _meta: { ui: { resourceUri: 'ui://app' }, 'ui/resourceUri': 'ui://app' } }] },
    resources: { resources: [{ name: 'app', uri: 'ui://app', mimeType: 'text/html;profile=mcp-app' }] },
    prompts: { prompts: [] },
  };
}

describe('ModernAppsRewrite', () => {
  beforeEach(() => {
    const serverContext = createServerContext();
    serverManagerInstance.availableServers = [serverContext];
    serverManagerInstance.contexts = new Map([['server-1', serverContext]]);
    serverManagerInstance.subscribed = [];
    serverManagerInstance.unsubscribed = [];
    jest.clearAllMocks();
    serverManagerInstance.subscribeResource.mockImplementation(async (serverId, resourceUri, sessionId, userId) => {
      serverManagerInstance.subscribed.push({ serverId, resourceUri, sessionId, userId });
    });
    serverManagerInstance.unsubscribeResource.mockImplementation(async (serverId, resourceUri, sessionId, userId) => {
      serverManagerInstance.unsubscribed.push({ serverId, resourceUri, sessionId, userId });
    });
  });

  test('rewrites MCP app resource URIs in tool metadata', () => {
    const controller = new ModernMcpController();
    const result = controller.listTools({
      authContext: { userId: 'user-1', permissions: {}, userPreferences: {} },
      clientCapabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
    });

    expect(result.tools[0]._meta.ui.resourceUri).toBe('ui://app_-_ctx-1');
    expect(result.tools[0]._meta['ui/resourceUri']).toBe('ui://app_-_ctx-1');
  });

  test('preserves text-only tools while removing UI metadata for clients without MCP Apps', () => {
    const result = new ModernMcpController().listTools({
      authContext: { userId: 'user-1', permissions: {}, userPreferences: {} },
      clientCapabilities: {},
    });

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('openApp_-_ctx-1');
    expect(result.tools[0]._meta).toBeUndefined();
  });

  test('filters tools with invalid x-mcp-header annotations from list results', () => {
    const serverContext = serverManagerInstance.availableServers[0];
    serverContext.tools.tools.push({ name: 'badHeader', inputSchema: { type: 'object', properties: { nested: { type: 'object', 'x-mcp-header': 'bad' } } } });
    serverContext.tools.tools.push({ name: 'badHeaderName', inputSchema: { type: 'object', properties: { tenant: { type: 'string', 'x-mcp-header': 'bad header' } } } });
    serverContext.tools.tools.push({ name: 'duplicateHeader', inputSchema: { type: 'object', properties: { left: { type: 'string', 'x-mcp-header': 'tenant' }, right: { type: 'string', 'x-mcp-header': 'Tenant' } } } });
    const controller = new ModernMcpController();
    const result = controller.listTools({ authContext: { userId: 'user-1', permissions: {}, userPreferences: {} } });

    expect(result.tools.map((tool) => tool.name)).toEqual(['openApp_-_ctx-1']);
  });

  test('rewrites app resource content URIs and embedded HTML references', () => {
    const controller = new ModernMcpController();
    const result = controller.rewriteResourceResult({
      contents: [{ uri: 'ui://app', mimeType: 'text/html;profile=mcp-app', text: '<button data-tool="openApp" data-resource="ui://app">Open</button>' }],
    }, 'server-1', 'user-1', true);

    expect(result.contents[0].uri).toBe('ui://app_-_ctx-1');
    expect(result.contents[0].text).toContain('openApp_-_ctx-1');
    expect(result.contents[0].text).toContain('ui://app_-_ctx-1');
  });

  test('does not rewrite app HTML for clients without MCP Apps', () => {
    const html = '<button data-tool="openApp" data-resource="ui://app">Open</button>';
    const result = new ModernMcpController().rewriteResourceResult({
      contents: [{ uri: 'ui://app', mimeType: 'text/html;profile=mcp-app', text: html }],
    }, 'server-1', 'user-1', false);

    expect(result.contents[0].text).toBe(html);
  });

  test('subscribes and cleans up downstream resource subscriptions', async () => {
    const controller = new ModernMcpController();
    const filter = controller.buildSubscriptionFilter({ notifications: { resourceSubscriptions: ['ui://app_-_ctx-1'] } });
    const context = { authContext: { userId: 'user-1', permissions: {}, userPreferences: {} } };

    const subscriptions = await controller.subscribeModernResources(context, filter, 'sub-1');
    await controller.cleanupModernResourceSubscriptions(context, 'sub-1', subscriptions);

    expect(serverManagerInstance.subscribed).toEqual([{ serverId: 'server-1', resourceUri: 'ui://app', sessionId: 'sub-1', userId: 'user-1' }]);
    expect(serverManagerInstance.unsubscribed).toEqual([{ serverId: 'server-1', resourceUri: 'ui://app', sessionId: 'sub-1', userId: 'user-1' }]);
  });

  test('rolls back earlier resource subscriptions when a later subscription fails', async () => {
    const serverContext = serverManagerInstance.availableServers[0];
    serverContext.resources.resources.push({ name: 'second', uri: 'ui://second' });
    serverManagerInstance.subscribeResource.mockImplementation(async (serverId, resourceUri, sessionId, userId) => {
      if (resourceUri === 'ui://second') {
        throw new Error('subscribe failed');
      }
      serverManagerInstance.subscribed.push({ serverId, resourceUri, sessionId, userId });
    });
    const controller = new ModernMcpController();
    const filter = controller.buildSubscriptionFilter({ notifications: { resourceSubscriptions: ['ui://app_-_ctx-1', 'ui://second_-_ctx-1'] } });
    const context = { authContext: { userId: 'user-1', permissions: {}, userPreferences: {} } };

    await expect(controller.subscribeModernResources(context, filter, 'sub-1')).rejects.toThrow('subscribe failed');

    expect(serverManagerInstance.unsubscribed).toEqual([{ serverId: 'server-1', resourceUri: 'ui://app', sessionId: 'sub-1', userId: 'user-1' }]);
  });

  test('omits resource subscriptions from acknowledgement for modern downstreams', async () => {
    serverManagerInstance.availableServers[0].connection.protocolEra = 'modern';
    const controller = new ModernMcpController();
    const chunks = [];
    let closeHandler;
    const context = {
      uniformRequestId: 'request-1',
      protocolVersion: '2026-07-28',
      authContext: { userId: 'user-1', permissions: {}, userPreferences: {} },
      req: { on: (_event, handler) => { closeHandler = handler; } },
      res: { status: jest.fn(), setHeader: jest.fn(), write: jest.fn((chunk) => { chunks.push(chunk); return true; }), end: jest.fn() },
    };

    await controller.handleSubscriptionListen(context, {
      jsonrpc: '2.0',
      id: 1,
      method: 'subscriptions/listen',
      params: { notifications: { resourceSubscriptions: ['ui://app_-_ctx-1'] } },
    });
    closeHandler();

    const acknowledged = JSON.parse(chunks[0].split('data: ')[1]);
    expect(acknowledged.params.notifications).toEqual({});
    expect(serverManagerInstance.subscribed).toEqual([]);
    expect(chunks).toHaveLength(1);
  });

  test('emits a complete result before ending a subscription on auth expiry', async () => {
    jest.useFakeTimers();
    const chunks = [];
    let closeHandler;
    const context = {
      uniformRequestId: 'request-1',
      protocolVersion: '2026-07-28',
      authContext: {
        userId: 'user-1',
        oauthAccessTokenExpiresAt: (Date.now() + 1_000) / 1_000,
        permissions: {},
        userPreferences: {},
      },
      req: { on: (_event, handler) => { closeHandler = handler; } },
      res: { status: jest.fn(), setHeader: jest.fn(), write: jest.fn((chunk) => { chunks.push(chunk); return true; }), end: jest.fn() },
    };
    const controller = new ModernMcpController();
    const offEvent = jest.spyOn(modernSubscriptionBus, 'offEvent');

    try {
      await controller.handleSubscriptionListen(context, {
        jsonrpc: '2.0',
        id: 'subscription-1',
        method: 'subscriptions/listen',
        params: { notifications: { resourceSubscriptions: ['ui://app_-_ctx-1'] } },
      });
      jest.advanceTimersByTime(1_000);
      await Promise.resolve();

      const completed = JSON.parse(chunks[1].split('data: ')[1]);
      expect(completed).toEqual({
        jsonrpc: '2.0',
        id: 'subscription-1',
        result: {
          resultType: 'complete',
          _meta: {
            'io.modelcontextprotocol/subscriptionId': 'subscription-1',
            'io.modelcontextprotocol/serverInfo': expect.objectContaining({ name: expect.any(String), version: expect.any(String) }),
          },
        },
      });
      expect(context.res.end).toHaveBeenCalledTimes(1);
      modernSubscriptionBus.publish({ method: 'notifications/tools/list_changed', params: {} });
      jest.advanceTimersByTime(30_000);
      closeHandler();
      await Promise.resolve();
      expect(chunks).toHaveLength(2);
      expect(offEvent).toHaveBeenCalledTimes(1);
      expect(serverManagerInstance.unsubscribed).toEqual([{
        serverId: 'server-1',
        resourceUri: 'ui://app',
        sessionId: 'request-1:subscription-1',
        userId: 'user-1',
      }]);
      expect(context.res.end).toHaveBeenCalledTimes(1);
    } finally {
      offEvent.mockRestore();
      jest.useRealTimers();
    }
  });

  test('uses unique downstream subscriber ids for identical JSON-RPC subscription ids', async () => {
    const controller = new ModernMcpController();
    const passedSubscriberIds = [];
    controller.subscribeModernResources = jest.fn(async (_context, _filter, subscriberId) => {
      passedSubscriberIds.push(subscriberId);
      return [];
    });
    const makeContext = (uniformRequestId) => {
      let closeHandler;
      return {
        context: {
          uniformRequestId,
          protocolVersion: '2026-07-28',
          authContext: { userId: 'user-1', oauthScopes: ['mcp:resources'], permissions: {}, userPreferences: {} },
          req: { headers: {}, on: (_event, handler) => { closeHandler = handler; } },
          res: { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() },
        },
        close: () => closeHandler?.(),
      };
    };
    const first = makeContext('stream-a');
    const second = makeContext('stream-b');

    await controller.handleSubscriptionListen(first.context, { jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: { notifications: { resourceSubscriptions: ['ui://app_-_ctx-1'] } } });
    await controller.handleSubscriptionListen(second.context, { jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: { notifications: { resourceSubscriptions: ['ui://app_-_ctx-1'] } } });
    first.close();
    second.close();

    expect(passedSubscriberIds).toEqual(['stream-a:1', 'stream-b:1']);
  });

  test('uses serverIds to disambiguate unqualified resource subscriptions', async () => {
    const secondContext = {
      ...createServerContext(),
      id: 'ctx-2',
      serverID: 'server-2',
    };
    serverManagerInstance.availableServers.push(secondContext);
    serverManagerInstance.contexts.set('server-2', secondContext);
    const controller = new ModernMcpController();
    const filter = controller.buildSubscriptionFilter({ serverIds: ['server-2'], notifications: { resourceSubscriptions: ['ui://app'] } });
    const context = { authContext: { userId: 'user-1', permissions: {}, userPreferences: {} } };

    const subscriptions = await controller.subscribeModernResources(context, filter, 'sub-1');

    expect(subscriptions).toEqual([{ serverId: 'server-2', resourceUri: 'ui://app', requestedUri: 'ui://app' }]);
    expect(serverManagerInstance.subscribed).toEqual([{ serverId: 'server-2', resourceUri: 'ui://app', sessionId: 'sub-1', userId: 'user-1' }]);
  });

  test('rejects forged gateway names for unadvertised capabilities', () => {
    const controller = new ModernMcpController();
    const authContext = { userId: 'user-1', permissions: {}, userPreferences: {} };

    expect(controller.resolveToolName(authContext, 'missingTool_-_ctx-1')).toBeNull();
    expect(controller.resolveResourceUri(authContext, 'missing://resource_-_ctx-1')).toBeNull();
    expect(controller.resolvePromptName(authContext, 'missingPrompt_-_ctx-1')).toBeNull();
  });

  test('does not deliver scoped temporary resource updates through managed modern subscriptions', () => {
    const temporaryContext = {
      ...createServerContext(),
      id: 'temp-ctx-1',
      userId: 'user-1',
      serverEntity: { enabled: true, allowUserInput: true, publicAccess: false, anonymousAccess: false },
    };
    serverManagerInstance.getTemporaryServerContextByID = jest.fn((contextId, userId) => (
      contextId === temporaryContext.id && userId === temporaryContext.userId ? temporaryContext : undefined
    ));
    const controller = new ModernMcpController();
    const context = { authContext: { userId: 'user-1', permissions: {}, userPreferences: {} } };
    const scopedEvent = {
      method: 'notifications/resources/updated',
      serverId: 'server-1',
      scopeId: 'temp-ctx-1',
      resourceUri: 'ui://app',
      params: { serverId: 'server-1', uri: 'ui://app' },
    };

    expect(controller.canReceiveSubscriptionEvent(context, scopedEvent)).toBe(false);
    expect(controller.subscriptionResourceUris(context, scopedEvent)).toEqual(['ui://app', 'ui://app_-_temp-ctx-1']);
  });

  test('caches raw downstream resource results before gateway URI rewriting', async () => {
    const serverContext = serverManagerInstance.availableServers[0];
    serverContext.connection = {
      readResource: jest.fn(async () => ({ contents: [{ uri: 'ui://app', mimeType: 'text/html', text: 'ui://app' }] })),
    };
    serverContext.clearTimeout = jest.fn();
    const cacheService = ResultCacheService.instance;
    const originalResolve = cacheService.resolveResourcePolicy;
    const originalExecute = cacheService.executeWithCache;
    let cachedResult;
    cacheService.resolveResourcePolicy = jest.fn(() => ({ enabled: true }));
    cacheService.executeWithCache = jest.fn(async (_operation, _serverId, _entityName, _scopeContext, _policy, _params, execute) => {
      cachedResult = await execute();
      return { result: cachedResult, hit: false };
    });

    try {
      const controller = new ModernMcpController();
      const result = await controller.readResource(
        { authContext: { userId: 'user-1', token: 'test-token-test-token', permissions: {}, userPreferences: {} }, req: { headers: {} } },
        { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://app_-_ctx-1' } },
        Date.now(),
      );

      expect(cachedResult.contents[0].uri).toBe('ui://app');
      expect(result.contents[0].uri).toBe('ui://app_-_ctx-1');
    } finally {
      cacheService.resolveResourcePolicy = originalResolve;
      cacheService.executeWithCache = originalExecute;
    }
  });
});
