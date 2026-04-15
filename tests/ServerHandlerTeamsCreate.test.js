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

describe('ServerHandler Teams OAuth creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    findByServerId.mockResolvedValue(null);
    decryptDataFromString.mockResolvedValue(
      JSON.stringify({
        oauth: {
          clientId: 'teams-client-id',
          clientSecret: 'owner-client-secret',
          code: 'oauth-code',
          redirectUri: 'https://example.com/callback',
          codeVerifier: 'pkce-verifier',
        },
      }),
    );
    encryptData.mockResolvedValue({ encrypted: true });
    exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'teams-access-token',
      refreshToken: 'teams-refresh-token',
      expiresAt: Date.now() + 3600_000,
    });
    create.mockImplementation(async (payload) => payload);
  });

  test('uses direct Teams exchange with PKCE and persists runtime OAuth state', async () => {
    const handler = new ServerHandler();

    const response = await handler.handleCreateServer(
      {
        action: 2010,
        data: {
          serverId: 'teams-server',
          serverName: 'Teams',
          category: ServerCategory.Template,
          authType: ServerAuthType.TeamsAuth,
          allowUserInput: false,
          configTemplate: JSON.stringify({
            oAuthConfig: {
              clientId: 'teams-client-id',
              pkce: {
                required: true,
                method: 'S256',
              },
            },
          }),
          launchConfig: 'encrypted-launch-config',
          lazyStartEnabled: true,
        },
      },
      'owner-token',
    );

    expect(exchangeAuthorizationCode).toHaveBeenCalledWith({
      provider: 'teams',
      tokenUrl: undefined,
      clientId: 'teams-client-id',
      clientSecret: 'owner-client-secret',
      code: 'oauth-code',
      redirectUri: 'https://example.com/callback',
      codeVerifier: 'pkce-verifier',
      scope: undefined,
      tokenMode: undefined,
    });

    const persistedLaunchConfig = JSON.parse(encryptData.mock.calls[0][0]);
    expect(persistedLaunchConfig.oauth).toMatchObject({
      clientId: 'teams-client-id',
      clientSecret: 'owner-client-secret',
      accessToken: 'teams-access-token',
      refreshToken: 'teams-refresh-token',
    });
    expect(persistedLaunchConfig.oauth).not.toHaveProperty('code');
    expect(persistedLaunchConfig.oauth).not.toHaveProperty('redirectUri');
    expect(persistedLaunchConfig.oauth).not.toHaveProperty('codeVerifier');
    expect(typeof persistedLaunchConfig.oauth.expiresAt).toBe('number');
    expect(response.server.usePetaOauthConfig).toBe(false);
    expect(response.server.launchConfig).toBe(JSON.stringify({ encrypted: true }));
  });
});
