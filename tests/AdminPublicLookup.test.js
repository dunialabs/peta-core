import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';

const findByRole = jest.fn();
const findFirst = jest.fn();

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({
  UserRepository: { findByRole },
}));
jest.unstable_mockModule('../dist/repositories/ProxyRepository.js', () => ({
  ProxyRepository: { findFirst },
}));
jest.unstable_mockModule('../dist/config/prisma.js', () => ({ prisma: {} }));
jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: { getInstance: () => ({ enqueueLog() {} }) },
}));
jest.unstable_mockModule('../dist/mcp/services/CapabilitiesService.js', () => ({
  CapabilitiesService: { getInstance: () => ({}) },
}));
jest.unstable_mockModule('../dist/security/CryptoService.js', () => ({ CryptoService: {} }));
jest.unstable_mockModule('../dist/socket/SocketNotifier.js', () => ({ socketNotifier: {} }));
jest.unstable_mockModule('../dist/repositories/ServerRepository.js', () => ({ ServerRepository: {} }));
jest.unstable_mockModule('../dist/repositories/IpWhitelistRepository.js', () => ({ IpWhitelistRepository: {} }));
jest.unstable_mockModule('../dist/repositories/LogRepository.js', () => ({ LogRepository: {} }));
jest.unstable_mockModule('../dist/repositories/EventRepository.js', () => ({ EventRepository: {} }));
jest.unstable_mockModule('../dist/services/CloudflaredService.js', () => ({ CloudflaredService: {} }));
jest.unstable_mockModule('../dist/index.js', () => ({ getShutdownFunction: () => null }));
jest.unstable_mockModule('../dist/socket/SocketService.js', () => ({ SocketService: class {} }));
jest.unstable_mockModule('../dist/controllers/handlers/ServerHandler.js', () => ({ ServerHandler: class {} }));
jest.unstable_mockModule('../dist/controllers/handlers/QueryHandler.js', () => ({ QueryHandler: class {} }));
jest.unstable_mockModule('../dist/controllers/handlers/IpWhitelistHandler.js', () => ({ IpWhitelistHandler: class {} }));
jest.unstable_mockModule('../dist/controllers/handlers/BackupHandler.js', () => ({ BackupHandler: class {} }));
jest.unstable_mockModule('../dist/controllers/handlers/LogHandler.js', () => ({ LogHandler: class {} }));
jest.unstable_mockModule('../dist/controllers/handlers/CloudflaredHandler.js', () => ({ CloudflaredHandler: class {} }));
jest.unstable_mockModule('../dist/controllers/handlers/SkillsHandler.js', () => ({ SkillsHandler: class {} }));
jest.unstable_mockModule('../dist/controllers/handlers/PolicyHandler.js', () => ({ PolicyHandler: class {} }));
jest.unstable_mockModule('../dist/controllers/handlers/ApprovalHandler.js', () => ({ ApprovalHandler: class {} }));
jest.unstable_mockModule('../dist/controllers/handlers/DiscoveryHandler.js', () => ({ DiscoveryHandler: class {} }));
jest.unstable_mockModule('../dist/controllers/handlers/CacheHandler.js', () => ({ CacheHandler: class {} }));
jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }),
}));
jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({ SessionStore: { instance: {} } }));
jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: { instance: { setOwnerToken() {} } },
}));
jest.unstable_mockModule('../dist/mcp/core/cache/ResultCacheService.js', () => ({ ResultCacheService: class {} }));

const { ConfigController } = await import('../dist/controllers/ConfigController.js');

const owner = {
  userId: 'owner-id',
  encryptedToken: 'encrypted-owner-token',
  role: 1,
  status: 1,
  expiresAt: 0,
  createdAt: 123,
  permissions: '{"all":true}',
  userPreferences: '{"theme":"dark"}',
  launchConfigs: '{"server":"internal"}',
  ratelimit: 100,
  notes: 'internal note',
  proxyId: 7,
  updatedAt: 456,
};
const proxy = {
  id: 7,
  name: 'Peta',
  proxyKey: 'public-proxy-key',
  startPort: 3002,
  addtime: 123,
  logWebhookUrl: 'https://hooks.example.test/?token=secret',
  lastSyncedLogId: 99,
};

async function requestAdmin(action, authorization) {
  const app = express();
  app.use(express.json());
  if (authorization) {
    app.use((req, _res, next) => {
      req.authContext = { userId: 'owner-id', role: 1, token: 'owner-token' };
      next();
    });
  }
  new ConfigController().registerRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({ action, data: {} }),
    });
    return await response.json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('public admin bootstrap lookups', () => {
  beforeEach(() => {
    findByRole.mockReset();
    findFirst.mockReset();
    findByRole.mockResolvedValue([owner]);
    findFirst.mockResolvedValue(proxy);
  });

  test('headerless GET_OWNER retains login fields and omits internal metadata', async () => {
    const response = await requestAdmin(1016);

    expect(response.data.owner).toEqual({
      userId: owner.userId,
      encryptedToken: owner.encryptedToken,
      role: owner.role,
      status: owner.status,
      expiresAt: owner.expiresAt,
      createdAt: owner.createdAt,
    });
    expect(response.data.owner).not.toHaveProperty('permissions');
    expect(response.data.owner).not.toHaveProperty('notes');
    expect(findByRole).toHaveBeenCalledWith(1);
  });

  test('headerless GET_PROXY retains bootstrap fields and omits webhook metadata', async () => {
    const response = await requestAdmin(5001);

    expect(response.data.proxy).toEqual({
      id: proxy.id,
      name: proxy.name,
      proxyKey: proxy.proxyKey,
      startPort: proxy.startPort,
      addtime: proxy.addtime,
    });
    expect(response.data.proxy).not.toHaveProperty('logWebhookUrl');
    expect(response.data.proxy).not.toHaveProperty('lastSyncedLogId');
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  test('authenticated lookups keep the full handler records', async () => {
    const ownerResponse = await requestAdmin(1016, 'Bearer owner-token');
    const proxyResponse = await requestAdmin(5001, 'Bearer owner-token');

    expect(ownerResponse.data.owner).toEqual(owner);
    expect(proxyResponse.data.proxy).toEqual(proxy);
  });
});
