import { jest } from '@jest/globals';

const enqueueLog = jest.fn();
const validateOAuthToken = jest.fn();

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      generateUniformRequestId: jest.fn(() => 'modern-test'),
      enqueueLog,
    }),
  },
}));

jest.unstable_mockModule('../dist/security/OAuthTokenValidator.js', () => ({
  OAuthTokenValidator: class OAuthTokenValidator {
    async validateToken() {
      return validateOAuthToken();
    }
  },
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: { instance: { getAvailableServers: jest.fn(() => []), getServerContext: jest.fn() } },
}));

const { ModernMcpAuthMiddleware } = await import('../dist/mcp/modern/ModernMcpAuthMiddleware.js');
const { ModernMcpController } = await import('../dist/mcp/modern/ModernMcpController.js');
const { RateLimitMiddleware } = await import('../dist/middleware/RateLimitMiddleware.js');

const rawToken = '12345678raw-secret-token-87654321';
const maskedToken = '12345678...87654321';
const originalPublicUrl = process.env.PETA_PUBLIC_URL;

function authenticatedContext() {
  return {
    userId: 'user-1',
    token: rawToken,
    role: 1,
    status: 1,
    permissions: {},
    userPreferences: {},
    launchConfigs: '{}',
    authenticatedAt: new Date('2026-08-20T00:00:00.000Z'),
    expiresAt: null,
    rateLimit: 100,
  };
}

describe('Modern auth token masking', () => {
  beforeEach(() => {
    process.env.PETA_PUBLIC_URL = 'https://gateway.example.test';
    enqueueLog.mockReset();
    validateOAuthToken.mockReset().mockResolvedValue({ valid: true, authContext: authenticatedContext() });
  });

  afterAll(() => {
    if (originalPublicUrl === undefined) {
      delete process.env.PETA_PUBLIC_URL;
    } else {
      process.env.PETA_PUBLIC_URL = originalPublicUrl;
    }
  });

  test('masks an alternate raw AuthContext token before modern auth logging', async () => {
    const middleware = new ModernMcpAuthMiddleware({});
    const req = {
      headers: { authorization: `Bearer ${rawToken}`, host: 'example.test' },
      query: {},
      secure: true,
      clientIp: '127.0.0.1',
      ip: '127.0.0.1',
    };
    const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();

    await middleware.authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(enqueueLog).toHaveBeenCalledWith(expect.objectContaining({ tokenMask: maskedToken }));
    expect(enqueueLog.mock.calls[0][0].tokenMask).not.toBe(rawToken);
  });

  test('masks an alternate raw AuthContext token before modern request logging', async () => {
    const controller = new ModernMcpController();
    const context = {
      req: { clientIp: '127.0.0.1', ip: '127.0.0.1', headers: { 'user-agent': 'test-agent' } },
      authContext: authenticatedContext(),
      protocolVersion: '2026-07-28',
      clientInfo: { name: 'test-client', version: '1.0.0' },
      clientCapabilities: {},
      requestId: 1,
      uniformRequestId: 'modern-test',
      isPublicEndpoint: false,
    };

    await controller.logRequest(context, 'request_tool', 'server-1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {},
    }, undefined, undefined, Date.now(), 200);

    expect(enqueueLog).toHaveBeenCalledWith(expect.objectContaining({ tokenMask: maskedToken }));
    expect(enqueueLog.mock.calls[0][0].tokenMask).not.toBe(rawToken);
  });

  test('fully redacts short tokens instead of reproducing them in the mask', async () => {
    const shortToken = 'short-token';
    validateOAuthToken.mockResolvedValue({
      valid: true,
      authContext: { ...authenticatedContext(), token: shortToken },
    });
    const middleware = new ModernMcpAuthMiddleware({});
    const req = {
      headers: { authorization: `Bearer ${shortToken}`, host: 'example.test' },
      query: {},
      secure: true,
      clientIp: '127.0.0.1',
      ip: '127.0.0.1',
    };
    const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await middleware.authenticate(req, res, jest.fn());

    expect(enqueueLog).toHaveBeenCalledWith(expect.objectContaining({ tokenMask: '[redacted]' }));
    expect(enqueueLog.mock.calls[0][0].tokenMask).not.toContain(shortToken);
  });

  test('fully redacts tokens at the 16-character boundary', async () => {
    const boundaryToken = '1234567890abcdef';
    validateOAuthToken.mockResolvedValue({
      valid: true,
      authContext: { ...authenticatedContext(), token: boundaryToken },
    });
    const middleware = new ModernMcpAuthMiddleware({});
    const req = {
      headers: { authorization: `Bearer ${boundaryToken}`, host: 'example.test' },
      query: {},
      secure: true,
      clientIp: '127.0.0.1',
      ip: '127.0.0.1',
    };
    const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await middleware.authenticate(req, res, jest.fn());

    expect(enqueueLog.mock.calls[0][0].tokenMask).toBe('[redacted]');
  });

  test('masks a raw alternate AuthContext token before rate-limit audit logging', async () => {
    const middleware = new RateLimitMiddleware({
      checkRateLimit: jest.fn().mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetTime: Date.now() + 60_000,
        retryAfter: 60,
      }),
    });
    const req = {
      authContext: authenticatedContext(),
      clientSession: { sessionId: 'session-1' },
      headers: { 'user-agent': 'test-agent' },
      ip: '127.0.0.1',
    };
    const res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await middleware.checkRateLimit(req, res, jest.fn());

    expect(enqueueLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 3003,
      tokenMask: maskedToken,
    }));
    expect(enqueueLog.mock.calls[0][0].tokenMask).not.toBe(rawToken);
  });

  test('builds auth metadata from the canonical public URL', async () => {
    const middleware = new ModernMcpAuthMiddleware({});
    const req = {
      headers: {
        host: 'internal.example.test',
        'x-forwarded-host': 'attacker.example.test',
        'x-forwarded-proto': 'https',
      },
      query: {},
      protocol: 'http',
      app: { get: jest.fn() },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await middleware.authenticate(req, res, jest.fn());

    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      expect.stringContaining('resource_metadata="https://gateway.example.test/.well-known/oauth-protected-resource/mcp"'),
    );
  });

  test('returns safe JSON when an unauthenticated request has a hostile raw Host', async () => {
    delete process.env.PETA_PUBLIC_URL;
    const middleware = new ModernMcpAuthMiddleware({});
    const req = {
      headers: { host: 'attacker.example' },
      query: {},
      protocol: 'http',
      app: { get: jest.fn() },
      socket: { remoteAddress: '203.0.113.8' },
    };
    const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await expect(middleware.authenticate(req, res, jest.fn())).resolves.toBeUndefined();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Authorization header with Bearer token is required' },
      id: null,
    });
    expect(res.setHeader).not.toHaveBeenCalledWith('WWW-Authenticate', expect.anything());
  });
});
