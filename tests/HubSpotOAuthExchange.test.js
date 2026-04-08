import { jest } from '@jest/globals';

const fetchMock = jest.fn();
const { exchangeAuthorizationCode } = await import('../dist/mcp/oauth/exchange.js');

describe('HubSpot OAuth authorization code exchange', () => {
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

  test('uses form params and extracts refresh token from the token response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 1800,
        }),
      headers: new Headers({
        'content-type': 'application/json',
      }),
    });

    const result = await exchangeAuthorizationCode({
      provider: 'hubspot',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      code: 'authorization-code',
      redirectUri: 'https://example.com/callback',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0];

    expect(url).toBe('https://api.hubapi.com/oauth/v3/token');
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(requestInit.body.toString()).toBe(
      'grant_type=authorization_code&client_id=client-id&client_secret=client-secret&code=authorization-code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback',
    );

    expect(result).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 1800,
    });
    expect(typeof result.expiresAt).toBe('number');
  });
});
