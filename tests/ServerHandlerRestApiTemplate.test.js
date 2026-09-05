import { jest } from '@jest/globals';

const findByServerId = jest.fn();
const create = jest.fn();
const update = jest.fn();
const enqueueLog = jest.fn();

jest.unstable_mockModule('../dist/repositories/ServerRepository.js', () => ({
  ServerRepository: { findByServerId, create, update },
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: { instance: {} },
}));

jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({
  SessionStore: { instance: { getSessionsUsingServer: jest.fn().mockReturnValue([]) } },
}));

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../dist/socket/SocketNotifier.js', () => ({ socketNotifier: {} }));
jest.unstable_mockModule('../dist/config/prisma.js', () => ({ prisma: {} }));
jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: { getInstance: () => ({ enqueueLog }) },
}));
jest.unstable_mockModule('../dist/security/CryptoService.js', () => ({ CryptoService: {} }));
jest.unstable_mockModule('../dist/mcp/oauth/exchange.js', () => ({
  exchangeAuthorizationCode: jest.fn(),
}));
jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({
    trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(),
  }),
}));

const { ServerHandler } = await import('../dist/controllers/handlers/ServerHandler.js');
const { AdminErrorCode } = await import('../dist/types/admin.types.js');
const { ServerCategory } = await import('../dist/types/enums.js');

const validTemplate = JSON.stringify({ baseUrl: 'https://api.example.com', apis: [{}] });
const malformedTemplates = [
  JSON.stringify({ baseUrl: 'https://api.example.com' }),
  JSON.stringify({ baseUrl: 'https://api.example.com', apis: [] }),
  JSON.stringify({ baseUrl: 'https://api.example.com', apis: [null] }),
  '[]',
  '{not-json',
];

const restServer = {
  serverId: 'rest-server',
  serverName: 'REST server',
  category: ServerCategory.RestApi,
  capabilities: JSON.stringify({ tools: {}, resources: {}, prompts: {} }),
  enabled: false,
  allowUserInput: false,
  configTemplate: JSON.stringify({ baseUrl: 'https://old.example.com', apis: [{}] }),
  lazyStartEnabled: false,
  publicAccess: false,
  anonymousAccess: false,
  anonymousRateLimit: 10,
};

describe('ServerHandler RestApi template validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findByServerId.mockResolvedValue(null);
    create.mockImplementation(async (payload) => payload);
    update.mockImplementation(async (_serverId, payload) => ({ ...restServer, ...payload }));
  });

  test.each(malformedTemplates)('rejects malformed RestApi templates during creation: %s', async (configTemplate) => {
    await expect(new ServerHandler().handleCreateServer({
      action: 2010,
      data: {
        serverId: 'rest-server',
        category: ServerCategory.RestApi,
        launchConfig: 'encrypted-launch-config',
        configTemplate,
      },
    }, 'admin-token')).rejects.toMatchObject({ code: AdminErrorCode.INVALID_REQUEST });

    expect(create).not.toHaveBeenCalled();
  });

  test.each(malformedTemplates)('rejects malformed RestApi templates during update: %s', async (configTemplate) => {
    findByServerId.mockResolvedValue(restServer);

    await expect(new ServerHandler().handleUpdateServer({
      action: 2012,
      data: { serverId: restServer.serverId, configTemplate },
    }, 'admin-token')).rejects.toMatchObject({ code: AdminErrorCode.INVALID_REQUEST });

    expect(update).not.toHaveBeenCalled();
  });

  test('accepts an auth-less first RestApi endpoint for creation and update', async () => {
    const handler = new ServerHandler();

    await handler.handleCreateServer({
      action: 2010,
      data: {
        serverId: 'new-rest-server',
        category: ServerCategory.RestApi,
        launchConfig: 'encrypted-launch-config',
        configTemplate: validTemplate,
      },
    }, 'admin-token');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ configTemplate: validTemplate }));

    findByServerId.mockResolvedValue(restServer);
    await handler.handleUpdateServer({
      action: 2012,
      data: { serverId: restServer.serverId, configTemplate: validTemplate },
    }, 'admin-token');
    expect(update).toHaveBeenCalledWith(
      restServer.serverId,
      expect.objectContaining({ configTemplate: validTemplate }),
    );
  });
});
