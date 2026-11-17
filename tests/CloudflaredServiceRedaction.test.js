import { jest } from '@jest/globals';

const findMany = jest.fn().mockResolvedValue([
  {
    id: 1,
    tunnelId: 'tunnel-1',
    subdomain: 'example.trycloudflare.com',
    credentials: JSON.stringify({ TunnelSecret: 'secret-value' }),
  },
]);

jest.unstable_mockModule('../dist/config/prisma.js', () => ({
  prisma: { dnsConf: { findMany } },
}));
jest.unstable_mockModule('../dist/services/CloudflaredDockerService.js', () => ({
  CloudflaredDockerService: {
    getInstance: () => ({ getContainerStatus: jest.fn().mockResolvedValue('running') }),
  },
}));
jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }),
}));

const { CloudflaredService } = await import('../dist/services/CloudflaredService.js');

test('cloudflared configuration reads omit stored credentials', async () => {
  const result = await CloudflaredService.getInstance().getConfigs({});

  expect(result).toEqual([expect.objectContaining({ id: 1, status: 'running' })]);
  expect(result[0]).not.toHaveProperty('credentials');
});
