import { jest } from '@jest/globals';

const fetchMock = jest.fn();
const { PipedriveAuthStrategy } = await import('../dist/mcp/auth/PipedriveAuthStrategy.js');

describe('PipedriveAuthStrategy', () => {
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

  test('refreshes token and keeps apiDomain in persisted config', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
        api_domain: 'https://company.pipedrive.com',
      }),
      text: async () =>
        JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 3600,
          api_domain: 'https://company.pipedrive.com',
        }),
    });

    const strategy = new PipedriveAuthStrategy({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    });

    const tokenInfo = await strategy.refreshToken();
    const oauthConfig = strategy.getCurrentOAuthConfig();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0];

    expect(url).toBe('https://oauth.pipedrive.com/oauth/token');
    expect(requestInit.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    });
    expect(requestInit.body.toString()).toBe(
      'grant_type=refresh_token&refresh_token=refresh-token',
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
      apiDomain: 'https://company.pipedrive.com',
    });
  });

  test('reuses cached tokens when they are still valid', async () => {
    const strategy = new PipedriveAuthStrategy({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      accessToken: 'cached-access-token',
      expiresAt: Date.now() + 15 * 60 * 1000,
      apiDomain: 'https://company.pipedrive.com',
    });

    const tokenInfo = await strategy.refreshToken();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenInfo.accessToken).toBe('cached-access-token');
    expect(strategy.getCurrentOAuthConfig()).toBeUndefined();
  });
});
