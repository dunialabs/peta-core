import { jest } from '@jest/globals';

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: { instance: { getAvailableServers: jest.fn(() => []), getServerContext: jest.fn(), ensureServerAvailable: jest.fn() } },
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: { getInstance: () => ({ generateUniformRequestId: jest.fn(() => 'modern-test'), enqueueLog: jest.fn() }) },
}));

const { ModernMcpController } = await import('../dist/mcp/modern/ModernMcpController.js');

describe('ModernHttpValidation', () => {
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

    expect(() => controller.buildSubscriptionFilter({ methods: [123] })).toThrow('methods must contain only non-empty strings');
    expect(() => controller.buildSubscriptionFilter({ notifications: { toolsListChanged: 'yes' } })).toThrow('notifications.toolsListChanged must be a boolean');
    expect(() => controller.buildSubscriptionFilter({ notifications: { resourceSubscriptions: [123] } })).toThrow('notifications.resourceSubscriptions must be an array of non-empty strings');
  });

  test('maps spec subscription notifications to supported event methods', () => {
    const controller = new ModernMcpController();
    const filter = controller.buildSubscriptionFilter({
      notifications: {
        toolsListChanged: true,
        resourcesListChanged: true,
        resourceSubscriptions: ['peta://resource'],
      },
    });

    expect(filter.methods.has('notifications/tools/list_changed')).toBe(true);
    expect(filter.methods.has('notifications/resources/list_changed')).toBe(true);
    expect(filter.methods.has('notifications/resources/updated')).toBe(true);
    expect(filter.resourceUris.has('peta://resource')).toBe(true);
    expect(filter.notifications.resourceSubscriptions).toEqual(['peta://resource']);
  });

  test('empty subscription notifications subscribe to no event methods', () => {
    const controller = new ModernMcpController();
    const filter = controller.buildSubscriptionFilter({ notifications: {} });

    expect(filter.methods.size).toBe(0);
    expect(controller.subscriptionMatches({}, filter, { method: 'notifications/tools/list_changed', params: {} })).toBe(false);
  });

  test('requires clientInfo version in modern request metadata', () => {
    const controller = new ModernMcpController();

    expect(controller.isModernClientInfo({ name: 'client', version: '1.0.0' })).toBe(true);
    expect(controller.isModernClientInfo({ name: 'client' })).toBe(false);
  });

  test('builds insufficient-scope bearer challenge', () => {
    const controller = new ModernMcpController();
    const challenge = controller.buildScopeChallenge({
      headers: { host: 'example.test', 'x-forwarded-proto': 'https' },
      protocol: 'https',
      get: () => 'example.test',
    }, ['mcp:tools']);

    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('resource_metadata="https://example.test/.well-known/oauth-protected-resource/mcp"');
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
  });
});
