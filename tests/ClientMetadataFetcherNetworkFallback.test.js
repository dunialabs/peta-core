import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

const requestMock = jest.fn();

jest.unstable_mockModule('node:https', () => ({
  request: requestMock,
}));

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

const { ClientMetadataFetcher } = await import('../dist/oauth/services/ClientMetadataFetcher.js');

function createRequest(options, callback) {
  const req = new EventEmitter();
  req.end = jest.fn(() => {
    if (options.hostname === '2001:db8::1') {
      req.emit('error', new Error('ENETUNREACH'));
      return;
    }

    const res = new EventEmitter();
    res.statusCode = 200;
    res.statusMessage = 'OK';
    res.headers = { 'content-type': 'application/json' };
    callback(res);
    res.emit('data', Buffer.from(JSON.stringify({
      client_id: 'https://client.example/metadata.json',
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })));
    res.emit('end');
  });
  req.destroy = jest.fn((error) => {
    if (error) {
      req.emit('error', error);
    }
  });
  return req;
}

describe('ClientMetadataFetcher network fallback', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockImplementation(createRequest);
  });

  test('tries the next validated DNS address when the first address cannot connect', async () => {
    const fetcher = new ClientMetadataFetcher();
    fetcher.validatePublicNetworkTarget = jest.fn(async () => ({
      valid: true,
      addresses: ['2001:db8::1', '203.0.113.10'],
    }));

    const result = await fetcher.fetchAndValidateClientMetadata('https://client.example/metadata.json', true);

    expect(result.valid).toBe(true);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0][0].hostname).toBe('2001:db8::1');
    expect(requestMock.mock.calls[1][0].hostname).toBe('203.0.113.10');
  });
});
