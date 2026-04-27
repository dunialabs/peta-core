import { jest } from '@jest/globals';

const getSession = jest.fn();
const createSession = jest.fn();
const consumeTerminatedSession = jest.fn();
const getSessionLogger = jest.fn();
const validateTraditionalToken = jest.fn();
const validateOAuthToken = jest.fn();
const findAnonymousServers = jest.fn();
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
    findByUserId: jest.fn(),
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
    enqueueLog.mockReset();
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
