import { jest } from '@jest/globals';

const fetchMock = jest.fn();
const { TeamsAuthStrategy } = await import('../dist/mcp/auth/TeamsAuthStrategy.js');

describe('TeamsAuthStrategy', () => {
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

  test('refreshes token and persists rotated Teams OAuth config', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
      }),
      text: async () =>
        JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 3600,
        }),
    });

    const strategy = new TeamsAuthStrategy({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    });

    const tokenInfo = await strategy.refreshToken();
    const oauthConfig = strategy.getCurrentOAuthConfig();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0];

    expect(url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(requestInit.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(requestInit.body.toString()).toBe(
      'grant_type=refresh_token&client_id=client-id&client_secret=client-secret&refresh_token=refresh-token',
    );

    expect(tokenInfo).toMatchObject({
      accessToken: 'new-access-token',
      expiresIn: 3600,
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
    const strategy = new TeamsAuthStrategy({
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

  test('keeps the existing refresh token when Teams does not rotate it', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new-access-token',
        expires_in: 3600,
      }),
      text: async () =>
        JSON.stringify({
          access_token: 'new-access-token',
          expires_in: 3600,
        }),
    });

    const strategy = new TeamsAuthStrategy({
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
