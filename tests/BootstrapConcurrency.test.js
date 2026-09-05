import { jest } from '@jest/globals';
import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.PETA_BOOTSTRAP_CONCURRENCY_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

const shutdownReached = [];
const shutdownRelease = [];

jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({
  SessionStore: { instance: { removeAllSessions: jest.fn() } },
}));
jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: {
    instance: {
      shutdown: jest.fn(() => new Promise((resolve) => {
        shutdownReached.shift()?.();
        shutdownRelease.push(resolve);
      })),
      connectAllServers: jest.fn(async () => ({ successServers: [], failedServers: [] })),
    },
  },
}));
jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: { getInstance: () => ({ enqueueLog() {} }) },
}));
jest.unstable_mockModule('../dist/socket/SocketNotifier.js', () => ({ socketNotifier: {} }));
jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const { prisma } = await import('../dist/config/prisma.js');
const { UserHandler } = await import('../dist/controllers/handlers/UserHandler.js');
const { ProxyHandler } = await import('../dist/controllers/handlers/ProxyHandler.js');
const { BackupHandler } = await import('../dist/controllers/handlers/BackupHandler.js');
const enums = await import('../dist/types/enums.js');
const adminTypes = await import('../dist/types/admin.types.js');

const { UserRole, UserStatus } = enums;
const { AdminErrorCode } = adminTypes;
const observer = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;

async function verifyDisposableDatabase() {
  const [{ database }] = await observer.$queryRaw`SELECT current_database() AS database`;
  const expectedDatabase = new URL(databaseUrl).pathname.slice(1);
  expect(database).toBe(expectedDatabase);
  expect(expectedDatabase).toMatch(/(?:test|rereview)/i);
  await observer.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "_peta_bootstrap_concurrency_marker" ("id" integer PRIMARY KEY)',
  );
  await observer.$executeRawUnsafe(
    'INSERT INTO "_peta_bootstrap_concurrency_marker" ("id") VALUES (1) ON CONFLICT DO NOTHING',
  );
  const [{ marked }] = await observer.$queryRawUnsafe(
    'SELECT EXISTS (SELECT 1 FROM "_peta_bootstrap_concurrency_marker" WHERE "id" = 1) AS marked',
  );
  expect(marked).toBe(true);
}

async function clearBootstrapTables() {
  await verifyDisposableDatabase();
  await prisma.ipWhitelist.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.proxy.deleteMany({});
}

function ownerRequest(userId) {
  return {
    data: {
      userId,
      role: UserRole.Owner,
      status: UserStatus.Enabled,
      encryptedToken: `encrypted-${userId}`,
    },
  };
}

async function holdShareLock(table) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let locked;
  const lockReady = new Promise((resolve) => { locked = resolve; });
  const transaction = observer.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN SHARE MODE`);
    locked();
    await released;
  });
  await lockReady;
  return { release, transaction };
}

async function waitForBlockedWriters(table, count) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [{ blocked }] = await observer.$queryRawUnsafe(`
      SELECT count(*)::int AS blocked
      FROM pg_locks
      WHERE relation = '"${table}"'::regclass
        AND locktype = 'relation'
        AND NOT granted
    `);
    if (blocked >= count) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected ${count} blocked writers for ${table}`);
}

describeWithDatabase('database-serialized bootstrap and restore', () => {
  beforeEach(async () => {
    shutdownReached.length = 0;
    shutdownRelease.length = 0;
    await clearBootstrapTables();
  });

  afterAll(async () => {
    while (shutdownRelease.length > 0) shutdownRelease.shift()?.();
    await prisma.$disconnect();
    await observer.$disconnect();
  });

  test('persists exactly one Owner when two first-owner requests overlap', async () => {
    const blocker = await holdShareLock('user');
    const attempts = [
      new UserHandler().handleCreateUser(ownerRequest('owner-a')),
      new UserHandler().handleCreateUser(ownerRequest('owner-b')),
    ];
    let results;
    try {
      await waitForBlockedWriters('user', 2);
    } finally {
      blocker.release();
      await blocker.transaction;
      results = await Promise.allSettled(attempts);
    }
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')[0].reason).toMatchObject({
      code: AdminErrorCode.USER_ALREADY_EXISTS,
    });
    expect(await observer.user.count({ where: { role: UserRole.Owner } })).toBe(1);
  });

  test('persists exactly one Proxy when two first-proxy requests overlap', async () => {
    const blocker = await holdShareLock('proxy');
    const attempts = [
      new ProxyHandler().handleCreateProxy({ data: { name: 'Proxy A', proxyKey: 'proxy-a' } }),
      new ProxyHandler().handleCreateProxy({ data: { name: 'Proxy B', proxyKey: 'proxy-b' } }),
    ];
    let results;
    try {
      await waitForBlockedWriters('proxy', 2);
    } finally {
      blocker.release();
      await blocker.transaction;
      results = await Promise.allSettled(attempts);
    }
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')[0].reason).toMatchObject({
      code: AdminErrorCode.PROXY_ALREADY_EXISTS,
    });
    expect(await observer.proxy.count()).toBe(1);
  });

  test('restore refuses to erase an Owner created while shutdown is in progress', async () => {
    const shutdownStarted = new Promise((resolve) => shutdownReached.push(resolve));
    const restore = new BackupHandler({ reloadFromDatabase: jest.fn() }).handleRestoreDatabase({
      data: {
        backup: {
          tables: { users: [], servers: [], proxies: [], ipWhitelist: [] },
        },
      },
    }, 'owner-token');
    await shutdownStarted;
    await new UserHandler().handleCreateUser(ownerRequest('owner-during-restore'));
    shutdownRelease.shift()?.();
    await expect(restore).rejects.toMatchObject({ code: AdminErrorCode.RESTORE_FAILED });
    expect(await observer.user.findMany({ select: { userId: true } })).toEqual([
      { userId: 'owner-during-restore' },
    ]);
  });

  test('restores an empty backup when the installation remains empty', async () => {
    const shutdownStarted = new Promise((resolve) => shutdownReached.push(resolve));
    const restore = new BackupHandler({ reloadFromDatabase: jest.fn() }).handleRestoreDatabase({
      data: {
        backup: {
          tables: { users: [], servers: [], proxies: [], ipWhitelist: [] },
        },
      },
    }, 'owner-token');
    await shutdownStarted;
    shutdownRelease.shift()?.();
    await expect(restore).resolves.toMatchObject({
      message: 'Database restored successfully',
      stats: { usersRestored: 0, serversRestored: 0, proxiesRestored: 0 },
    });
  });
});
