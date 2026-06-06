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

describe('ModernJsonSchema202012', () => {
  test('allows structuredContent as any JSON value', () => {
    const controller = new ModernMcpController();
    const values = ['text', 42, ['item'], { nested: true }, null];

    for (const structuredContent of values) {
      expect(controller.validateModernCallToolResult({ content: [], structuredContent }).structuredContent).toEqual(structuredContent);
    }
  });

  test('rejects non-JSON structuredContent values', () => {
    const controller = new ModernMcpController();

    expect(() => controller.validateModernCallToolResult({ content: [], structuredContent: undefined })).toThrow('invalid JSON result');
  });
});
