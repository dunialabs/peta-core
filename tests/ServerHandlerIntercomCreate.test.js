import { jest } from '@jest/globals';

const findByServerId = jest.fn();
const create = jest.fn();
const decryptDataFromString = jest.fn();
const encryptData = jest.fn();
const exchangeAuthorizationCode = jest.fn();
const enqueueLog = jest.fn();
const fetchMock = jest.fn();

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
const { INTERCOM_FAKE_REFRESH_TOKEN } = await import('../dist/mcp/auth/IntercomTokenHelper.js');

describe('ServerHandler Intercom OAuth creation', () => {
  const originalFetch = global.fetch;

  beforeAll(() => {
    global.fetch = fetchMock;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

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
      accessToken: 'intercom-access-token',
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          app: {
            region: 'US',
          },
        }),
      headers: new Headers({
        'content-type': 'application/json',
      }),
    });
    create.mockImplementation(async (payload) => payload);
  });

  test('persists Intercom region and fake refresh token for owner-managed templates', async () => {
    const handler = new ServerHandler();

    const response = await handler.handleCreateServer(
      {
        action: 2010,
        data: {
          serverId: 'intercom-server',
          serverName: 'Intercom',
          category: ServerCategory.Template,
          authType: ServerAuthType.IntercomAuth,
          allowUserInput: false,
          configTemplate: JSON.stringify({
            oAuthConfig: {
              clientId: 'peta-intercom-client',
            },
          }),
          launchConfig: 'encrypted-launch-config',
          lazyStartEnabled: true,
        },
      },
      'owner-token',
    );

    expect(exchangeAuthorizationCode).toHaveBeenCalledWith({
      provider: 'intercom',
      tokenUrl: undefined,
      clientId: 'owner-client-id',
      clientSecret: 'owner-client-secret',
      code: 'oauth-code',
      redirectUri: 'https://example.com/callback',
      codeVerifier: undefined,
      scope: undefined,
    });

    const persistedLaunchConfig = JSON.parse(encryptData.mock.calls[0][0]);
    expect(persistedLaunchConfig.oauth).toMatchObject({
      clientId: 'owner-client-id',
      clientSecret: 'owner-client-secret',
      accessToken: 'intercom-access-token',
      refreshToken: INTERCOM_FAKE_REFRESH_TOKEN,
      intercomRegion: 'US',
    });
    expect(typeof persistedLaunchConfig.oauth.expiresAt).toBe('number');
    expect(response.server.usePetaOauthConfig).toBe(false);
    expect(response.server.launchConfig).toBe(JSON.stringify({ encrypted: true }));
  });
});
