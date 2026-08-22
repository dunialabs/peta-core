import { jest } from '@jest/globals';

process.env.JWT_SECRET = 'test-jwt-secret';

const verifyToken = jest.fn();
const findByUserId = jest.fn();
const findUniqueToken = jest.fn();

jest.unstable_mockModule('jsonwebtoken', () => ({
  default: {
    verify: verifyToken,
    JsonWebTokenError: class JsonWebTokenError extends Error {},
    TokenExpiredError: class TokenExpiredError extends Error {},
  },
}));

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({
  UserRepository: { findByUserId },
}));

jest.unstable_mockModule('../dist/config/prisma.js', () => ({
  prisma: { oAuthToken: { findUnique: findUniqueToken } },
}));

const { OAuthTokenValidator } = await import('../dist/security/OAuthTokenValidator.js');

describe('OAuthTokenValidator token masking', () => {
  beforeEach(() => {
    verifyToken.mockReset().mockReturnValue({
      type: 'access_token',
      client_id: 'client-1',
      user_id: 'user-1',
      scopes: ['mcp:tools'],
      iat: 1_000,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    });
    findUniqueToken.mockReset().mockResolvedValue({
      revoked: false,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      resource: null,
    });
    findByUserId.mockReset().mockResolvedValue({
      userId: 'user-1',
      status: 1,
      role: 3,
      permissions: '{}',
      userPreferences: '{}',
      launchConfigs: '{}',
      expiresAt: 0,
      ratelimit: 10,
      proxyId: 0,
    });
  });

  test('fully redacts an OAuth token at the 16-character boundary', async () => {
    const token = '1234567890abcdef';
    const result = await new OAuthTokenValidator().validateToken(token);

    expect(result.valid).toBe(true);
    expect(result.authContext?.token).toBe('[redacted]');
    expect(result.authContext?.token).not.toContain(token);
  });
});
