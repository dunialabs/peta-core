import { jest } from '@jest/globals';

const findEnabled = jest.fn().mockResolvedValue([]);
const disable = jest.fn().mockResolvedValue({});

jest.unstable_mockModule('../dist/repositories/ServerRepository.js', () => ({
  ServerRepository: {
    findEnabled,
    disable,
  },
  default: {
    findEnabled,
    disable,
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
const { IntercomAuthStrategy } = await import('../dist/mcp/auth/IntercomAuthStrategy.js');
const { ServerAuthType, ServerCategory } = await import('../dist/types/enums.js');
const { INTERCOM_FAKE_REFRESH_TOKEN } = await import('../dist/mcp/auth/IntercomTokenHelper.js');

describe('ServerManager Intercom OAuth support', () => {
  const manager = ServerManager.instance;

  afterAll(() => {
    manager.stopIdleCheck?.();
  });

  beforeEach(() => {
    manager.stopIdleCheck?.();
    findEnabled.mockResolvedValue([]);
    disable.mockReset();
  });

  test('initializes Intercom OAuth through the managed validation flow and injects region env', async () => {
    const startTokenRefresh = jest.fn().mockResolvedValue('intercom-access-token');
    const serverContext = {
      serverID: 'intercom-server',
      serverEntity: {
        serverId: 'intercom-server',
        serverName: 'Intercom',
        category: ServerCategory.Template,
        authType: ServerAuthType.IntercomAuth,
        usePetaOauthConfig: false,
      },
      startTokenRefresh,
      userToken: undefined,
    };

    const launchConfig = {
      oauth: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: INTERCOM_FAKE_REFRESH_TOKEN,
        accessToken: 'stored-access-token',
        intercomRegion: 'US',
      },
      env: {
        existing: 'value',
      },
    };

    await manager.initializeAuthentication(serverContext, launchConfig, 'user-token');

    expect(serverContext.userToken).toBe('user-token');
    expect(startTokenRefresh).toHaveBeenCalledTimes(1);
    expect(startTokenRefresh.mock.calls[0][0]).toBeInstanceOf(IntercomAuthStrategy);
    expect(launchConfig.env).toEqual({
      existing: 'value',
      accessToken: 'intercom-access-token',
      intercomRegion: 'US',
    });
    expect(launchConfig.oauth).toBeUndefined();
  });

  test('clears persisted Intercom OAuth state and disables owner-managed servers on invalid token', async () => {
    const updateServerLaunchConfig = jest
      .spyOn(manager, 'updateServerLaunchConfig')
      .mockResolvedValue();
    const removeServer = jest.spyOn(manager, 'removeServer').mockResolvedValue(undefined);

    const serverContext = {
      serverID: 'intercom-server',
      serverEntity: {
        serverId: 'intercom-server',
        serverName: 'Intercom',
        allowUserInput: false,
      },
      userToken: 'owner-token',
    };

    await manager.handleInvalidIntercomToken(serverContext, 'token_revoked');

    expect(updateServerLaunchConfig).toHaveBeenCalledWith(serverContext, {
      accessToken: undefined,
      refreshToken: undefined,
      expiresAt: undefined,
      intercomRegion: undefined,
    });
    expect(disable).toHaveBeenCalledWith('intercom-server');
    expect(removeServer).toHaveBeenCalledWith('intercom-server');

    updateServerLaunchConfig.mockRestore();
    removeServer.mockRestore();
  });
});
