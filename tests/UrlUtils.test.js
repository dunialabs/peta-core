import express from 'express';

const { getAuthorizationServerUrl, getPublicUrl } = await import('../dist/utils/urlUtils.js');

const originalPublicUrl = process.env.PETA_PUBLIC_URL;

function createRequest(app, headers, protocol = 'http') {
  return {
    app,
    headers,
    protocol,
    socket: { remoteAddress: '127.0.0.1' },
    get(name) {
      return headers[name.toLowerCase()];
    },
  };
}

describe('public URL resolution', () => {
  beforeEach(() => {
    delete process.env.PETA_PUBLIC_URL;
  });

  afterAll(() => {
    if (originalPublicUrl === undefined) {
      delete process.env.PETA_PUBLIC_URL;
    } else {
      process.env.PETA_PUBLIC_URL = originalPublicUrl;
    }
  });

  test('uses PETA_PUBLIC_URL over request-controlled headers', () => {
    process.env.PETA_PUBLIC_URL = 'https://gateway.example/';

    const request = createRequest(express(), {
      host: 'internal.example:3002',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'http',
    });

    expect(getPublicUrl(request)).toBe('https://gateway.example/mcp');
    expect(getAuthorizationServerUrl(request)).toBe('https://gateway.example');
  });

  test('ignores forwarded headers from an untrusted immediate peer', () => {
    const request = createRequest(express(), {
      host: 'localhost:3002',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https',
    });

    expect(getPublicUrl(request)).toBe('http://localhost:3002/mcp');
  });

  test('uses forwarded headers when Express trusts the immediate peer', () => {
    const app = express();
    app.set('trust proxy', true);
    const request = createRequest(app, {
      host: 'internal.example:3002',
      'x-forwarded-host': 'gateway.example',
      'x-forwarded-proto': 'https',
    });

    expect(getPublicUrl(request)).toBe('https://gateway.example/mcp');
  });

  test('rejects an untrusted public Host header', () => {
    const request = createRequest(express(), {
      host: 'attacker.example',
    });

    expect(() => getPublicUrl(request)).toThrow('PETA_PUBLIC_URL or a trusted proxy is required for public URLs');
  });

  test.each([
    ['localhost:3002', 'http://localhost:3002/mcp'],
    ['dev.localhost:3002', 'http://dev.localhost:3002/mcp'],
    ['127.0.0.1:3002', 'http://127.0.0.1:3002/mcp'],
    ['[::1]:3002', 'http://[::1]:3002/mcp'],
    ['[0:0:0:0:0:0:0:1]:3002', 'http://[0:0:0:0:0:0:0:1]:3002/mcp'],
  ])('accepts the local raw Host %s', (host, expected) => {
    const request = createRequest(express(), { host });

    expect(getPublicUrl(request)).toBe(expected);
  });

  test.each([undefined, 'bad host', 'localhost/path', 'localhost:bad-port', 'localhost:', 'localhost#'])(
    'rejects a missing or malformed raw Host header: %s',
    (host) => {
      const request = createRequest(express(), host === undefined ? {} : { host });

      expect(() => getPublicUrl(request)).toThrow('PETA_PUBLIC_URL or a trusted proxy is required for public URLs');
    },
  );
});
