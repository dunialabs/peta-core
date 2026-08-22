import { jest } from '@jest/globals';

let availableServers = [];

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: { instance: { getAvailableServers: jest.fn(() => availableServers), getServerContext: jest.fn(), ensureServerAvailable: jest.fn() } },
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: { getInstance: () => ({ generateUniformRequestId: jest.fn(() => 'modern-test'), enqueueLog: jest.fn() }) },
}));

const { ModernMcpController } = await import('../dist/mcp/modern/ModernMcpController.js');

describe('ModernServerDiscover', () => {
  beforeEach(() => {
    availableServers = [];
  });

  test('returns spec discovery shape and stateless extension metadata', () => {
    const controller = new ModernMcpController();
    const result = controller.serverDiscover({ authContext: { permissions: {}, userPreferences: {} } });

    expect(result.supportedVersions).toContain('2026-07-28');
    expect(result.serverInfo).toBeUndefined();
    expect(result._meta['io.modelcontextprotocol/serverInfo'].name).toBeTruthy();
    expect(result._meta.peta.protocolVersion).toBe('2026-07-28');
    expect(result._meta.peta.stateless).toBe(true);
    expect(result._meta.peta.legacySessionHeaders).toBe(false);
    expect(result._meta.peta.anonymousPublicEndpoint).toBe(false);
    expect(result.capabilities.subscriptions).toBeUndefined();
    expect(result.capabilities.tools).toBeUndefined();
  });

  test('does not invent list-change support for advertised capabilities', () => {
    availableServers = [{
      id: 'ctx-1',
      serverID: 'server-1',
      status: 0,
      capabilities: { tools: {}, resources: { listChanged: false }, prompts: {} },
      tools: { tools: [{ name: 'allowed', inputSchema: {} }] },
      capabilitiesConfig: { tools: {} },
      connection: { protocolEra: 'legacy' },
      serverEntity: { enabled: true, allowUserInput: false, publicAccess: true },
    }];
    const result = new ModernMcpController().serverDiscover({ authContext: { permissions: {}, userPreferences: {} }, clientCapabilities: {} });

    expect(result.capabilities.tools).toEqual({});
    expect(result.capabilities.resources).toEqual({});
    expect(result.capabilities.prompts).toEqual({});
  });

  test('preserves an advertised tools capability when no tools are cached yet', () => {
    availableServers = [{
      serverID: 'server-1',
      status: 0,
      capabilities: { tools: {} },
      tools: { tools: [] },
      capabilitiesConfig: { tools: {} },
      connection: { protocolEra: 'legacy' },
      serverEntity: { enabled: true, allowUserInput: false, publicAccess: true },
    }];

    const result = new ModernMcpController().serverDiscover({
      authContext: { userId: 'user-1', permissions: {}, userPreferences: {} },
    });

    expect(result.capabilities.tools).toEqual({});
  });

  test('preserves list capabilities for a sleeping server with cached catalogs', () => {
    availableServers = [{
      id: 'ctx-1',
      serverID: 'server-1',
      status: 4,
      cachedTools: { tools: [{ name: 'cached-tool', inputSchema: {} }] },
      cachedResources: { resources: [] },
      cachedResourceTemplates: { resourceTemplates: [] },
      cachedPrompts: { prompts: [] },
      capabilitiesConfig: { tools: {}, resources: {}, prompts: {} },
      serverEntity: { enabled: true, allowUserInput: false, publicAccess: true },
    }];

    const result = new ModernMcpController().serverDiscover({
      authContext: { userId: 'user-1', permissions: {}, userPreferences: {} },
    });

    expect(result.capabilities.tools).toEqual({});
    expect(result.capabilities.resources).toEqual({});
    expect(result.capabilities.prompts).toEqual({});
  });

  test('advertises the UI extension only when client support and an app resource are both available', () => {
    availableServers = [{
      id: 'ctx-1',
      serverID: 'server-1',
      status: 0,
      capabilities: { tools: {}, resources: {} },
      tools: { tools: [{ name: 'openApp', inputSchema: {}, _meta: { ui: { resourceUri: 'ui://app' } } }] },
      resources: { resources: [{ name: 'app', uri: 'ui://app', mimeType: 'text/html;profile=mcp-app' }] },
      capabilitiesConfig: { tools: {}, resources: {} },
      serverEntity: { enabled: true, allowUserInput: false, publicAccess: true },
    }];
    const controller = new ModernMcpController();
    const unsupported = controller.serverDiscover({ authContext: { permissions: {}, userPreferences: {} }, clientCapabilities: {} });
    const supported = controller.serverDiscover({
      authContext: { permissions: {}, userPreferences: {} },
      clientCapabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
    });

    expect(unsupported.capabilities.extensions).toBeUndefined();
    expect(supported.capabilities.extensions).toEqual({
      'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
    });
  });

  test('rejects server/discover params beyond _meta', () => {
    const controller = new ModernMcpController();

    expect(() => controller.validateServerDiscoverParams({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: {}, unexpected: true } })).toThrow('server/discover params may only include _meta');
    expect(() => controller.validateServerDiscoverParams({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: {} } })).not.toThrow();
  });

  test('advertises declared legacy list-change and resource subscription support', () => {
    availableServers = [{
      serverID: 'server-1',
      status: 0,
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true }, prompts: { listChanged: true } },
      tools: { tools: [{ name: 'allowed', inputSchema: {} }] },
      capabilitiesConfig: { tools: {} },
      connection: { protocolEra: 'legacy' },
      serverEntity: { enabled: true, allowUserInput: false, publicAccess: true },
    }];
    const controller = new ModernMcpController();
    const result = controller.serverDiscover({ authContext: { userId: 'user-1', permissions: {}, userPreferences: {} } });

    expect(result.capabilities.tools).toEqual({ listChanged: true });
    expect(result.capabilities.resources).toEqual({ listChanged: true, subscribe: true });
    expect(result.capabilities.prompts).toEqual({ listChanged: true });
  });

  test('does not advertise unsupported modern downstream notifications or subscriptions', () => {
    availableServers = [{
      serverID: 'server-1',
      status: 0,
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true }, prompts: { listChanged: true } },
      tools: { tools: [{ name: 'allowed', inputSchema: {} }] },
      capabilitiesConfig: { tools: {} },
      connection: { protocolEra: 'modern' },
      serverEntity: { enabled: true, allowUserInput: false, publicAccess: true },
    }];
    const controller = new ModernMcpController();
    const result = controller.serverDiscover({ authContext: { userId: 'user-1', permissions: {}, userPreferences: {} } });

    expect(result.capabilities.tools).toEqual({});
    expect(result.capabilities.resources).toEqual({});
    expect(result.capabilities.prompts).toEqual({});
  });
});
