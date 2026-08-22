import { jest } from '@jest/globals';

const getClientForIssuer = jest.fn(async (_clientId, issuer) => ({
  client_id: 'client-1',
  client_secret: 'stored-confidential-secret',
  issuer,
  client_name: 'Client',
  application_type: 'web',
  redirect_uris: ['https://client.example/callback'],
  scopes: ['mcp:tools'],
  grant_types: ['authorization_code'],
  token_endpoint_auth_method: 'client_secret_post',
}));
const verifyClientCredentials = jest.fn(async () => true);

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/oauth/services/OAuthClientService.js', () => ({
  OAuthClientService: class {
    getClientForIssuer = getClientForIssuer;
    verifyClientCredentials = verifyClientCredentials;
  },
}));

jest.unstable_mockModule('../dist/oauth/services/OAuthService.js', () => ({
  OAuthService: class {
    parseBasicAuth() {
      return null;
    }
  },
}));

jest.unstable_mockModule('../dist/security/TokenValidator.js', () => ({
  TokenValidator: class {},
}));

jest.unstable_mockModule('../dist/security/OAuthTokenValidator.js', () => ({
  OAuthTokenValidator: class {
    async validateToken() {
      return { valid: false };
    }
  },
}));

const { OAuthController } = await import('../dist/oauth/controllers/OAuthController.js');
const originalPublicUrl = process.env.PETA_PUBLIC_URL;

function createReq(overrides = {}) {
  return {
    headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
    protocol: 'https',
    get: () => 'issuer.example',
    ...overrides,
  };
}

function createRes() {
  const res = {
    headers: {},
    statusCode: 200,
    setHeader: jest.fn((key, value) => { res.headers[key] = value; }),
    status: jest.fn((code) => { res.statusCode = code; return res; }),
    json: jest.fn((body) => { res.body = body; return res; }),
  };
  return res;
}

describe('OAuthControllerIssuerLookup', () => {
  beforeEach(() => {
    process.env.PETA_PUBLIC_URL = 'https://issuer.example';
    getClientForIssuer.mockClear();
    verifyClientCredentials.mockClear();
  });

  afterAll(() => {
    if (originalPublicUrl === undefined) {
      delete process.env.PETA_PUBLIC_URL;
    } else {
      process.env.PETA_PUBLIC_URL = originalPublicUrl;
    }
  });

  test('getClientInfo scopes lookup by request issuer', async () => {
    const controller = new OAuthController();
    const res = createRes();

    await controller.getClientInfo(createReq({ params: { clientId: 'client-1' } }), res);

    expect(getClientForIssuer).toHaveBeenCalledWith('client-1', 'https://issuer.example');
    expect(res.body.issuer).toBe('https://issuer.example');
    expect(res.body.client_secret).toBeUndefined();
  });

  test('introspect verifies confidential clients against request issuer', async () => {
    const controller = new OAuthController();
    const res = createRes();

    await controller.introspect(createReq({ body: { token: 'token', client_id: 'client-1', client_secret: 'secret' } }), res);

    expect(getClientForIssuer).toHaveBeenCalledWith('client-1', 'https://issuer.example');
    expect(verifyClientCredentials).toHaveBeenCalledWith('client-1', 'secret', 'https://issuer.example');
    expect(res.body).toEqual({ active: false });
  });
});
