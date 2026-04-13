import { jest } from '@jest/globals';

const findByServerId = jest.fn();
const create = jest.fn();
const decryptDataFromString = jest.fn();
const encryptData = jest.fn();
const exchangeAuthorizationCode = jest.fn();
const enqueueLog = jest.fn();

jest.unstable_mockModule('../dist/repositories/ServerRepository.js', () => ({
  ServerRepository: {
    findByServerId,
    create,
  },
}));

jest.unstable_mockModule('../dist/security/CryptoService.js', () => ({
  CryptoService: {
    decryptDataFromString,
    encryptData,
  },
}));

jest.unstable_mockModule('../dist/mcp/oauth/exchange.js', () => ({
  exchangeAuthorizationCode,
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      enqueueLog,
    }),
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
const { ServerAuthType, ServerCategory } = await import('../dist/types/enums.js');

describe('ServerHandler Slack OAuth creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    findByServerId.mockResolvedValue(null);
    decryptDataFromString.mockResolvedValue(
      JSON.stringify({
        oauth: {
          clientId: 'owner-client-id',
          clientSecret: 'owner-client-secret',
          code: 'oauth-code',
          redirectUri: 'https://example.com/callback',
        },
      }),
    );
    encryptData.mockResolvedValue({ encrypted: true });
    exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'slack-access-token',
      refreshToken: 'slack-refresh-token',
      expiresAt: Date.now() + 3600_000,
    });
    create.mockImplementation(async (payload) => payload);
  });

  test('persists Slack user token mode for owner-managed templates', async () => {
    const handler = new ServerHandler();

    const response = await handler.handleCreateServer(
      {
        action: 2010,
        data: {
          serverId: 'slack-server',
          serverName: 'Slack',
          category: ServerCategory.Template,
          authType: ServerAuthType.SlackAuth,
          allowUserInput: false,
          configTemplate: JSON.stringify({
            oAuthConfig: {
              clientId: 'YOUR_CLIENT_ID',
            },
          }),
          launchConfig: 'encrypted-launch-config',
          lazyStartEnabled: true,
        },
      },
      'owner-token',
    );

    expect(exchangeAuthorizationCode).toHaveBeenCalledWith({
      provider: 'slack',
      tokenUrl: undefined,
      clientId: 'owner-client-id',
      clientSecret: 'owner-client-secret',
      code: 'oauth-code',
      redirectUri: 'https://example.com/callback',
      codeVerifier: undefined,
      scope: undefined,
      tokenMode: 'user',
    });

    const persistedLaunchConfig = JSON.parse(encryptData.mock.calls[0][0]);
    expect(persistedLaunchConfig.oauth).toMatchObject({
      clientId: 'owner-client-id',
      clientSecret: 'owner-client-secret',
      accessToken: 'slack-access-token',
      refreshToken: 'slack-refresh-token',
      tokenMode: 'user',
    });
    expect(typeof persistedLaunchConfig.oauth.expiresAt).toBe('number');
    expect(response.server.usePetaOauthConfig).toBe(false);
    expect(response.server.launchConfig).toBe(JSON.stringify({ encrypted: true }));
  });
});
