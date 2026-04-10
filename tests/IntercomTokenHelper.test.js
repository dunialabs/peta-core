import { jest } from '@jest/globals';

const fetchMock = jest.fn();
const {
  fetchIntercomTokenMetadata,
  classifyIntercomTokenError,
  IntercomInvalidTokenError,
} = await import('../dist/mcp/auth/IntercomTokenHelper.js');

describe('IntercomTokenHelper', () => {
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

  test('fetches region from /me', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          app: {
            region: 'US',
          },
        }),
      headers: new Headers({
        'content-type': 'application/json',
      }),
    });

    const result = await fetchIntercomTokenMetadata('access-token');

    expect(result).toEqual({ intercomRegion: 'US' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.intercom.io/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          accept: 'application/json',
          authorization: 'Bearer access-token',
        }),
      }),
    );
  });

  test('classifies token error codes as invalid', () => {
    const classification = classifyIntercomTokenError(
      JSON.stringify({
        type: 'error.list',
        errors: [
          {
            code: 'token_revoked',
          },
        ],
      }),
      401,
    );

    expect(classification).toMatchObject({
      invalidToken: true,
      retryable: false,
      status: 401,
      errorCodes: ['token_revoked'],
      parsed: true,
    });
  });

  test('classifies rate limiting as retryable', () => {
    const classification = classifyIntercomTokenError(
      JSON.stringify({
        type: 'error.list',
        errors: [
          {
            code: 'rate_limit_exceeded',
          },
        ],
      }),
      429,
    );

    expect(classification).toMatchObject({
      invalidToken: false,
      retryable: true,
      status: 429,
      errorCodes: ['rate_limit_exceeded'],
      parsed: true,
    });
  });

  test('throws a dedicated error when /me reports an invalid token', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          type: 'error.list',
          errors: [
            {
              code: 'token_expired',
            },
          ],
        }),
      headers: new Headers({
        'content-type': 'application/json',
      }),
    });

    await expect(fetchIntercomTokenMetadata('expired-token')).rejects.toBeInstanceOf(
      IntercomInvalidTokenError,
    );
  });
});
