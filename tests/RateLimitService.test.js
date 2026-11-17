process.env.PETA_MAX_RATE_LIMIT_USERS = '1';

const { RateLimitService } = await import('../dist/security/RateLimitService.js');

describe('RateLimitService admission safety', () => {
  test('clamps invalid limits to a positive value', async () => {
    const service = new RateLimitService();

    expect((await service.checkRateLimit('user-1', 0)).allowed).toBe(true);
    expect((await service.checkRateLimit('user-1', 0)).allowed).toBe(false);
  });

  test('caps new user buckets instead of growing without bound', async () => {
    const service = new RateLimitService();

    expect((await service.checkRateLimit('user-1', 10)).allowed).toBe(true);
    const secondUser = await service.checkRateLimit('user-2', 10);
    expect(secondUser.allowed).toBe(false);
    expect(secondUser.retryAfter).toBe(60);
  });
});
