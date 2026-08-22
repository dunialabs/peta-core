import { jest } from '@jest/globals';

const savedEntries = [];

jest.unstable_mockModule('../dist/repositories/LogRepository.js', () => ({
  LogRepository: {
    save: jest.fn(async entry => {
      savedEntries.push(entry);
      return entry;
    }),
  },
}));

const { LogService } = await import('../dist/log/LogService.js');

describe('LogService persistent log redaction', () => {
  test('redacts nested credentials and malformed credential text before persistence', async () => {
    const logService = LogService.getInstance();
    const credentialValues = {
      authorization: 'request-authorization', proxyKey: 'request-proxy-key', proxy_key: 'request-proxy-key-underscore',
      apiKey: 'request-api-key', api_key: 'request-api-key-underscore', apikey: 'request-apikey',
      accessToken: 'request-access-token', access_token: 'request-access-token-underscore',
      refreshToken: 'request-refresh-token', refresh_token: 'request-refresh-token-underscore',
      idToken: 'request-id-token', id_token: 'request-id-token-underscore', token: 'request-token',
      clientSecret: 'request-client-secret', client_secret: 'request-client-secret-underscore',
      authConf: [{ key: 'AUTH_KEY', value: 'request-auth-conf-value' }],
      privateKey: 'request-private-key', cookie: 'request-cookie',
      'api-key': 'request-api-key-hyphenated',
      vendorToken: 'request-vendor-token',
      password: 'request-password', secret: 'request-secret', credential: 'request-credential',
    };
    const requestParams = JSON.stringify({
      method: 'tools/call',
      params: {
        query: 'keep this',
        connection: credentialValues,
        credentials: 'request-credentials',
      },
    });
    const responseResult = JSON.stringify({
      content: [{ text: 'keep this response' }],
      nested: { accessToken: 'response-access-token', id_token: 'response-id-token' },
    });
    const error = 'upstream failed: Bearer error-bearer-token; Authorization: Basic error-basic-credential; "client_secret":"error-client-secret"; "api-key":"error-api-key"; vendorToken=error-vendor-token; refresh_token: error-refresh-token';

    await logService.enqueueLog({ action: 1, requestParams, responseResult, error });
    await logService.shutdown();

    expect(savedEntries).toHaveLength(1);
    const [savedEntry] = savedEntries;
    expect(JSON.parse(savedEntry.requestParams)).toEqual({
      method: 'tools/call',
      params: {
        query: 'keep this',
        connection: Object.fromEntries(Object.keys(credentialValues).map(key => [key, '[REDACTED]'])),
        credentials: '[REDACTED]',
      },
    });
    expect(JSON.parse(savedEntry.responseResult)).toEqual({
      content: [{ text: 'keep this response' }],
      nested: { accessToken: '[REDACTED]', id_token: '[REDACTED]' },
    });
    expect(savedEntry.error).toContain('upstream failed');
    expect(savedEntry.error).toContain('Bearer [REDACTED]');
    expect(savedEntry.error).not.toContain('error-basic-credential');
    expect(savedEntry.error).toContain('"client_secret":"[REDACTED]"');
    expect(savedEntry.error).toContain('"api-key":"[REDACTED]"');
    expect(savedEntry.error).toContain('vendorToken=[REDACTED]');
    expect(savedEntry.error).toContain('refresh_token: [REDACTED]');
    expect(JSON.stringify(savedEntry)).not.toMatch(
      /request-(authorization|proxy-key|api-key|apikey|access-token|refresh-token|id-token|token|client-secret|auth-conf-value|private-key|cookie|password|secret|credential|credentials|vendor-token)|response-access-token|response-id-token|error-bearer-token|error-basic-credential|error-client-secret|error-api-key|error-vendor-token|error-refresh-token/,
    );
  });

  test('preserves JSON-looking error text while redacting its Bearer credential', async () => {
    const error = '{ "code": "audit", "detail": "Bearer json-looking-error-token" }';

    await LogService.getInstance().enqueueLog({ action: 2, error });

    expect(savedEntries[1].error).toBe('{ "code": "audit", "detail": "Bearer [REDACTED]" }');
  });

  test('redacts credentials inside a double-encoded structured payload', async () => {
    const requestParams = JSON.stringify(JSON.stringify({ nested: { client_secret: 'double-encoded-secret' } }));

    await LogService.getInstance().enqueueLog({ action: 3, requestParams });

    expect(JSON.parse(JSON.parse(savedEntries[2].requestParams))).toEqual({
      nested: { client_secret: '[REDACTED]' },
    });
  });

  test('falls back to text redaction when nested request payload sanitization overflows', async () => {
    const requestParams = `${'['.repeat(20_000)}"Bearer pathological-token"${']'.repeat(20_000)}`;

    await expect(LogService.getInstance().enqueueLog({ action: 4, requestParams })).resolves.toBeUndefined();

    expect(savedEntries[3].requestParams).toBe(
      `${'['.repeat(20_000)}"Bearer [REDACTED]"${']'.repeat(20_000)}`,
    );
  });

  test('redacts credential-bearing JSON error payloads at the persistence boundary', async () => {
    const error = JSON.stringify({
      authConf: [{ key: 'AUTH_KEY', value: 'error-auth-conf-value-marker' }],
      launchConfig: { privateKey: 'error-private-key-marker', cookie: 'error-cookie-marker' },
      detail: 'Bearer error-bearer-marker',
    });

    await LogService.getInstance().enqueueLog({ action: 5, error });

    const savedError = savedEntries.at(-1).error;
    expect(JSON.parse(savedError)).toEqual({
      authConf: '[REDACTED]',
      launchConfig: { privateKey: '[REDACTED]', cookie: '[REDACTED]' },
      detail: 'Bearer [REDACTED]',
    });
    expect(savedError).not.toContain('error-auth-conf-value-marker');
    expect(savedError).not.toContain('error-private-key-marker');
    expect(savedError).not.toContain('error-cookie-marker');
    expect(savedError).not.toContain('error-bearer-marker');
  });

  test('preserves JSON error formatting when scalar credentials can be redacted in place', async () => {
    const error = '{  "token" : "formatted-secret-marker" , "message" : "keep" }';

    await LogService.getInstance().enqueueLog({ action: 6, error });

    expect(savedEntries.at(-1).error).toBe('{  "token" : "[REDACTED]" , "message" : "keep" }');
  });
});
