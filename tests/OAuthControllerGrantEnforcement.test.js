import { jest } from '@jest/globals';

process.env.JWT_SECRET = 'test-jwt-secret';

let client = {
  client_id: 'client-1',
  issuer: 'https://issuer.example',
  client_name: 'Client',
  application_type: 'web',
  redirect_uris: ['https://client.example/callback'],
  grant_types: ['authorization_code'],
  response_types: ['code'],
  scopes: ['mcp:tools'],
  token_endpoint_auth_method: 'none',
};
let registerClientError = null;
const codeCreate = jest.fn();
const codeFindUnique = jest.fn();
const codeUpdateMany = jest.fn();
const tokenCreate = jest.fn();

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/config/prisma.js', () => ({
  prisma: {
    oAuthAuthorizationCode: {
      create: codeCreate,
      findUnique: codeFindUnique,
      updateMany: codeUpdateMany,
    },
    oAuthToken: { create: tokenCreate },
  },
}));

jest.unstable_mockModule('../dist/oauth/services/OAuthClientService.js', () => ({
  OAuthClientService: class {
    async getClientForIssuer() {
      return client;
    }
    async registerClient(metadata) {
      if (registerClientError) {
        throw registerClientError;
      }
      client = {
        client_id: metadata.client_id,
        issuer: 'https://issuer.example',
        client_name: 'URL Client',
        application_type: 'web',
        redirect_uris: ['https://client.example/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scopes: ['mcp:tools'],
        token_endpoint_auth_method: 'none',
      };
      return client;
    }
    async verifyClientCredentials() {
      return true;
    }
  },
}));

jest.unstable_mockModule('../dist/security/TokenValidator.js', () => ({
  TokenValidator: class {
    async validateToken() {
      return { userId: 'user-1' };
    }
  },
}));

jest.unstable_mockModule('../dist/security/OAuthTokenValidator.js', () => ({
  OAuthTokenValidator: class {},
}));

const { OAuthController } = await import('../dist/oauth/controllers/OAuthController.js');

function createReq(body) {
  return {
    body,
    headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
    protocol: 'https',
    get: () => 'issuer.example',
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

function authCode(overrides = {}) {
  return {
    code: 'code-1',
    clientId: 'client-1',
    userId: 'user-1',
    redirectUri: 'https://client.example/callback',
    scopes: ['mcp:tools'],
    resource: 'https://issuer.example/mcp',
    codeChallenge: null,
    challengeMethod: null,
    expiresAt: new Date(Date.now() + 60_000),
    used: false,
    ...overrides,
  };
}

describe('OAuthControllerGrantEnforcement', () => {
  beforeEach(() => {
    client = {
      client_id: 'client-1',
      issuer: 'https://issuer.example',
      client_name: 'Client',
      application_type: 'web',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scopes: ['mcp:tools'],
      token_endpoint_auth_method: 'none',
    };
    codeCreate.mockReset();
    codeFindUnique.mockReset();
    codeUpdateMany.mockReset();
    tokenCreate.mockReset();
    registerClientError = null;
  });

  test('authorization rejects scopes outside registered client scopes', async () => {
    const controller = new OAuthController();
    const res = createRes();

    await controller.authorize(createReq({
      client_id: 'client-1',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:resources',
      approved: true,
      user_token: 'user-token',
    }), res);

    expect(res.body.redirect).toContain('error=invalid_scope');
    expect(codeCreate).not.toHaveBeenCalled();
  });

  test('authorization auto-registers URL client_id metadata documents', async () => {
    client = null;
    codeCreate.mockResolvedValue({});
    const controller = new OAuthController();
    const res = createRes();

    await controller.authorize(createReq({
      client_id: 'https://client.example/metadata.json',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:tools',
      approved: true,
      user_token: 'user-token',
    }), res);

    expect(codeCreate.mock.calls[0][0].data.clientId).toBe('https://client.example/metadata.json');
    expect(res.body.redirect).toContain('code=');
  });

  test('authorization maps URL client_id metadata errors to 400', async () => {
    client = null;
    registerClientError = new Error('invalid_client_metadata: client_id is already registered for a different issuer');
    const controller = new OAuthController();
    const res = createRes();

    await controller.authorize(createReq({
      client_id: 'https://client.example/metadata.json',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:tools',
      approved: true,
      user_token: 'user-token',
    }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'client_id is already registered for a different issuer',
    });
  });

  test('authorization_code grant is denied when client did not register it', async () => {
    client = { ...client, grant_types: ['refresh_token'] };
    const controller = new OAuthController();
    const res = createRes();

    await controller.token(createReq({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://client.example/callback', client_id: 'client-1' }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(codeFindUnique).not.toHaveBeenCalled();
  });

  test('authorization_code exchange omits refresh token when client lacks refresh_token grant', async () => {
    codeFindUnique.mockResolvedValue(authCode());
    codeUpdateMany.mockResolvedValue({ count: 1 });
    tokenCreate.mockResolvedValue({});
    const controller = new OAuthController();
    const res = createRes();

    await controller.token(createReq({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://client.example/callback', client_id: 'client-1' }), res);

    expect(res.body.refresh_token).toBeUndefined();
    expect(tokenCreate.mock.calls[0][0].data.refreshToken).toBeNull();
  });

  test('authorization_code exchange fails when atomic code claim loses the race', async () => {
    codeFindUnique.mockResolvedValue(authCode());
    codeUpdateMany.mockResolvedValue({ count: 0 });
    const controller = new OAuthController();
    const res = createRes();

    await controller.token(createReq({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://client.example/callback', client_id: 'client-1' }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(tokenCreate).not.toHaveBeenCalled();
  });
});
