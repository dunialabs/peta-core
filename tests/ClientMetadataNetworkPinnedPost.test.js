import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

const httpRequestMock = jest.fn();
const httpsRequestMock = jest.fn();

jest.unstable_mockModule('node:http', () => ({
  request: httpRequestMock,
}));
jest.unstable_mockModule('node:https', () => ({
  request: httpsRequestMock,
}));
jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }),
}));

const { ClientMetadataNetwork } = await import('../dist/oauth/services/ClientMetadataNetwork.js');

function successfulRequest(options, callback) {
  const req = new EventEmitter();
  req.end = jest.fn(() => {
    const response = new EventEmitter();
    response.statusCode = 204;
    response.statusMessage = 'No Content';
    response.headers = {};
    callback(response);
    response.emit('end');
  });
  req.destroy = jest.fn((error) => {
    if (error) req.emit('error', error);
  });
  return req;
}

describe('ClientMetadataNetwork pinned JSON requests', () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    httpsRequestMock.mockReset();
    httpRequestMock.mockImplementation(successfulRequest);
    httpsRequestMock.mockImplementation(successfulRequest);
  });

  test('connects to the validated address while preserving the original HTTP host', async () => {
    const network = new ClientMetadataNetwork(5000, 1024);
    const result = await network.postPinnedJson(
      'http://webhook.example/hook?tenant=one',
      ['93.184.216.34'],
      '{"ok":true}',
      { 'Content-Type': 'application/json' },
    );

    expect(result).toMatchObject({ ok: true, status: 204 });
    expect(httpRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      hostname: '93.184.216.34',
      path: '/hook?tenant=one',
      headers: expect.objectContaining({
        Host: 'webhook.example',
        'Content-Length': '11',
      }),
    }), expect.any(Function));
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  test('pins HTTPS requests and sets SNI to the original hostname', async () => {
    const network = new ClientMetadataNetwork(5000, 1024);
    await network.postPinnedJson('https://webhook.example/hook', ['93.184.216.34'], '{}');

    expect(httpsRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      hostname: '93.184.216.34',
      servername: 'webhook.example',
    }), expect.any(Function));
    expect(httpRequestMock).not.toHaveBeenCalled();
  });
});
