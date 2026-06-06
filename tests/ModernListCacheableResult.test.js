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

describe('ModernListCacheableResult', () => {
  test('adds conservative cache metadata to list results', () => {
    const controller = new ModernMcpController();
    const result = controller.cacheable({ tools: [] });

    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe('private');
  });

  test('preserves downstream cache metadata on action results', () => {
    const controller = new ModernMcpController();
    const result = controller.cacheable({ content: [], resultType: 'complete', ttlMs: 5000, cacheScope: 'public' });

    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(5000);
    expect(result.cacheScope).toBe('public');
  });
});
