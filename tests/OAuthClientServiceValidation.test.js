import { jest } from '@jest/globals';

const createMock = jest.fn(async ({ data }) => ({
  ...data,
  clientSecret: data.clientSecret ?? null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}));
const findFirstMock = jest.fn(async () => null);
const findUniqueMock = jest.fn(async () => null);

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/config/prisma.js', () => ({
  prisma: {
    oAuthClient: {
      findFirst: findFirstMock,
      findUnique: findUniqueMock,
      findMany: jest.fn(async () => []),
      create: createMock,
      update: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
    oAuthAuthorizationCode: { deleteMany: jest.fn() },
    oAuthToken: { deleteMany: jest.fn() },
  },
}));

jest.unstable_mockModule('../dist/oauth/services/ClientMetadataFetcher.js', () => ({
  ClientMetadataFetcher: class {
    async fetchAndValidateClientMetadata(clientId) {
      return {
        valid: true,
        metadata: {
          client_id: clientId,
          client_name: 'URL Client',
          redirect_uris: ['https://client.example/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
      };
    }
  },
}));

const { OAuthClientService } = await import('../dist/oauth/services/OAuthClientService.js');

describe('OAuthClientServiceValidation', () => {
  beforeEach(() => {
    createMock.mockClear();
    findFirstMock.mockReset();
    findFirstMock.mockResolvedValue(null);
    findUniqueMock.mockReset();
    findUniqueMock.mockResolvedValue(null);
  });

  test('URL-based registration fetches metadata instead of requiring body redirect_uris', async () => {
    const service = new OAuthClientService();
    const client = await service.registerClient({ client_id: 'https://client.example/metadata.json' }, undefined, 'https://issuer.example');

    expect(client.client_id).toBe('https://client.example/metadata.json');
    expect(client.redirect_uris).toEqual(['https://client.example/callback']);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  test('URL-based registration rejects global client_id reuse under another issuer', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({ clientId: 'https://client.example/metadata.json', issuer: 'https://issuer-a.example' });
    const service = new OAuthClientService();

    await expect(service.registerClient({ client_id: 'https://client.example/metadata.json' }, undefined, 'https://issuer-b.example')).rejects.toThrow('invalid_client_metadata: client_id is already registered for a different issuer');
    expect(createMock).not.toHaveBeenCalled();
  });

  test('traditional registration rejects non-array grant_types with metadata error', async () => {
    const service = new OAuthClientService();

    await expect(service.registerClient({
      client_name: 'Bad Client',
      redirect_uris: ['https://client.example/callback'],
      grant_types: 'authorization_code',
    }, undefined, 'https://issuer.example')).rejects.toThrow('invalid_client_metadata: grant_types must be an array');
    expect(createMock).not.toHaveBeenCalled();
  });

  test('traditional registration rejects non-array response_types with metadata error', async () => {
    const service = new OAuthClientService();

    await expect(service.registerClient({
      client_name: 'Bad Client',
      redirect_uris: ['https://client.example/callback'],
      response_types: 'code',
    }, undefined, 'https://issuer.example')).rejects.toThrow('invalid_client_metadata: response_types must be an array');
    expect(createMock).not.toHaveBeenCalled();
  });

  test('traditional registration allows omitted client_name', async () => {
    const service = new OAuthClientService();
    const client = await service.registerClient({
      redirect_uris: ['https://client.example/callback'],
    }, undefined, 'https://issuer.example');

    expect(client.client_name).toMatch(/^Client /);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  test('issuer lookup falls back to legacy default issuer clients', async () => {
    findFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        clientId: 'legacy-client',
        issuer: 'default',
        clientSecret: 'secret',
        applicationType: 'web',
        tokenEndpointAuthMethod: 'client_secret_post',
        name: 'Legacy Client',
        redirectUris: ['https://client.example/callback'],
        scopes: ['mcp:tools'],
        grantTypes: ['authorization_code'],
        responseTypes: ['code'],
        userId: null,
        trusted: false,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });
    const service = new OAuthClientService();

    const client = await service.getClientForIssuer('legacy-client', 'https://issuer.example');

    expect(findFirstMock).toHaveBeenNthCalledWith(1, { where: { clientId: 'legacy-client', issuer: 'https://issuer.example' } });
    expect(findFirstMock).toHaveBeenNthCalledWith(2, { where: { clientId: 'legacy-client', issuer: 'default' } });
    expect(client.client_id).toBe('legacy-client');
    expect(client.issuer).toBe('default');
  });
});
