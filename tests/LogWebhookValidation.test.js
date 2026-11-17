import { jest } from '@jest/globals';

const findByProxyKey = jest.fn().mockResolvedValue({ id: 1, name: 'Peta' });
const updateWebhookUrl = jest.fn();
const reloadWebhookUrl = jest.fn();
const loggerInfo = jest.fn();
const lookupMock = jest.fn();

jest.unstable_mockModule('node:dns/promises', () => ({
  lookup: lookupMock,
}));

jest.unstable_mockModule('../dist/repositories/ProxyRepository.js', () => ({
  ProxyRepository: { findByProxyKey, updateWebhookUrl },
}));
jest.unstable_mockModule('../dist/log/LogSyncService.js', () => ({
  LogSyncService: { getInstance: () => ({ reloadWebhookUrl }) },
}));
jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace() {}, debug() {}, info: loggerInfo, warn() {}, error() {}, fatal() {} }),
}));

const { LogHandler } = await import('../dist/controllers/handlers/LogHandler.js');

describe('log webhook validation', () => {
  beforeEach(() => {
    findByProxyKey.mockClear();
    updateWebhookUrl.mockClear();
    reloadWebhookUrl.mockClear();
    loggerInfo.mockClear();
    lookupMock.mockReset();
  });

  test('rejects private webhook destinations', async () => {
    await expect(new LogHandler().handleSetLogWebhookUrl({ data: {
      proxyKey: 'proxy-key',
      webhookUrl: 'http://127.0.0.1/private',
    } })).rejects.toMatchObject({ code: 1001 });

    expect(updateWebhookUrl).not.toHaveBeenCalled();
  });

  test('rejects credentials and non-default ports in webhook URLs', async () => {
    await expect(new LogHandler().handleSetLogWebhookUrl({ data: {
      proxyKey: 'proxy-key',
      webhookUrl: 'https://user:password@example.com/hook',
    } })).rejects.toMatchObject({ code: 1001 });
    await expect(new LogHandler().handleSetLogWebhookUrl({ data: {
      proxyKey: 'proxy-key',
      webhookUrl: 'https://example.com:8443/hook',
    } })).rejects.toMatchObject({ code: 1001 });
  });

  test('sanitizes webhook query values in operator logs', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await new LogHandler().handleSetLogWebhookUrl({ data: {
      proxyKey: 'proxy-key',
      webhookUrl: 'https://example.com/hook?token=secret',
    } });

    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ webhookUrl: 'https://example.com' }),
      'Webhook URL updated for proxy',
    );
  });
});
