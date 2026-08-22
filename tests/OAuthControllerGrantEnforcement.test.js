import { jest } from '@jest/globals';
import crypto from 'crypto';

process.env.JWT_SECRET = 'test-jwt-secret';
const originalPublicUrl = process.env.PETA_PUBLIC_URL;

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
let tokenValidationError = null;
const codeCreate = jest.fn();
const codeFindUnique = jest.fn();
const codeUpdateMany = jest.fn();
const tokenCreate = jest.fn();
const proxyFindFirst = jest.fn();
const registerClientMock = jest.fn(async (metadata) => {
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
    scopes: ['mcp:tools', 'mcp:resources', 'mcp:prompts'],
    token_endpoint_auth_method: 'none',
  };
  return client;
});

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

jest.unstable_mockModule('../dist/repositories/ProxyRepository.js', () => ({
  ProxyRepository: {
    findFirst: proxyFindFirst,
  },
}));

jest.unstable_mockModule('../dist/oauth/services/OAuthClientService.js', () => ({
  OAuthClientService: class {
    async getClientForIssuer() {
      return client;
    }
    async registerClient(metadata) {
      return registerClientMock(metadata);
    }
    async verifyClientCredentials() {
      return true;
    }
  },
}));

jest.unstable_mockModule('../dist/security/TokenValidator.js', () => ({
  TokenValidator: class {
    async validateToken() {
      if (tokenValidationError) {
        throw tokenValidationError;
      }
      return { userId: 'user-1' };
    }
  },
}));

jest.unstable_mockModule('../dist/security/OAuthTokenValidator.js', () => ({
  OAuthTokenValidator: class {},
}));

const { OAuthController } = await import('../dist/oauth/controllers/OAuthController.js');
const { deskAuthorizationFlowService } = await import('../dist/oauth/services/DeskAuthorizationFlowService.js');

function createReq(body = {}) {
  return {
    body: {
      code_challenge: s256CodeChallenge,
      code_challenge_method: 'S256',
      ...body,
    },
    query: {},
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
    send: jest.fn((body) => { res.body = body; return res; }),
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

const codeVerifier = 'test-code-verifier';
const s256CodeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

function authorizeQuery(overrides = {}) {
  return {
    response_type: 'code',
    client_id: 'client-1',
    redirect_uri: 'https://client.example/callback',
    scope: 'mcp:tools',
    state: 'state-1',
    code_challenge: 'challenge-1',
    code_challenge_method: 'S256',
    resource: 'https://issuer.example/mcp',
    ...overrides,
  };
}

function extractDeskFlowId(html) {
  const match = html.match(/const deskFlowId = "([^"]+)"/);
  if (!match) {
    throw new Error('Desk flow ID not found in authorization page');
  }
  return match[1];
}

describe('OAuthControllerGrantEnforcement', () => {
  beforeEach(() => {
    process.env.PETA_PUBLIC_URL = 'https://issuer.example';
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
    proxyFindFirst.mockReset();
    proxyFindFirst.mockResolvedValue({ proxyKey: 'proxy-key' });
    registerClientMock.mockClear();
    registerClientError = null;
    tokenValidationError = null;
  });

  test('authorization page embeds a pending Desk flow id', async () => {
    const controller = new OAuthController();
    const res = createRes();

    await controller.showAuthorizePage({
      query: authorizeQuery(),
      headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
      protocol: 'https',
      get: () => 'issuer.example',
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('const deskFlowId = "');
    expect(res.body).toContain('function redirectOAuthClientCallback(redirectUrl)');
    expect(res.body).not.toContain('window.location.href = data.redirect');
    expect(res.body).not.toContain('{{DESK_FLOW_ID}}');
  });

  test('authorization page reuses matching pending Desk flow id on refresh', async () => {
    const controller = new OAuthController();
    const firstRes = createRes();

    await controller.showAuthorizePage({
      query: authorizeQuery(),
      headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
      protocol: 'https',
      get: () => 'issuer.example',
    }, firstRes);

    const flowId = extractDeskFlowId(firstRes.body);
    const refreshRes = createRes();
    await controller.showAuthorizePage({
      query: authorizeQuery({ desk_flow_id: flowId }),
      headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
      protocol: 'https',
      get: () => 'issuer.example',
    }, refreshRes);

    expect(extractDeskFlowId(refreshRes.body)).toBe(flowId);
  });

  test('authorization page creates new Desk flow when requested flow params differ', async () => {
    const controller = new OAuthController();
    const firstRes = createRes();

    await controller.showAuthorizePage({
      query: authorizeQuery(),
      headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
      protocol: 'https',
      get: () => 'issuer.example',
    }, firstRes);

    const flowId = extractDeskFlowId(firstRes.body);
    const changedRes = createRes();
    await controller.showAuthorizePage({
      query: authorizeQuery({ desk_flow_id: flowId, state: 'different-state' }),
      headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
      protocol: 'https',
      get: () => 'issuer.example',
    }, changedRes);

    expect(extractDeskFlowId(changedRes.body)).not.toBe(flowId);
  });

  test('authorization page reuses completed Desk flow id and status returns redirect', async () => {
    codeCreate.mockResolvedValue({});
    const controller = new OAuthController();
    const firstRes = createRes();

    await controller.showAuthorizePage({
      query: authorizeQuery(),
      headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
      protocol: 'https',
      get: () => 'issuer.example',
    }, firstRes);

    const flowId = extractDeskFlowId(firstRes.body);
    await controller.deskAuthorizationCallback(createReq({
      flow_id: flowId,
      user_token: 'user-token',
    }), createRes());

    const refreshRes = createRes();
    await controller.showAuthorizePage({
      query: authorizeQuery({ desk_flow_id: flowId }),
      headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
      protocol: 'https',
      get: () => 'issuer.example',
    }, refreshRes);

    expect(extractDeskFlowId(refreshRes.body)).toBe(flowId);

    const statusRes = createRes();
    await controller.deskAuthorizationStatus({
      query: { flow_id: flowId },
      headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
      protocol: 'https',
      get: () => 'issuer.example',
    }, statusRes);

    expect(statusRes.body.status).toBe('completed');
    expect(statusRes.body.redirect).toContain('https://client.example/callback?code=');
  });

  test('authorization page does not reuse expired Desk flow id', async () => {
    const controller = new OAuthController();
    const flow = deskAuthorizationFlowService.createFlow({
      client_id: 'client-1',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:tools',
      state: 'state-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      resource: 'https://issuer.example/mcp',
    }, 'https://issuer.example');
    flow.expiresAt = Date.now() - 1;
    deskAuthorizationFlowService.getFlow(flow.flowId);

    const res = createRes();
    await controller.showAuthorizePage({
      query: authorizeQuery({ desk_flow_id: flow.flowId }),
      headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
      protocol: 'https',
      get: () => 'issuer.example',
    }, res);

    expect(extractDeskFlowId(res.body)).not.toBe(flow.flowId);
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

  test('authorization rejects authorization-code requests without an S256 PKCE challenge', async () => {
    const controller = new OAuthController();
    const res = createRes();

    await controller.authorize(createReq({
      client_id: 'client-1',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:tools',
      approved: true,
      user_token: 'user-token',
      code_challenge: 'challenge-1',
      code_challenge_method: 'plain',
    }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(codeCreate).not.toHaveBeenCalled();
  });

  test('authorization rejects authorization-code requests without a PKCE challenge', async () => {
    const controller = new OAuthController();
    const res = createRes();

    await controller.authorize(createReq({
      client_id: 'client-1',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:tools',
      approved: true,
      user_token: 'user-token',
      code_challenge: undefined,
      code_challenge_method: undefined,
    }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_request');
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

  test('authorization allows URL client_id metadata documents to request all MCP scopes', async () => {
    client = null;
    codeCreate.mockResolvedValue({});
    const controller = new OAuthController();
    const res = createRes();

    await controller.authorize(createReq({
      client_id: 'https://client.example/metadata.json',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:tools mcp:resources mcp:prompts',
      approved: true,
      user_token: 'user-token',
    }), res);

    expect(codeCreate.mock.calls[0][0].data.scopes).toEqual(['mcp:tools', 'mcp:resources', 'mcp:prompts']);
    expect(res.body.redirect).toContain('code=');
  });

  test('authorization reconciles existing URL client legacy default scopes', async () => {
    client = {
      client_id: 'https://client.example/metadata.json',
      issuer: 'https://issuer.example',
      client_name: 'URL Client',
      application_type: 'web',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scopes: ['mcp:tools'],
      token_endpoint_auth_method: 'none',
    };
    codeCreate.mockResolvedValue({});
    const controller = new OAuthController();
    const res = createRes();

    await controller.authorize(createReq({
      client_id: 'https://client.example/metadata.json',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:tools mcp:resources mcp:prompts',
      approved: true,
      user_token: 'user-token',
    }), res);

    expect(registerClientMock).toHaveBeenCalledWith({
      client_id: 'https://client.example/metadata.json',
      redirect_uris: [],
    });
    expect(codeCreate.mock.calls[0][0].data.scopes).toEqual(['mcp:tools', 'mcp:resources', 'mcp:prompts']);
    expect(res.body.redirect).toContain('code=');
  });

  test('authorization rejects unknown scopes for URL client_id metadata documents', async () => {
    client = null;
    const controller = new OAuthController();
    const res = createRes();

    await controller.authorize(createReq({
      client_id: 'https://client.example/metadata.json',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:unknown',
      approved: true,
      user_token: 'user-token',
    }), res);

    expect(res.body.redirect).toContain('error=invalid_scope');
    expect(codeCreate).not.toHaveBeenCalled();
  });

  test('Desk callback completes flow and status returns OAuth redirect', async () => {
    codeCreate.mockResolvedValue({});
    const flow = deskAuthorizationFlowService.createFlow({
      client_id: 'client-1',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:tools',
      state: 'state-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      resource: 'https://issuer.example/mcp',
    }, 'https://issuer.example');
    const controller = new OAuthController();
    const callbackRes = createRes();

    await controller.deskAuthorizationCallback(createReq({
      flow_id: flow.flowId,
      user_token: 'user-token',
    }), callbackRes);

    expect(callbackRes.body).toEqual({ status: 'completed' });
    expect(codeCreate).toHaveBeenCalledTimes(1);

    const statusRes = createRes();
    await controller.deskAuthorizationStatus({
      query: { flow_id: flow.flowId },
      headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
      protocol: 'https',
      get: () => 'issuer.example',
    }, statusRes);

    expect(statusRes.body.status).toBe('completed');
    expect(statusRes.body.redirect).toContain('https://client.example/callback?code=');
    expect(statusRes.body.redirect).toContain('state=state-1');
    expect(statusRes.body.redirect).toContain('iss=https%3A%2F%2Fissuer.example');
  });

  test('Desk callback reconciles URL client legacy default scopes', async () => {
    client = {
      client_id: 'https://client.example/metadata.json',
      issuer: 'https://issuer.example',
      client_name: 'URL Client',
      application_type: 'web',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scopes: ['mcp:tools'],
      token_endpoint_auth_method: 'none',
    };
    codeCreate.mockResolvedValue({});
    const flow = deskAuthorizationFlowService.createFlow({
      client_id: 'https://client.example/metadata.json',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:tools mcp:resources mcp:prompts',
      state: 'state-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      resource: 'https://issuer.example/mcp',
    }, 'https://issuer.example');
    const controller = new OAuthController();
    const callbackRes = createRes();

    await controller.deskAuthorizationCallback(createReq({
      flow_id: flow.flowId,
      user_token: 'user-token',
    }), callbackRes);

    expect(registerClientMock).toHaveBeenCalledWith({
      client_id: 'https://client.example/metadata.json',
      redirect_uris: [],
    });
    expect(callbackRes.body).toEqual({ status: 'completed' });
    expect(codeCreate.mock.calls[0][0].data.scopes).toEqual(['mcp:tools', 'mcp:resources', 'mcp:prompts']);
  });

  test('Desk callback is idempotent after completion', async () => {
    codeCreate.mockResolvedValue({});
    const flow = deskAuthorizationFlowService.createFlow({
      client_id: 'client-1',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:tools',
      code_challenge: s256CodeChallenge,
      code_challenge_method: 'S256',
      resource: 'https://issuer.example/mcp',
    }, 'https://issuer.example');
    const controller = new OAuthController();

    await controller.deskAuthorizationCallback(createReq({
      flow_id: flow.flowId,
      user_token: 'user-token',
    }), createRes());
    await controller.deskAuthorizationCallback(createReq({
      flow_id: flow.flowId,
      user_token: 'user-token',
    }), createRes());

    expect(codeCreate).toHaveBeenCalledTimes(1);
  });

  test('expired Desk flow fails without creating an authorization code', async () => {
    const flow = deskAuthorizationFlowService.createFlow({
      client_id: 'client-1',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:tools',
      resource: 'https://issuer.example/mcp',
    }, 'https://issuer.example');
    flow.expiresAt = Date.now() - 1;
    const controller = new OAuthController();
    const res = createRes();

    await controller.deskAuthorizationCallback(createReq({
      flow_id: flow.flowId,
      user_token: 'user-token',
    }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.error).toBe('expired');
    expect(codeCreate).not.toHaveBeenCalled();
  });

  test('invalid Desk user token marks flow failed for polling page', async () => {
    tokenValidationError = new Error('invalid token');
    const flow = deskAuthorizationFlowService.createFlow({
      client_id: 'client-1',
      redirect_uri: 'https://client.example/callback',
      scope: 'mcp:tools',
      resource: 'https://issuer.example/mcp',
    }, 'https://issuer.example');
    const controller = new OAuthController();

    const callbackRes = createRes();
    await controller.deskAuthorizationCallback(createReq({
      flow_id: flow.flowId,
      user_token: 'bad-token',
    }), callbackRes);

    expect(callbackRes.statusCode).toBe(400);
    expect(callbackRes.body).toEqual({
      status: 'failed',
      error: 'invalid_request',
      error_description: 'Invalid user token',
    });

    const statusRes = createRes();
    await controller.deskAuthorizationStatus({
      query: { flow_id: flow.flowId },
      headers: { host: 'issuer.example', 'x-forwarded-proto': 'https' },
      protocol: 'https',
      get: () => 'issuer.example',
    }, statusRes);

    expect(statusRes.statusCode).toBe(400);
    expect(statusRes.body.status).toBe('failed');
    expect(statusRes.body.error).toBe('invalid_request');
    expect(codeCreate).not.toHaveBeenCalled();
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
    codeFindUnique.mockResolvedValue(authCode({
      codeChallenge: s256CodeChallenge,
      challengeMethod: 'S256',
    }));
    codeUpdateMany.mockResolvedValue({ count: 1 });
    tokenCreate.mockResolvedValue({});
    const controller = new OAuthController();
    const res = createRes();

    await controller.token(createReq({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://client.example/callback', client_id: 'client-1', code_verifier: codeVerifier }), res);

    expect(res.body.refresh_token).toBeUndefined();
    expect(tokenCreate.mock.calls[0][0].data.refreshToken).toBeNull();
  });

  test('authorization_code exchange rejects codes without a stored S256 challenge', async () => {
    codeFindUnique.mockResolvedValue(authCode());
    codeUpdateMany.mockResolvedValue({ count: 1 });
    tokenCreate.mockResolvedValue({});
    const controller = new OAuthController();
    const res = createRes();

    await controller.token(createReq({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://client.example/callback',
      client_id: 'client-1',
      code_verifier: 'verifier-1',
    }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(codeUpdateMany).not.toHaveBeenCalled();
    expect(tokenCreate).not.toHaveBeenCalled();
  });

  test('authorization_code exchange rejects a missing code verifier for an S256 challenge', async () => {
    codeFindUnique.mockResolvedValue(authCode({
      codeChallenge: 'challenge-1',
      challengeMethod: 'S256',
    }));
    const controller = new OAuthController();
    const res = createRes();

    await controller.token(createReq({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://client.example/callback',
      client_id: 'client-1',
    }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(codeUpdateMany).not.toHaveBeenCalled();
    expect(tokenCreate).not.toHaveBeenCalled();
  });

  test('authorization_code exchange rejects a stored plain PKCE challenge even when its verifier matches', async () => {
    codeFindUnique.mockResolvedValue(authCode({
      codeChallenge: codeVerifier,
      challengeMethod: 'plain',
    }));
    codeUpdateMany.mockResolvedValue({ count: 1 });
    tokenCreate.mockResolvedValue({});
    const controller = new OAuthController();
    const res = createRes();

    await controller.token(createReq({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://client.example/callback',
      client_id: 'client-1',
      code_verifier: codeVerifier,
    }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(codeUpdateMany).not.toHaveBeenCalled();
    expect(tokenCreate).not.toHaveBeenCalled();
  });

  test('authorization_code exchange fails when atomic code claim loses the race', async () => {
    codeFindUnique.mockResolvedValue(authCode({
      codeChallenge: s256CodeChallenge,
      challengeMethod: 'S256',
    }));
    codeUpdateMany.mockResolvedValue({ count: 0 });
    const controller = new OAuthController();
    const res = createRes();

    await controller.token(createReq({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://client.example/callback', client_id: 'client-1', code_verifier: codeVerifier }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(tokenCreate).not.toHaveBeenCalled();
  });

  afterAll(() => {
    if (originalPublicUrl === undefined) {
      delete process.env.PETA_PUBLIC_URL;
    } else {
      process.env.PETA_PUBLIC_URL = originalPublicUrl;
    }
  });
});
