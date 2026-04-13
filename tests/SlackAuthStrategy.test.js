import { jest } from '@jest/globals';

const fetchMock = jest.fn();
const { SlackAuthStrategy } = await import('../dist/mcp/auth/SlackAuthStrategy.js');

describe('SlackAuthStrategy', () => {
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

  test('refreshes a Slack user token and persists rotated OAuth config', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        authed_user: {
          access_token: 'new-user-access-token',
          refresh_token: 'rotated-user-refresh-token',
          expires_in: 43200,
        },
      }),
      text: async () =>
        JSON.stringify({
          ok: true,
          authed_user: {
            access_token: 'new-user-access-token',
            refresh_token: 'rotated-user-refresh-token',
            expires_in: 43200,
          },
        }),
    });

    const strategy = new SlackAuthStrategy({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      tokenMode: 'user',
    });

    const tokenInfo = await strategy.refreshToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0];

    expect(url).toBe('https://slack.com/api/oauth.v2.access');
    expect(requestInit.body.toString()).toBe(
      'grant_type=refresh_token&client_id=client-id&client_secret=client-secret&refresh_token=refresh-token',
    );
    expect(tokenInfo).toMatchObject({
      accessToken: 'new-user-access-token',
      expiresIn: 43200,
    });
    expect(strategy.getCurrentOAuthConfig()).toMatchObject({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'rotated-user-refresh-token',
      accessToken: 'new-user-access-token',
      tokenMode: 'user',
    });
  });

  test('reuses cached token when it is still valid', async () => {
    const strategy = new SlackAuthStrategy({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      accessToken: 'cached-access-token',
      expiresAt: Date.now() + 15 * 60 * 1000,
      tokenMode: 'user',
    });

    const tokenInfo = await strategy.refreshToken();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenInfo.accessToken).toBe('cached-access-token');
    expect(strategy.getCurrentOAuthConfig()).toBeUndefined();
  });
});
