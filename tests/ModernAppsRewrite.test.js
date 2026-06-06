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
const { ResultCacheService } = await import('../dist/mcp/core/cache/ResultCacheService.js');

function createServerContext() {
  return {
    id: 'ctx-1',
    serverID: 'server-1',
    userId: 'user-1',
    status: 0,
    serverEntity: { enabled: true, allowUserInput: false, publicAccess: true, anonymousAccess: false },
    capabilities: { resources: { subscribe: true } },
    capabilitiesConfig: { tools: {}, resources: {}, prompts: {} },
    getDangerLevel: jest.fn(() => undefined),
    tools: { tools: [{ name: 'openApp', inputSchema: {}, _meta: { ui: { resourceUri: 'ui://app' }, 'ui/resourceUri': 'ui://app' } }] },
    resources: { resources: [{ name: 'app', uri: 'ui://app' }] },
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
  });

  test('rewrites MCP app resource URIs in tool metadata', () => {
    const controller = new ModernMcpController();
    const result = controller.listTools({ authContext: { userId: 'user-1', permissions: {}, userPreferences: {} } });

    expect(result.tools[0]._meta.ui.resourceUri).toBe('ui://app_-_ctx-1');
    expect(result.tools[0]._meta['ui/resourceUri']).toBe('ui://app_-_ctx-1');
  });

  test('rewrites app resource content URIs and embedded HTML references', () => {
    const controller = new ModernMcpController();
    const result = controller.rewriteResourceResult({
      contents: [{ uri: 'ui://app', mimeType: 'text/html', text: '<button data-tool="openApp" data-resource="ui://app">Open</button>' }],
    }, 'server-1', 'user-1');

    expect(result.contents[0].uri).toBe('ui://app_-_ctx-1');
    expect(result.contents[0].text).toContain('openApp_-_ctx-1');
    expect(result.contents[0].text).toContain('ui://app_-_ctx-1');
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

  test('rejects forged gateway names for unadvertised capabilities', () => {
    const controller = new ModernMcpController();
    const authContext = { userId: 'user-1', permissions: {}, userPreferences: {} };

    expect(controller.resolveToolName(authContext, 'missingTool_-_ctx-1')).toBeNull();
    expect(controller.resolveResourceUri(authContext, 'missing://resource_-_ctx-1')).toBeNull();
    expect(controller.resolvePromptName(authContext, 'missingPrompt_-_ctx-1')).toBeNull();
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
        { authContext: { userId: 'user-1', permissions: {}, userPreferences: {} }, req: { headers: {} } },
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
