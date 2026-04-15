import { jest } from '@jest/globals';

const findEnabled = jest.fn().mockResolvedValue([]);

jest.unstable_mockModule('../dist/repositories/ServerRepository.js', () => ({
  ServerRepository: {
    findEnabled,
  },
  default: {
    findEnabled,
  },
}));

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({
  UserRepository: {},
  default: {},
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

const { ServerManager } = await import('../dist/mcp/core/ServerManager.js');
const { TeamsAuthStrategy } = await import('../dist/mcp/auth/TeamsAuthStrategy.js');
const { ServerAuthType, ServerCategory } = await import('../dist/types/enums.js');

describe('ServerManager Teams OAuth initialization', () => {
  const manager = ServerManager.instance;

  beforeEach(() => {
    manager.stopIdleCheck?.();
    findEnabled.mockResolvedValue([]);
  });

  test('initializes Teams OAuth through the refresh flow and injects accessToken env', async () => {
    const startTokenRefresh = jest.fn().mockResolvedValue('teams-access-token');
    const serverContext = {
      serverID: 'teams-server',
      serverEntity: {
        serverId: 'teams-server',
        serverName: 'Teams',
        category: ServerCategory.Template,
        authType: ServerAuthType.TeamsAuth,
        usePetaOauthConfig: false,
      },
      startTokenRefresh,
      userToken: undefined,
    };

    const launchConfig = {
      oauth: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
      },
      env: {
        existing: 'value',
      },
    };

    await manager.initializeAuthentication(serverContext, launchConfig, 'user-token');

    expect(serverContext.userToken).toBe('user-token');
    expect(startTokenRefresh).toHaveBeenCalledTimes(1);
    expect(startTokenRefresh.mock.calls[0][0]).toBeInstanceOf(TeamsAuthStrategy);
    expect(launchConfig.env).toEqual({
      existing: 'value',
      accessToken: 'teams-access-token',
    });
    expect(launchConfig.oauth).toBeUndefined();
  });
});
