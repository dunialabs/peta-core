import { jest } from '@jest/globals';

const findByServerId = jest.fn();
const update = jest.fn();
const enqueueLog = jest.fn();

jest.unstable_mockModule('../dist/repositories/ServerRepository.js', () => ({
  ServerRepository: {
    findByServerId,
    update,
  },
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: {
    instance: {},
  },
}));

jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({
  SessionStore: {
    instance: {
      getSessionsUsingServer: jest.fn().mockReturnValue([]),
    },
  },
}));

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../dist/socket/SocketNotifier.js', () => ({
  socketNotifier: {},
}));

jest.unstable_mockModule('../dist/config/prisma.js', () => ({
  prisma: {},
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      enqueueLog,
    }),
  },
}));

jest.unstable_mockModule('../dist/security/CryptoService.js', () => ({
  CryptoService: {},
}));

jest.unstable_mockModule('../dist/mcp/oauth/exchange.js', () => ({
  exchangeAuthorizationCode: jest.fn(),
}));

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  }),
}));

const { ServerHandler } = await import('../dist/controllers/handlers/ServerHandler.js');

describe('ServerHandler capability updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    const existingServer = {
      serverId: 'server-1',
      serverName: 'Server 1',
      category: 'CustomRemote',
      capabilities: JSON.stringify({
        tools: { existingTool: { enabled: true } },
        resources: { existingResource: { enabled: true } },
      }),
      enabled: false,
      allowUserInput: false,
      configTemplate: null,
      lazyStartEnabled: false,
      publicAccess: false,
      anonymousAccess: false,
      anonymousRateLimit: 60,
    };

    findByServerId.mockResolvedValue(existingServer);
    update.mockImplementation(async (_serverId, updateData) => ({
      ...existingServer,
      ...updateData,
    }));
  });

  test('preserves existing tools and resources when a partial prompt payload is submitted', async () => {
    const handler = new ServerHandler();

    await handler.handleUpdateServer(
      {
        action: 2012,
        data: {
          serverId: 'server-1',
          capabilities: {
            prompts: {
              newPrompt: { enabled: true },
            },
          },
        },
      },
      'admin-token',
    );

    const persistedCapabilities = JSON.parse(update.mock.calls[0][1].capabilities);
    expect(persistedCapabilities).toEqual({
      tools: { existingTool: { enabled: true } },
      resources: { existingResource: { enabled: true } },
      prompts: { newPrompt: { enabled: true } },
    });
  });
});
