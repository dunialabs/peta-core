import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

const lookupMock = jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
const httpsRequestMock = jest.fn();

jest.unstable_mockModule('node:dns/promises', () => ({ lookup: lookupMock }));
jest.unstable_mockModule('node:https', () => ({ request: httpsRequestMock }));
jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }),
}));

const { ClientMetadataFetcher } = await import('../dist/oauth/services/ClientMetadataFetcher.js');

test('does not return network exception details to the OAuth caller', async () => {
  httpsRequestMock.mockImplementation((_options, _callback) => {
    const request = new EventEmitter();
    request.end = jest.fn(() => request.emit('error', new Error('connect EACCES /private/secret/socket')));
    request.destroy = jest.fn();
    return request;
  });

  const result = await new ClientMetadataFetcher().fetchAndValidateClientMetadata(
    'https://client.example/metadata.json',
    true,
  );

  expect(result).toEqual({
    valid: false,
    error: 'invalid_client_metadata',
    errorDescription: 'Unable to fetch client metadata',
  });
  expect(result.errorDescription).not.toContain('/private/secret/socket');
});
