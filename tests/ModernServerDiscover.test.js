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
    expect(result.serverInfo.name).toBeTruthy();
    expect(result._meta.peta.protocolVersion).toBe('2026-07-28');
    expect(result._meta.peta.stateless).toBe(true);
    expect(result._meta.peta.legacySessionHeaders).toBe(false);
    expect(result._meta.peta.anonymousPublicEndpoint).toBe(false);
  });

  test('advertises resource subscribe support when resources are available', () => {
    availableServers = [{ serverID: 'server-1', status: 0, capabilities: { resources: {} }, serverEntity: { enabled: true, allowUserInput: false, publicAccess: true } }];
    const controller = new ModernMcpController();
    const result = controller.serverDiscover({ authContext: { userId: 'user-1', permissions: {}, userPreferences: {} } });

    expect(result.capabilities.resources).toEqual({ listChanged: true, subscribe: true });
  });
});
