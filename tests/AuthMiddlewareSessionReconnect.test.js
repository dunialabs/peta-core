import { jest } from '@jest/globals';

const getSession = jest.fn();
const createSession = jest.fn();
const consumeTerminatedSession = jest.fn();
const getSessionLogger = jest.fn();
const validateTraditionalToken = jest.fn();
const validateOAuthToken = jest.fn();
const findAnonymousServers = jest.fn();
const findUserById = jest.fn();
const enqueueLog = jest.fn();

jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({
  SessionStore: {
    instance: {
      getSession,
      createSession,
      consumeTerminatedSession,
      getSessionLogger,
    },
  },
}));

jest.unstable_mockModule('../dist/security/OAuthTokenValidator.js', () => ({
  OAuthTokenValidator: class OAuthTokenValidator {
    async validateToken(token) {
      return validateOAuthToken(token);
    }
  },
}));

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({
  UserRepository: {
    findByUserId: findUserById,
  },
}));

jest.unstable_mockModule('../dist/config/prisma.js', () => ({
  prisma: {
    server: {
      findMany: findAnonymousServers,
    },
  },
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      enqueueLog,
    }),
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

const { AuthMiddleware } = await import('../dist/middleware/AuthMiddleware.js');

const token = 'a'.repeat(128);
const originalPublicUrl = process.env.PETA_PUBLIC_URL;
function authenticatedContext() {
  return {
    userId: 'user-1',
    token,
    role: 1,
    status: 1,
    permissions: {},
    userPreferences: {},
    launchConfigs: '{}',
    authenticatedAt: new Date('2026-04-27T00:00:00.000Z'),
    expiresAt: null,
    rateLimit: 100,
  };
}

function initializeBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'inspector', version: '1.0.0' },
    },
  };
}

function mockResponse() {
  return {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('AuthMiddleware session reconnect grace', () => {
  beforeEach(() => {
    delete process.env.PETA_PUBLIC_URL;
    getSession.mockReset().mockReturnValue(undefined);
    createSession.mockReset().mockImplementation(async (sessionId, userId, sessionToken, authContext) => ({
      sessionId,
      userId,
      token: sessionToken,
      authContext,
    }));
    consumeTerminatedSession.mockReset();
    getSessionLogger.mockReset().mockReturnValue({
      logAuth: jest.fn(async () => {}),
      updateContext: jest.fn(),
    });
    validateTraditionalToken.mockReset().mockImplementation(async () => authenticatedContext());
    validateOAuthToken.mockReset().mockResolvedValue({ valid: false, error: 'not oauth' });
    findAnonymousServers.mockReset().mockResolvedValue([]);
    findUserById.mockReset().mockResolvedValue({
      userId: 'user-1',
      status: 1,
      role: 1,
      permissions: '{}',
      userPreferences: '{}',
      launchConfigs: '{}',
      expiresAt: 0,
      ratelimit: 10,
      proxyId: 0,
    });
    enqueueLog.mockReset();
  });

  afterAll(() => {
    if (originalPublicUrl === undefined) {
      delete process.env.PETA_PUBLIC_URL;
    } else {
      process.env.PETA_PUBLIC_URL = originalPublicUrl;
    }
  });

  test('reuses a deleted session id only when the tombstone matches the authenticated token', async () => {
    consumeTerminatedSession.mockReturnValue(true);
    const middleware = new AuthMiddleware({ validateToken: validateTraditionalToken });
    const req = {
      method: 'POST',
      body: initializeBody(),
      headers: {
        'mcp-session-id': 'deleted-session',
        authorization: `Bearer ${token}`,
        'user-agent': 'test-agent',
      },
      originalUrl: '/mcp',
      clientIp: '127.0.0.1',
      query: {},
    };
    const res = mockResponse();
    const next = jest.fn();

    await middleware.authenticate(req, res, next);

    expect(consumeTerminatedSession).toHaveBeenCalledWith(
      'deleted-session',
      expect.objectContaining({ userId: 'user-1' }),
      token,
    );
    expect(createSession).toHaveBeenCalledWith(
      'deleted-session',
      'user-1',
      token,
      expect.objectContaining({ userId: 'user-1' }),
      '127.0.0.1',
      'test-agent',
    );
    expect(req.clientSession.sessionId).toBe('deleted-session');
    expect(next).toHaveBeenCalled();
  });

  test('ignores an unknown client-provided session id during initialize', async () => {
    consumeTerminatedSession.mockReturnValue(false);
    const middleware = new AuthMiddleware({ validateToken: validateTraditionalToken });
    const req = {
      method: 'POST',
      body: initializeBody(),
      headers: {
        'mcp-session-id': 'attacker-session',
        authorization: `Bearer ${token}`,
      },
      originalUrl: '/mcp',
      clientIp: '127.0.0.1',
      query: {},
    };
    const res = mockResponse();
    const next = jest.fn();

    await middleware.authenticate(req, res, next);

    expect(createSession).toHaveBeenCalled();
    expect(createSession.mock.calls[0][0]).not.toBe('attacker-session');
    expect(createSession.mock.calls[0][0]).toMatch(/^session-/);
    expect(next).toHaveBeenCalled();
  });

  test('does not expose attacker-controlled forwarded metadata URLs in legacy auth challenges', async () => {
    process.env.PETA_PUBLIC_URL = 'https://gateway.example.test';
    const middleware = new AuthMiddleware({ validateToken: validateTraditionalToken });
    const req = {
      method: 'POST',
      body: initializeBody(),
      headers: {
        host: 'internal.example.test',
        'x-forwarded-host': 'attacker.example.test',
        'x-forwarded-proto': 'https',
      },
      originalUrl: '/mcp',
      query: {},
      protocol: 'http',
      app: { get: jest.fn() },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = mockResponse();

    await middleware.authenticate(req, res, jest.fn());

    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      expect.stringContaining('resource_metadata="https://gateway.example.test/.well-known/oauth-protected-resource"'),
    );
  });

  test('returns safe JSON when an unauthenticated request has a hostile raw Host', async () => {
    const middleware = new AuthMiddleware({ validateToken: validateTraditionalToken });
    const req = {
      method: 'POST',
      body: initializeBody(),
      headers: { host: 'attacker.example' },
      originalUrl: '/mcp',
      protocol: 'http',
      app: { get: jest.fn() },
      socket: { remoteAddress: '203.0.113.8' },
      query: {},
    };
    const res = mockResponse();

    await expect(middleware.authenticate(req, res, jest.fn())).resolves.toBeUndefined();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Authorization header with Bearer token is required' },
    });
    expect(res.setHeader).not.toHaveBeenCalledWith('WWW-Authenticate', expect.anything());
  });

  test('fully redacts a short token when refreshing session user information', async () => {
    const middleware = new AuthMiddleware({ validateToken: validateTraditionalToken });
    const updateAuthContext = jest.fn();
    const session = {
      authContext: authenticatedContext(),
      userId: 'user-1',
      token: '1234567890abcdef',
      sessionId: 'session-1',
      getLastUserInfoRefresh: () => 0,
      updateLastUserInfoRefresh: jest.fn(),
      updateAuthContext,
    };

    await middleware.refreshUserInfoIfNeeded(session);

    expect(updateAuthContext).toHaveBeenCalledWith(expect.objectContaining({ token: '[redacted]' }));
  });

  test('anonymous public initialize can reuse a matching deleted session id', async () => {
    consumeTerminatedSession.mockReturnValue(true);
    findAnonymousServers.mockResolvedValue([
      {
        serverId: 'server-1',
        serverName: 'Public Server',
        authType: 'none',
        anonymousRateLimit: 10,
      },
    ]);
    const middleware = new AuthMiddleware({ validateToken: validateTraditionalToken });
    const req = {
      method: 'POST',
      body: initializeBody(),
      headers: {
        'mcp-session-id': 'anonymous-deleted-session',
        'user-agent': 'anonymous-agent',
      },
      originalUrl: '/mcp/public',
      clientIp: '203.0.113.5',
      query: {},
    };
    const res = mockResponse();
    const next = jest.fn();

    await middleware.authenticate(req, res, next);

    expect(consumeTerminatedSession).toHaveBeenCalledWith(
      'anonymous-deleted-session',
      expect.objectContaining({ kind: 'anonymous' }),
      expect.stringMatching(/^anon-/),
    );
    expect(createSession.mock.calls[0][0]).toBe('anonymous-deleted-session');
    expect(next).toHaveBeenCalled();
  });
});
