import { jest } from '@jest/globals';

const fetchMock = jest.fn();
const { exchangeAuthorizationCode } = await import('../dist/mcp/oauth/exchange.js');

describe('Intercom OAuth authorization code exchange', () => {
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

  test('uses Intercom token endpoint and does not expect refresh token fields', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          token_type: 'Bearer',
          token: 'duplicate-access-token',
          access_token: 'access-token',
        }),
      headers: new Headers({
        'content-type': 'application/json',
      }),
    });

    const result = await exchangeAuthorizationCode({
      provider: 'intercom',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      code: 'authorization-code',
      redirectUri: 'https://example.com/callback',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0];

    expect(url).toBe('https://api.intercom.io/auth/eagle/token');
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(requestInit.body.toString()).toBe(
      'code=authorization-code&client_id=client-id&client_secret=client-secret',
    );
    expect(result).toMatchObject({
      accessToken: 'access-token',
      refreshToken: undefined,
      expiresIn: undefined,
      expiresAt: undefined,
    });
  });
});
