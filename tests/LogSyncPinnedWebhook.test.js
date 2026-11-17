import { jest } from '@jest/globals';

const validatePublicNetworkTarget = jest.fn();
const postPinnedJson = jest.fn();

jest.unstable_mockModule('../dist/oauth/services/ClientMetadataNetwork.js', () => ({
  ClientMetadataNetwork: jest.fn().mockImplementation(() => ({
    validatePublicNetworkTarget,
    postPinnedJson,
  })),
}));
jest.unstable_mockModule('../dist/repositories/LogRepository.js', () => ({
  LogRepository: {},
}));
jest.unstable_mockModule('../dist/repositories/ProxyRepository.js', () => ({
  ProxyRepository: {},
}));
jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: { getInstance: () => ({ enqueueLog: jest.fn() }) },
}));
jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }),
}));

const { LogSyncService } = await import('../dist/log/LogSyncService.js');

describe('LogSyncService webhook delivery', () => {
  beforeEach(() => {
    validatePublicNetworkTarget.mockReset();
    postPinnedJson.mockReset();
    validatePublicNetworkTarget.mockResolvedValue({ valid: true, addresses: ['93.184.216.34'] });
    postPinnedJson.mockResolvedValue({ ok: true, status: 204, statusText: 'No Content', headers: {} });
  });

  test('sends to the address validated immediately before delivery', async () => {
    const service = LogSyncService.getInstance();
    service.webhookUrl = 'https://webhook.example/hook';

    const sent = await service.sendLogsToWebhook([{ id: 1, action: 7002 }]);

    expect(sent).toBe(true);
    expect(validatePublicNetworkTarget).toHaveBeenCalledWith('https://webhook.example/hook', { allowFakeIp: false });
    expect(postPinnedJson).toHaveBeenCalledWith(
      'https://webhook.example/hook',
      ['93.184.216.34'],
      expect.stringContaining('"count":1'),
      expect.objectContaining({ 'Content-Type': 'application/json' }),
    );
  });
});
