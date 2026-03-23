import { jest } from '@jest/globals';

const fetchMock = jest.fn();
const { exchangeAuthorizationCode } = await import('../dist/mcp/oauth/exchange.js');

describe('Pipedrive OAuth authorization code exchange', () => {
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

  test('uses basic auth and extracts apiDomain from the token response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          api_domain: 'https://company.pipedrive.com',
        }),
      headers: new Headers({
        'content-type': 'application/json',
      }),
    });

    const result = await exchangeAuthorizationCode({
      provider: 'pipedrive',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      code: 'authorization-code',
      redirectUri: 'https://example.com/callback',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0];

    expect(url).toBe('https://oauth.pipedrive.com/oauth/token');
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    });
    expect(requestInit.body.toString()).toBe(
      'grant_type=authorization_code&code=authorization-code&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback',
    );

    expect(result).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      apiDomain: 'https://company.pipedrive.com',
      expiresIn: 3600,
    });
    expect(typeof result.expiresAt).toBe('number');
  });
});
