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
});
