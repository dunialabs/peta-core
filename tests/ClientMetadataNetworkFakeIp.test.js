import { jest } from '@jest/globals';

const lookupMock = jest.fn();

jest.unstable_mockModule('node:dns/promises', () => ({
  lookup: lookupMock,
}));

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

const { ClientMetadataNetwork } = await import('../dist/oauth/services/ClientMetadataNetwork.js');

function createNetwork() {
  return new ClientMetadataNetwork(5000, 64 * 1024);
}

describe('ClientMetadataNetwork fake-IP validation', () => {
  const originalAllowFakeIp = process.env.OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP;

  beforeEach(() => {
    lookupMock.mockReset();
    delete process.env.OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP;
  });

  afterAll(() => {
    if (originalAllowFakeIp === undefined) {
      delete process.env.OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP;
    } else {
      process.env.OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP = originalAllowFakeIp;
    }
  });

  test('allows hostname metadata URLs that resolve to VPN fake-IP by default', async () => {
    lookupMock.mockResolvedValue([{ address: '198.18.1.0', family: 4 }]);

    const result = await createNetwork().validatePublicNetworkTarget('https://claude.ai/oauth/mcp-oauth-client-metadata');

    expect(result.valid).toBe(true);
    expect(result.addresses).toEqual(['198.18.1.0']);
  });

  test('allows hostname metadata URLs that resolve to public IPv4 addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const result = await createNetwork().validatePublicNetworkTarget('https://client.example/metadata.json');

    expect(result.valid).toBe(true);
    expect(result.addresses).toEqual(['93.184.216.34']);
  });

  test('rejects hostname fake-IP resolution when the compatibility flag is disabled', async () => {
    process.env.OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP = 'false';
    lookupMock.mockResolvedValue([{ address: '198.18.1.0', family: 4 }]);

    const result = await createNetwork().validatePublicNetworkTarget('https://claude.ai/oauth/mcp-oauth-client-metadata');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP is disabled');
  });

  test('rejects direct fake-IP metadata URLs even when hostname fake-IP compatibility is enabled', async () => {
    const result = await createNetwork().validatePublicNetworkTarget('https://198.18.1.0/metadata.json');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('must not directly target 198.18.0.0/15');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test('continues to reject hostname metadata URLs that resolve to loopback or private addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(createNetwork().validatePublicNetworkTarget('https://client.example/metadata.json'))
      .resolves.toMatchObject({ valid: false });

    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(createNetwork().validatePublicNetworkTarget('https://client.example/metadata.json'))
      .resolves.toMatchObject({ valid: false });

    lookupMock.mockResolvedValue([{ address: '192.168.1.10', family: 4 }]);
    await expect(createNetwork().validatePublicNetworkTarget('https://client.example/metadata.json'))
      .resolves.toMatchObject({ valid: false });
  });

  test('allows DNS results that mix public addresses and fake-IP addresses', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '198.18.1.0', family: 4 },
    ]);

    const result = await createNetwork().validatePublicNetworkTarget('https://client.example/metadata.json');

    expect(result.valid).toBe(true);
    expect(result.addresses).toEqual(['93.184.216.34', '198.18.1.0']);
  });

  test('rejects DNS results that mix fake-IP addresses with real private addresses', async () => {
    lookupMock.mockResolvedValue([
      { address: '198.18.1.0', family: 4 },
      { address: '192.168.1.10', family: 4 },
    ]);

    const result = await createNetwork().validatePublicNetworkTarget('https://client.example/metadata.json');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Client metadata URL must resolve only to public IP addresses');
  });
});
