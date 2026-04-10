import { jest } from '@jest/globals';

const fetchMock = jest.fn();
const { IntercomAuthStrategy } = await import('../dist/mcp/auth/IntercomAuthStrategy.js');
const {
  IntercomInvalidTokenError,
  INTERCOM_FAKE_REFRESH_TOKEN,
  INTERCOM_SYNTHETIC_EXPIRES_IN,
} = await import('../dist/mcp/auth/IntercomTokenHelper.js');

describe('IntercomAuthStrategy', () => {
  const originalFetch = global.fetch;

  beforeAll(() => {
    global.fetch = fetchMock;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  test('validates the current token and persists region metadata', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          app: {
            region: 'EU',
          },
        }),
      headers: new Headers({
        'content-type': 'application/json',
      }),
    });

    const strategy = new IntercomAuthStrategy({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: INTERCOM_FAKE_REFRESH_TOKEN,
      accessToken: 'access-token',
    });

    const tokenInfo = await strategy.getInitialToken();

    expect(tokenInfo.accessToken).toBe('access-token');
    expect(tokenInfo.expiresIn).toBe(INTERCOM_SYNTHETIC_EXPIRES_IN);
    expect(tokenInfo.expiresAt).toBeGreaterThan(Date.now());

    expect(strategy.getCurrentOAuthConfig()).toMatchObject({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: INTERCOM_FAKE_REFRESH_TOKEN,
      accessToken: 'access-token',
      intercomRegion: 'EU',
      expiresAt: tokenInfo.expiresAt,
    });

    strategy.markConfigAsPersisted();
    expect(strategy.getCurrentOAuthConfig()).toBeUndefined();
  });

  test('throws a dedicated invalid-token error when /me rejects the token', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          type: 'error.list',
          errors: [
            {
              code: 'token_revoked',
            },
          ],
        }),
      headers: new Headers({
        'content-type': 'application/json',
      }),
    });

    const strategy = new IntercomAuthStrategy({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: INTERCOM_FAKE_REFRESH_TOKEN,
      accessToken: 'access-token',
    });

    await expect(strategy.refreshToken()).rejects.toBeInstanceOf(IntercomInvalidTokenError);
  });
});
