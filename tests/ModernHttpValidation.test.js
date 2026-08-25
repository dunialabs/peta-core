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

const originalModernEnabled = process.env.MCP_2026_ENABLED;
process.env.MCP_2026_ENABLED = 'true';
const { ModernMcpController } = await import('../dist/mcp/modern/ModernMcpController.js');
const { ModernErrorCodes } = await import('../dist/mcp/modern/ModernMcpErrors.js');
if (originalModernEnabled === undefined) {
  delete process.env.MCP_2026_ENABLED;
} else {
  process.env.MCP_2026_ENABLED = originalModernEnabled;
}

function modernRequest(overrides = {}) {
  return {
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
      ...overrides,
    },
    headers: {
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': overrides.method ?? 'tools/list',
    },
  };
}

describe('ModernHttpValidation', () => {
  beforeEach(() => {
    availableServers = [];
  });

  test('requires both JSON and SSE Accept media types', () => {
    const controller = new ModernMcpController();

    expect(controller.acceptsModernResponse('application/json, text/event-stream')).toBe(true);
    expect(controller.acceptsModernResponse('application/json; charset=utf-8, text/event-stream')).toBe(true);
    expect(controller.acceptsModernResponse('*/*')).toBe(false);
    expect(controller.acceptsModernResponse('application/jsonx, text/event-streamx')).toBe(false);
    expect(controller.acceptsModernResponse('text/event-stream')).toBe(false);
  });

  test('rejects malformed subscription filters', () => {
    const controller = new ModernMcpController();

    expect(() => controller.buildSubscriptionFilter({ notifications: {}, methods: [123] })).toThrow('methods must contain only non-empty strings');
    expect(() => controller.buildSubscriptionFilter({ notifications: { toolsListChanged: 'yes' } })).toThrow('notifications.toolsListChanged must be a boolean');
    expect(() => controller.buildSubscriptionFilter({ notifications: { resourceSubscriptions: [123] } })).toThrow('notifications.resourceSubscriptions must be an array of non-empty strings');
  });

  test('requires explicit notifications instead of deriving extension filters', () => {
    const controller = new ModernMcpController();
    let thrownError;

    try {
      controller.buildSubscriptionFilter({
        methods: ['notifications/tools/list_changed'],
        resourceUris: ['peta://resource'],
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toMatchObject({
      httpStatus: 400,
      rpcCode: ModernErrorCodes.InvalidParams,
      message: 'params.notifications is required',
    });
  });

  test('maps spec subscription notifications to supported event methods', () => {
    const controller = new ModernMcpController();
    const filter = controller.buildSubscriptionFilter({
      methods: ['notifications/prompts/list_changed'],
      serverIds: ['server-1'],
      resourceUris: ['peta://extension-resource'],
      notifications: {
        toolsListChanged: true,
        resourcesListChanged: true,
        resourceSubscriptions: ['peta://resource'],
      },
    });

    expect(filter.methods.has('notifications/tools/list_changed')).toBe(true);
    expect(filter.methods.has('notifications/prompts/list_changed')).toBe(true);
    expect(filter.methods.has('notifications/resources/list_changed')).toBe(true);
    expect(filter.methods.has('notifications/resources/updated')).toBe(true);
    expect(filter.serverIds.has('server-1')).toBe(true);
    expect(filter.resourceUris.has('peta://extension-resource')).toBe(true);
    expect(filter.resourceUris.has('peta://resource')).toBe(true);
    expect(filter.notifications.resourceSubscriptions).toEqual(['peta://resource']);
  });

  test('empty subscription notifications subscribe to no event methods', () => {
    const controller = new ModernMcpController();
    const filter = controller.buildSubscriptionFilter({ notifications: {} });

    expect(filter.methods.size).toBe(0);
    expect(controller.subscriptionMatches({}, filter, { method: 'notifications/tools/list_changed', params: {} })).toBe(false);
  });

  test('accepts omitted clientInfo while keeping protocolVersion and clientCapabilities required', () => {
    const controller = new ModernMcpController();

    expect(() => controller.validateRequest(modernRequest())).not.toThrow();
    expect(() => controller.validateRequest(modernRequest({ params: { _meta: { 'io.modelcontextprotocol/clientCapabilities': {} } } }))).toThrow('io.modelcontextprotocol/protocolVersion');
    expect(() => controller.validateRequest(modernRequest({ params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }))).toThrow('io.modelcontextprotocol/clientCapabilities');
  });

  test('uses MCP 2026-07-28 standard transport error codes', () => {
    expect(ModernErrorCodes.HeaderMismatch).toBe(-32020);
    expect(ModernErrorCodes.MissingRequiredClientCapability).toBe(-32021);
    expect(ModernErrorCodes.UnsupportedProtocolVersion).toBe(-32022);
  });

  test('rejects null JSON-RPC request ids', () => {
    const controller = new ModernMcpController();

    expect(() => controller.validateRequest(modernRequest({ id: null }))).toThrow('Invalid JSON-RPC id');
  });

  test('preserves a valid JSON-RPC id when request metadata validation fails', async () => {
    const controller = new ModernMcpController();
    const req = modernRequest({ params: {} });
    req.method = 'POST';
    const res = {
      headersSent: false,
      status: jest.fn(function () { return this; }),
      json: jest.fn(),
    };

    await controller.handlePost(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      error: {
        code: ModernErrorCodes.InvalidParams,
        message: 'Missing required modern MCP request _meta',
      },
      id: 1,
    });
  });

  test('decodes Base64 sentinel Mcp-Name before comparison', () => {
    const controller = new ModernMcpController();
    const request = modernRequest({
      method: 'tools/call',
      params: {
        name: 'Hello, 世界',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    });
    request.headers['mcp-name'] = '=?base64?SGVsbG8sIOS4lueVjA==?=';

    expect(() => controller.validateRequest(request)).not.toThrow();
  });

  test('acknowledges only requested notification types the server supports', async () => {
    availableServers = [{
      id: 'ctx-1',
      serverID: 'server-1',
      status: 0,
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } },
      capabilitiesConfig: { tools: {}, resources: {}, prompts: {} },
      tools: { tools: [{ name: 'allowed', inputSchema: {} }] },
      connection: { protocolEra: 'legacy' },
      serverEntity: { enabled: true, allowUserInput: false, publicAccess: true },
    }];
    const controller = new ModernMcpController();
    const chunks = [];
    let closeHandler;
    const context = {
      uniformRequestId: 'request-1',
      protocolVersion: '2026-07-28',
      authContext: { userId: 'user-1', oauthScopes: ['mcp:tools', 'mcp:resources', 'mcp:prompts'], permissions: {}, userPreferences: {} },
      req: {},
      res: {
        status: jest.fn(),
        setHeader: jest.fn(),
        write: jest.fn((chunk) => { chunks.push(chunk); return true; }),
        end: jest.fn(),
        on: (_event, handler) => { closeHandler = handler; },
      },
    };

    await controller.handleSubscriptionListen(context, {
      jsonrpc: '2.0',
      id: 1,
      method: 'subscriptions/listen',
      params: { notifications: { toolsListChanged: true, resourcesListChanged: true, promptsListChanged: true } },
    });
    closeHandler();

    const acknowledged = JSON.parse(chunks[0].split('data: ')[1]);
    expect(acknowledged.params.notifications).toEqual({
      toolsListChanged: true,
      resourcesListChanged: true,
      promptsListChanged: true,
    });
  });

  test('does not acknowledge list-change notifications without downstream support', async () => {
    availableServers = [{
      id: 'ctx-1',
      serverID: 'server-1',
      status: 0,
      capabilities: { tools: {}, resources: { listChanged: false }, prompts: {} },
      capabilitiesConfig: { tools: {}, resources: {}, prompts: {} },
      tools: { tools: [{ name: 'allowed', inputSchema: {} }] },
      connection: { protocolEra: 'legacy' },
      serverEntity: { enabled: true, allowUserInput: false, publicAccess: true },
    }];
    const chunks = [];
    let closeHandler;
    const context = {
      uniformRequestId: 'request-1',
      protocolVersion: '2026-07-28',
      authContext: { userId: 'user-1', oauthScopes: ['mcp:tools', 'mcp:resources', 'mcp:prompts'], permissions: {}, userPreferences: {} },
      req: {},
      res: { status: jest.fn(), setHeader: jest.fn(), write: jest.fn((chunk) => { chunks.push(chunk); return true; }), end: jest.fn(), on: (_event, handler) => { closeHandler = handler; } },
    };

    await new ModernMcpController().handleSubscriptionListen(context, {
      jsonrpc: '2.0',
      id: 1,
      method: 'subscriptions/listen',
      params: { notifications: { toolsListChanged: true, resourcesListChanged: true, promptsListChanged: true } },
    });
    closeHandler();

    const acknowledged = JSON.parse(chunks[0].split('data: ')[1]);
    expect(acknowledged.params.notifications).toEqual({});
  });

  test('builds insufficient-scope bearer challenge', () => {
    const controller = new ModernMcpController();
    const app = { get: () => () => false };
    const challenge = controller.buildScopeChallenge({
      app,
      headers: { host: 'localhost:3002' },
      protocol: 'http',
      socket: { remoteAddress: '127.0.0.1' },
      get: () => 'localhost:3002',
    }, ['mcp:tools']);

    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('resource_metadata="http://localhost:3002/.well-known/oauth-protected-resource/mcp"');
    expect(challenge).toContain('scope="mcp:tools"');
  });

  test('validates spec-style nested x-mcp-header annotations', () => {
    const controller = new ModernMcpController();
    const tool = {
      name: 'tool',
      inputSchema: {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              tenant: { type: 'string', 'x-mcp-header': 'tenant-id' },
            },
          },
        },
      },
    };

    expect(() => controller.validateToolHeaderAnnotations(
      { headers: { 'mcp-param-tenant-id': 'acme' } },
      tool,
      { nested: { tenant: 'acme' } },
    )).not.toThrow();
    expect(() => controller.validateToolHeaderAnnotations(
      { headers: { 'mcp-param-tenant-id': 'wrong' } },
      tool,
      { nested: { tenant: 'acme' } },
    )).toThrow('Mcp-Param-tenant-id does not match tool argument nested.tenant');
  });

  test('validates x-mcp-header null omission, integers, base64 sentinel, and duplicates', () => {
    const controller = new ModernMcpController();
    const tool = {
      name: 'tool',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'integer', 'x-mcp-header': 'count' },
          note: { type: 'string', 'x-mcp-header': 'note' },
          optional: { type: 'string', 'x-mcp-header': 'optional' },
        },
      },
    };

    expect(() => controller.validateToolHeaderAnnotations(
      { headers: { 'mcp-param-count': '7', 'mcp-param-note': '=?base64?YWNtZQ==?=' } },
      tool,
      { count: 7, note: 'acme', optional: null },
    )).not.toThrow();
    expect(() => controller.validateToolHeaderAnnotations(
      { headers: { 'mcp-param-note': '=?base64?not valid?=' } },
      tool,
      { note: 'acme' },
    )).toThrow('Mcp-Param-note does not match tool argument note');
    expect(() => controller.validateToolHeaderAnnotations(
      { headers: { 'mcp-param-note': '=?base64?YWNtZQ?=' } },
      tool,
      { note: 'acme' },
    )).toThrow('Invalid base64 Mcp-Param header value');
    expect(() => controller.validateToolHeaderAnnotations(
      { headers: { 'mcp-param-count': '7.5', 'mcp-param-note': 'acme' } },
      tool,
      { count: 7.5, note: 'acme' },
    )).toThrow('x-mcp-header argument count must be a string, integer, or boolean');
    expect(() => controller.validateToolHeaderAnnotations(
      { headers: { 'mcp-param-count': '7', 'mcp-param-note': 'acme', 'mcp-param-optional': 'value' } },
      tool,
      { count: 7, note: 'acme', optional: null },
    )).toThrow('Mcp-Param-optional must be omitted');

    const duplicateTool = {
      name: 'tool',
      inputSchema: {
        type: 'object',
        properties: {
          left: { type: 'string', 'x-mcp-header': 'tenant' },
          right: { type: 'string', 'x-mcp-header': 'Tenant' },
        },
      },
    };
    expect(() => controller.validateToolHeaderAnnotations({ headers: {} }, duplicateTool, {})).toThrow('Duplicate x-mcp-header annotation');

    const tokenHeaderTool = {
      name: 'tool',
      inputSchema: { type: 'object', properties: { tenant: { type: 'string', 'x-mcp-header': 'tenant~id' } } },
    };
    expect(() => controller.validateToolHeaderAnnotations(
      { headers: { 'mcp-param-tenant~id': 'acme' } },
      tokenHeaderTool,
      { tenant: 'acme' },
    )).not.toThrow();

    const prefixedValueTool = {
      name: 'tool',
      inputSchema: { type: 'object', properties: { tenant: { type: 'string', 'x-mcp-header': 'Mcp-Param-tenant' } } },
    };
    expect(() => controller.validateToolHeaderAnnotations(
      { headers: { 'mcp-param-mcp-param-tenant': 'acme' } },
      prefixedValueTool,
      { tenant: 'acme' },
    )).not.toThrow();
    expect(() => controller.validateToolHeaderAnnotations(
      { headers: { 'mcp-param-tenant': 'acme' } },
      prefixedValueTool,
      { tenant: 'acme' },
    )).toThrow('Mcp-Param-Mcp-Param-tenant does not match tool argument tenant');
  });
});
