import { jest } from '@jest/globals';

const findByServerId = jest.fn();
const findById = jest.fn();
const updateLaunchConfigs = jest.fn();
const updateUserPreferences = jest.fn();
const decryptDataFromString = jest.fn();
const hash = jest.fn();
const encryptData = jest.fn();
const createTemporaryServer = jest.fn();
const getUserSessions = jest.fn().mockReturnValue([]);
const updateSessionUserPreferences = jest.fn();
const notifyPermissionChangedByUser = jest.fn().mockResolvedValue(true);
const fetchMock = jest.fn();
const exchangeAuthorizationCode = jest.fn();

jest.unstable_mockModule('../dist/repositories/ServerRepository.js', () => ({
  ServerRepository: {
    findByServerId,
  },
}));

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({
  default: {
    findById,
    updateLaunchConfigs,
    updateUserPreferences,
  },
}));

jest.unstable_mockModule('../dist/security/CryptoService.js', () => ({
  CryptoService: {
    decryptDataFromString,
    hash,
    encryptData,
  },
}));

jest.unstable_mockModule('../dist/mcp/oauth/exchange.js', () => ({
  exchangeAuthorizationCode,
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: {
    instance: {
      createTemporaryServer,
    },
  },
}));

jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({
  SessionStore: {
    instance: {
      getUserSessions,
      updateUserPreferences: updateSessionUserPreferences,
    },
  },
}));

jest.unstable_mockModule('../dist/socket/SocketNotifier.js', () => ({
  socketNotifier: {
    notifyPermissionChangedByUser,
  },
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

const { UserRequestHandler } = await import('../dist/user/UserRequestHandler.js');
const { ServerCategory, ServerAuthType } = await import('../dist/types/enums.js');
const { UserErrorCode } = await import('../dist/user/types.js');

function makeServer(overrides = {}) {
  return {
    serverId: 'github-oauth',
    serverName: 'GitHub OAuth',
    enabled: true,
    allowUserInput: true,
    configTemplate: JSON.stringify({
      oAuthConfig: {
        deskClientId: 'desk-client-id',
        userClientId: 'user-client-id',
      },
    }),
    launchConfig: 'encrypted-launch-config',
    category: ServerCategory.Template,
    authType: ServerAuthType.GithubAuth,
    ...overrides,
  };
}

function makeUser(overrides = {}) {
  return {
    userId: 'user-1',
    launchConfigs: '{}',
    userPreferences: '{}',
    ...overrides,
  };
}

describe('UserRequestHandler.handleConfigureServer', () => {
  const originalFetch = global.fetch;
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    global.fetch = fetchMock;
  });

  afterAll(() => {
    global.fetch = originalFetch;
    process.env.JWT_SECRET = originalJwtSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();

    process.env.JWT_SECRET = 'jwt-secret';

    findByServerId.mockResolvedValue(makeServer());
    findById.mockResolvedValue(makeUser());
    decryptDataFromString.mockResolvedValue(
      JSON.stringify({
        oauth: {
          clientId: 'user-client-id',
        },
      }),
    );
    hash.mockResolvedValue('hashed-key');
    encryptData.mockResolvedValue({ encrypted: true });
    createTemporaryServer.mockResolvedValue({
      getMcpCapabilities: () => ({ tools: {}, resources: {}, prompts: {} }),
    });
    getUserSessions.mockReturnValue([]);
    updateSessionUserPreferences.mockResolvedValue(undefined);
    notifyPermissionChangedByUser.mockResolvedValue(true);
    exchangeAuthorizationCode.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        accessToken: 'access-token',
        expiresAt: Date.now() + 3600_000,
      }),
    });
  });

  test('configures OAuth template servers when PKCE verifier is omitted', async () => {
    const result = await UserRequestHandler.instance.handleConfigureServer('user-1', 'user-token', {
      serverId: 'github-oauth',
      authConf: [
        {
          key: 'YOUR_OAUTH_CODE',
          value: 'oauth-code',
          dataType: 1,
        },
        {
          key: 'YOUR_OAUTH_REDIRECT_URL',
          value: 'http://localhost',
          dataType: 1,
        },
      ],
    });

    expect(result).toEqual({
      serverId: 'github-oauth',
      message: 'Server configured and started successfully',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, requestInit] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(requestInit.body);

    expect(requestBody).toMatchObject({
      clientId: 'user-client-id',
      provider: 'github',
      key: 'hashed-key',
      code: 'oauth-code',
      redirectUri: 'http://localhost',
    });
    expect(requestBody).not.toHaveProperty('codeVerifier');
    expect(updateLaunchConfigs).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        'github-oauth': { encrypted: true },
      }),
    );
    expect(updateUserPreferences).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        'github-oauth': { tools: {}, resources: {}, prompts: {} },
      }),
    );
    expect(notifyPermissionChangedByUser).toHaveBeenCalledWith('user-1');
    expect(updateSessionUserPreferences).toHaveBeenCalledWith('user-1');
  });

  test('returns a validation error when the OAuth code is missing', async () => {
    await expect(
      UserRequestHandler.instance.handleConfigureServer('user-1', 'user-token', {
        serverId: 'github-oauth',
        authConf: [
          {
            key: 'YOUR_OAUTH_REDIRECT_URL',
            value: 'http://localhost',
            dataType: 1,
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'UserError',
      code: UserErrorCode.SERVER_CONFIG_INVALID,
      message: 'code is required and cannot be empty',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateLaunchConfigs).not.toHaveBeenCalled();
  });

  test('uses the hubspot provider for Peta-managed HubSpot OAuth without dynamic-provider fields', async () => {
    findByServerId.mockResolvedValue(
      makeServer({
        serverId: 'hubspot-oauth',
        serverName: 'HubSpot OAuth',
        authType: ServerAuthType.HubSpotAuth,
      }),
    );
    decryptDataFromString.mockResolvedValue(
      JSON.stringify({
        oauth: {
          clientId: 'user-client-id',
        },
      }),
    );

    const result = await UserRequestHandler.instance.handleConfigureServer('user-1', 'user-token', {
      serverId: 'hubspot-oauth',
      authConf: [
        {
          key: 'YOUR_OAUTH_CODE',
          value: 'hubspot-code',
          dataType: 1,
        },
        {
          key: 'YOUR_OAUTH_REDIRECT_URL',
          value: 'https://example.com/hubspot/callback',
          dataType: 1,
        },
      ],
    });

    expect(result).toEqual({
      serverId: 'hubspot-oauth',
      message: 'Server configured and started successfully',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, requestInit] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/v1\/oauth\/exchange$/);

    const requestBody = JSON.parse(requestInit.body);
    expect(requestBody).toMatchObject({
      clientId: 'user-client-id',
      provider: 'hubspot',
      key: 'hashed-key',
      code: 'hubspot-code',
      redirectUri: 'https://example.com/hubspot/callback',
    });
    expect(requestBody).not.toHaveProperty('tokenUrl');
    expect(requestBody).not.toHaveProperty('scope');
    expect(requestBody).not.toHaveProperty('codeVerifier');
  });

  test('configures Intercom OAuth templates through direct exchange and persists region metadata', async () => {
    findByServerId.mockResolvedValue(
      makeServer({
        serverId: 'intercom-oauth',
        serverName: 'Intercom OAuth',
        authType: ServerAuthType.IntercomAuth,
        configTemplate: JSON.stringify({
          oAuthConfig: {
            deskClientId: 'owner-client-id',
            userClientId: 'user-client-id',
          },
        }),
      }),
    );
    decryptDataFromString.mockResolvedValue(
      JSON.stringify({
        oauth: {
          clientId: 'user-client-id',
          clientSecret: 'owner-client-secret',
        },
      }),
    );
    exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'intercom-access-token',
    });
    fetchMock.mockResolvedValueOnce({
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

    const result = await UserRequestHandler.instance.handleConfigureServer('user-1', 'user-token', {
      serverId: 'intercom-oauth',
      authConf: [
        {
          key: 'YOUR_OAUTH_CODE',
          value: 'intercom-code',
          dataType: 1,
        },
        {
          key: 'YOUR_OAUTH_REDIRECT_URL',
          value: 'https://example.com/intercom/callback',
          dataType: 1,
        },
      ],
    });

    expect(result).toEqual({
      serverId: 'intercom-oauth',
      message: 'Server configured and started successfully',
    });
    expect(exchangeAuthorizationCode).toHaveBeenCalledWith({
      provider: 'intercom',
      tokenUrl: undefined,
      clientId: 'user-client-id',
      clientSecret: 'owner-client-secret',
      code: 'intercom-code',
      redirectUri: 'https://example.com/intercom/callback',
      codeVerifier: undefined,
      scope: undefined,
    });

    const persistedLaunchConfig = JSON.parse(encryptData.mock.calls[0][0]);
    expect(persistedLaunchConfig.oauth).toMatchObject({
      clientId: 'user-client-id',
      clientSecret: 'owner-client-secret',
      accessToken: 'intercom-access-token',
      refreshToken: '__INTERCOM_NO_REFRESH_TOKEN__',
      intercomRegion: 'US',
    });
    expect(typeof persistedLaunchConfig.oauth.expiresAt).toBe('number');
  });
});
