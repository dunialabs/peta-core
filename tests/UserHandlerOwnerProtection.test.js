import { jest } from '@jest/globals';

const users = new Map();
const removedSessions = jest.fn();
const repository = {
  findByUserId: async id => users.get(id) ?? null,
  findByProxyId: async proxyId => [...users.values()].filter(user => user.proxyId === proxyId),
  update: async (id, data) => {
    const user = { ...users.get(id), ...data };
    users.set(id, user);
    return user;
  },
  delete: async id => { const user = users.get(id); users.delete(id); return user; },
  deleteByProxyId: async proxyId => {
    const selected = [...users.values()].filter(user => user.proxyId === proxyId);
    for (const user of selected) users.delete(user.userId);
    return selected.length;
  },
};
jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({ UserRepository: repository }));
jest.unstable_mockModule('../dist/config/prisma.js', () => ({ prisma: {} }));
jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({ SessionStore: { instance: { removeAllUserSessions: removedSessions, getUserSessions: () => [] } } }));
jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({ ServerManager: { instance: {} } }));
jest.unstable_mockModule('../dist/log/LogService.js', () => ({ LogService: { getInstance: () => ({ enqueueLog() {} }) } }));
jest.unstable_mockModule('../dist/socket/SocketNotifier.js', () => ({ socketNotifier: {} }));
jest.unstable_mockModule('../dist/logger/index.js', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
const { UserHandler } = await import('../dist/controllers/handlers/UserHandler.js');
const { UserRole, UserStatus } = await import('../dist/types/enums.js');
const { AdminErrorCode } = await import('../dist/types/admin.types.js');

beforeEach(() => {
  users.clear();
  removedSessions.mockClear();
  users.set('member', { userId: 'member', role: UserRole.User, status: UserStatus.Enabled, proxyId: 1 });
  users.set('owner', { userId: 'owner', role: UserRole.Owner, status: UserStatus.Enabled, proxyId: 1 });
});

test.each([
  ['handleDisableUser', { targetId: 'owner' }],
  ['handleDeleteUser', { userId: 'owner' }],
  ['handleUpdateUser', { userId: 'owner', status: UserStatus.Disabled }],
  ['handleUpdateUser', { userId: 'owner', status: UserStatus.Suspended }],
  ['handleUpdateUser', { userId: 'owner', status: UserStatus.Pending }],
  ['handleDeleteUsersByProxy', { proxyId: 1 }],
])('%s refuses owner deactivation before changing users or sessions', async (method, data) => {
  // Given an enabled owner and member on the same proxy.
  const handler = new UserHandler();
  // When an ordinary user-management operation would remove owner access.
  await expect(handler[method]({ data })).rejects.toMatchObject({ code: AdminErrorCode.FORBIDDEN });
  // Then neither the owner nor earlier bulk entries have changed.
  expect(users.size).toBe(2);
  expect([...users.values()].every(user => user.status === UserStatus.Enabled)).toBe(true);
  expect(removedSessions).not.toHaveBeenCalled();
});

test('keeps ordinary non-owner deletion available', async () => {
  // Given
  const handler = new UserHandler();
  // When
  await handler.handleDeleteUser({ data: { userId: 'member' } });
  // Then
  expect(users.has('member')).toBe(false);
  expect(users.get('owner').status).toBe(UserStatus.Enabled);
  expect(removedSessions).toHaveBeenCalledTimes(1);
});

test('allows updating owner metadata without deactivation', async () => {
  // Given
  const handler = new UserHandler();
  // When
  await handler.handleUpdateUser({ data: { userId: 'owner', name: 'Updated name' } });
  // Then
  expect(users.get('owner')).toMatchObject({ name: 'Updated name', status: UserStatus.Enabled });
  expect(removedSessions).not.toHaveBeenCalled();
});
