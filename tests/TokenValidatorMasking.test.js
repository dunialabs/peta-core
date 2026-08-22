import { jest } from '@jest/globals';

const calculateUserId = jest.fn();
const findByUserId = jest.fn();

jest.unstable_mockModule('../dist/security/CryptoService.js', () => ({
  CryptoService: { calculateUserId },
}));

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({
  UserRepository: { findByUserId },
}));

const { TokenValidator } = await import('../dist/security/TokenValidator.js');

describe('TokenValidator token masking', () => {
  beforeEach(() => {
    calculateUserId.mockReset().mockResolvedValue('user-1');
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

  test('fully redacts a legacy token at the 16-character boundary', async () => {
    const token = '1234567890abcdef';
    const result = await new TokenValidator().validateToken(token);

    expect(result.token).toBe('[redacted]');
    expect(result.token).not.toContain(token);
  });
});
