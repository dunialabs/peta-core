import { jest } from '@jest/globals';

const fetchMock = jest.fn();
const { HubSpotAuthStrategy } = await import('../dist/mcp/auth/HubSpotAuthStrategy.js');

describe('HubSpotAuthStrategy', () => {
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

  test('refreshes token and persists updated HubSpot OAuth config', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 1800,
      }),
      text: async () =>
        JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 1800,
        }),
    });

    const strategy = new HubSpotAuthStrategy({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    });

    const tokenInfo = await strategy.refreshToken();
    const oauthConfig = strategy.getCurrentOAuthConfig();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0];

    expect(url).toBe('https://api.hubapi.com/oauth/v3/token');
    expect(requestInit.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(requestInit.body.toString()).toBe(
      'grant_type=refresh_token&client_id=client-id&client_secret=client-secret&refresh_token=refresh-token',
    );

    expect(tokenInfo).toMatchObject({
      accessToken: 'new-access-token',
      expiresIn: 1800,
    });
    expect(typeof tokenInfo.expiresAt).toBe('number');
    expect(oauthConfig).toMatchObject({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'rotated-refresh-token',
      accessToken: 'new-access-token',
    });
  });

  test('reuses cached token when it is still valid', async () => {
    const strategy = new HubSpotAuthStrategy({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      accessToken: 'cached-access-token',
      expiresAt: Date.now() + 15 * 60 * 1000,
    });

    const tokenInfo = await strategy.refreshToken();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenInfo.accessToken).toBe('cached-access-token');
    expect(strategy.getCurrentOAuthConfig()).toBeUndefined();
  });

  test('keeps the existing refresh token when HubSpot does not rotate it', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new-access-token',
        expires_in: 1800,
      }),
      text: async () =>
        JSON.stringify({
          access_token: 'new-access-token',
          expires_in: 1800,
        }),
    });

    const strategy = new HubSpotAuthStrategy({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    });

    await strategy.refreshToken();

    expect(strategy.getCurrentOAuthConfig()).toMatchObject({
      refreshToken: 'refresh-token',
      accessToken: 'new-access-token',
    });
  });
});
