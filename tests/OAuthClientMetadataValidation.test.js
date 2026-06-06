import { jest } from '@jest/globals';

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

const { ClientMetadataFetcher } = await import('../dist/oauth/services/ClientMetadataFetcher.js');

describe('OAuthClientMetadataValidation', () => {
  const validMetadata = {
    client_id: 'https://client.example/metadata.json',
    client_name: 'Client',
    redirect_uris: ['https://client.example/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };

  test('rejects unsupported client_credentials grant metadata', () => {
    const fetcher = new ClientMetadataFetcher();
    const result = fetcher.validateMetadata({
      ...validMetadata,
      grant_types: ['authorization_code', 'client_credentials'],
    });

    expect(result.valid).toBe(false);
    expect(result.errorDescription).toContain('Unsupported grant_types: client_credentials');
  });

  test('rejects URL client metadata that requires a client secret', () => {
    const fetcher = new ClientMetadataFetcher();
    const result = fetcher.validateMetadata({
      ...validMetadata,
      token_endpoint_auth_method: 'client_secret_basic',
    });

    expect(result.valid).toBe(false);
    expect(result.errorDescription).toContain('Unsupported token_endpoint_auth_method: client_secret_basic');
  });

  test('rejects URL client metadata missing required identity fields', () => {
    const fetcher = new ClientMetadataFetcher();

    expect(fetcher.validateMetadata({ ...validMetadata, client_id: undefined }).errorDescription).toContain('client_id is required');
    expect(fetcher.validateMetadata({ ...validMetadata, client_name: undefined }).errorDescription).toContain('client_name is required');
  });

  test('rejects non-HTTPS fetched redirect URIs except localhost', () => {
    const fetcher = new ClientMetadataFetcher();
    const result = fetcher.validateMetadata({
      ...validMetadata,
      redirect_uris: ['http://evil.example/callback'],
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_redirect_uri');
  });

  test('rejects fetched metadata whose client_id does not match the document URL', async () => {
    const fetcher = new ClientMetadataFetcher();
    fetcher.validatePublicNetworkTarget = jest.fn(async () => ({ valid: true, addresses: ['203.0.113.10'] }));
    fetcher.fetchPinnedMetadataDocument = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validMetadata, client_id: 'https://other.example/metadata.json' }),
    }));

    const result = await fetcher.fetchAndValidateClientMetadata('https://client.example/metadata.json', true);

    expect(result.valid).toBe(false);
    expect(result.errorDescription).toContain('client_id in metadata must exactly match');
  });

  test('accepts public URL client metadata', () => {
    const fetcher = new ClientMetadataFetcher();
    const result = fetcher.validateMetadata(validMetadata);

    expect(result.valid).toBe(true);
  });
});
