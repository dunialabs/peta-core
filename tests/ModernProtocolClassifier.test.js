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

describe('ModernProtocolClassifier', () => {
  test('routes malformed _meta through modern validation', () => {
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
});
