import { jest } from '@jest/globals';

jest.unstable_mockModule('../dist/config/prisma.js', () => ({
  prisma: {},
}));
jest.unstable_mockModule('../dist/services/CloudflaredDockerService.js', () => ({
  CloudflaredDockerService: {
    getInstance: () => ({}),
  },
}));
jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }),
}));

const { CloudflaredService } = await import('../dist/services/CloudflaredService.js');

describe('cloudflared tunnel ID validation', () => {
  test.each(['../escape', '..\\escape', '/tmp/escape', 'tunnel/id', 'tunnel.id'])('rejects unsafe tunnel ID %s before file generation', async (tunnelId) => {
    const service = CloudflaredService.getInstance();

    expect(() => service.generateConfigYaml(tunnelId, 'example.trycloudflare.com')).toThrow('Invalid tunnelId');
    await expect(service.generateLocalFiles(tunnelId, {
      AccountTag: 'account',
      TunnelSecret: 'secret',
      TunnelID: tunnelId,
    }, 'example.trycloudflare.com')).rejects.toMatchObject({ message: 'Invalid tunnelId', code: 1001 });
  });
});
