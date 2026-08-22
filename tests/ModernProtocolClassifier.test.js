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

const getSessionMock = jest.fn();
jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({
  SessionStore: { instance: { getSession: getSessionMock } },
}));

const { ModernMcpController } = await import('../dist/mcp/modern/ModernMcpController.js');

describe('ModernProtocolClassifier', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  test('routes initialize with a modern _meta signal to fail-closed validation', () => {
    const controller = new ModernMcpController();
    const req = { originalUrl: '/mcp', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { _meta: 'bad' } } };

    expect(controller.shouldHandle(req)).toBe(true);
  });

  test('leaves plain legacy initialize on legacy path', () => {
    const controller = new ModernMcpController();
    const req = { originalUrl: '/mcp', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } };

    expect(controller.shouldHandle(req)).toBe(false);
  });

  test('leaves legacy initialize with legacy protocol header on legacy path', () => {
    const controller = new ModernMcpController();
    const req = { originalUrl: '/mcp', headers: { 'mcp-protocol-version': '2025-11-25' }, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } };

    expect(controller.shouldHandle(req)).toBe(false);
  });

  test('fails closed for malformed and future protocol headers', () => {
    const controller = new ModernMcpController();
    const malformed = { originalUrl: '/mcp', headers: { 'mcp-protocol-version': '2026' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } };
    const future = { originalUrl: '/mcp', headers: { 'mcp-protocol-version': '2027-01-01' }, body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } };

    expect(controller.shouldHandle(malformed)).toBe(true);
    expect(controller.shouldHandle(future)).toBe(true);
  });

  test('routes mixed-era requests through an existing legacy session', () => {
    getSessionMock.mockReturnValue({ sessionId: 'session-1' });
    const controller = new ModernMcpController();
    const req = {
      originalUrl: '/mcp',
      headers: { 'mcp-session-id': 'session-1', 'mcp-protocol-version': '2026-07-28' },
      body: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    };

    expect(controller.shouldHandle(req)).toBe(false);
  });

  test('keeps stale mixed-era sessions on the modern validation path', () => {
    getSessionMock.mockReturnValue(undefined);
    const controller = new ModernMcpController();
    const req = {
      originalUrl: '/mcp',
      headers: { 'mcp-session-id': 'stale-session', 'mcp-protocol-version': '2026-07-28' },
      body: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    };

    expect(controller.shouldHandle(req)).toBe(true);
  });
});
