import { jest } from '@jest/globals';

const fetchMock = jest.fn();
const { exchangeAuthorizationCode } = await import('../dist/mcp/oauth/exchange.js');

describe('Slack OAuth authorization code exchange', () => {
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

  test('extracts user tokens from authed_user when tokenMode is user', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          access_token: 'bot-access-token',
          authed_user: {
            access_token: 'user-access-token',
            refresh_token: 'user-refresh-token',
            expires_in: 43200,
          },
        }),
      headers: new Headers({
        'content-type': 'application/json',
      }),
    });

    const result = await exchangeAuthorizationCode({
      provider: 'slack',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      code: 'authorization-code',
      redirectUri: 'https://example.com/callback',
      tokenMode: 'user',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0];

    expect(url).toBe('https://slack.com/api/oauth.v2.access');
    expect(requestInit.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(requestInit.body.toString()).toBe(
      'code=authorization-code&client_id=client-id&client_secret=client-secret&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback',
    );
    expect(result).toMatchObject({
      accessToken: 'user-access-token',
      refreshToken: 'user-refresh-token',
      expiresIn: 43200,
    });
    expect(typeof result.expiresAt).toBe('number');
  });

  test('extracts bot tokens from the top level when tokenMode is bot', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          access_token: 'bot-access-token',
          refresh_token: 'bot-refresh-token',
          expires_in: 43200,
        }),
      headers: new Headers({
        'content-type': 'application/json',
      }),
    });

    const result = await exchangeAuthorizationCode({
      provider: 'slack',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      code: 'authorization-code',
      redirectUri: 'https://example.com/callback',
      tokenMode: 'bot',
    });

    expect(result).toMatchObject({
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresIn: 43200,
    });
  });

  test('fails when user mode response does not include authed_user.access_token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          access_token: 'bot-access-token',
        }),
      headers: new Headers({
        'content-type': 'application/json',
      }),
    });

    await expect(
      exchangeAuthorizationCode({
        provider: 'slack',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        code: 'authorization-code',
        redirectUri: 'https://example.com/callback',
        tokenMode: 'user',
      }),
    ).rejects.toMatchObject({
      name: 'OAuthExchangeError',
      type: 'parse',
      message:
        "Slack OAuth response missing authed_user.access_token for tokenMode='user'",
    });
  });
});
