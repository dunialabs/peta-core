import { jest } from '@jest/globals';

const findByUserId = jest.fn();
const updateUser = jest.fn();
const getUserSessions = jest.fn();
const enqueueLog = jest.fn();
const notifyPermissionChangedByUser = jest.fn();

const session = {
  updatePermissions: jest.fn(),
  sendToolListChanged: jest.fn(),
  sendResourceListChanged: jest.fn(),
  sendPromptListChanged: jest.fn(),
};

jest.unstable_mockModule('../dist/repositories/UserRepository.js', () => ({
  UserRepository: {
    findByUserId,
    update: updateUser,
  },
}));

jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({
  SessionStore: {
    instance: {
      getUserSessions,
      removeAllUserSessions: jest.fn(),
    },
  },
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: { instance: {} },
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: {
    getInstance: () => ({ enqueueLog }),
  },
}));

jest.unstable_mockModule('../dist/socket/SocketNotifier.js', () => ({
  socketNotifier: { notifyPermissionChangedByUser },
}));

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const { UserHandler } = await import('../dist/controllers/handlers/UserHandler.js');
const { CapabilitiesService } = await import('../dist/mcp/services/CapabilitiesService.js');

const emptyServerPermission = (enabled) => ({
  enabled,
  tools: {},
  resources: {},
  prompts: {},
});

const serverPermissionWithOverride = (capabilityType) => ({
  ...emptyServerPermission(true),
  [capabilityType]: { example: { enabled: false } },
});

describe('UserHandler permission updates', () => {
  let storedUser;

  beforeEach(() => {
    jest.clearAllMocks();
    storedUser = {
      userId: 'user-1',
      status: 0,
      permissions: JSON.stringify({ 'server-a': emptyServerPermission(true) }),
    };
    findByUserId.mockImplementation(async () => ({ ...storedUser }));
    updateUser.mockImplementation(async (_userId, data) => {
      storedUser = { ...storedUser, ...data };
      return { ...storedUser };
    });
    getUserSessions.mockReturnValue([session]);
  });

  test.each([
    ['enabled', true],
    ['disabled', false],
  ])('persists an added %s server entry with empty capability maps', async (_label, enabled) => {
    // Given
    const permissions = {
      'server-a': emptyServerPermission(true),
      'server-b': emptyServerPermission(enabled),
    };

    // When
    await new UserHandler().handleUpdateUserPermissions({
      data: { targetId: 'user-1', permissions },
    });

    // Then
    expect(updateUser).toHaveBeenCalledWith('user-1', {
      permissions: JSON.stringify(permissions),
    });
    expect(session.updatePermissions).toHaveBeenCalledWith(permissions);
    expect(session.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(session.sendResourceListChanged).toHaveBeenCalledTimes(1);
    expect(session.sendPromptListChanged).toHaveBeenCalledTimes(1);
    expect(notifyPermissionChangedByUser).toHaveBeenCalledWith('user-1');
  });

  test.each([
    [
      'removing an enabled server',
      { 'server-a': emptyServerPermission(true) },
      {},
    ],
    [
      'removing a disabled server',
      { 'server-a': emptyServerPermission(false) },
      {},
    ],
    [
      'enabling an existing server',
      { 'server-a': emptyServerPermission(false) },
      { 'server-a': emptyServerPermission(true) },
    ],
    [
      'disabling an existing server',
      { 'server-a': emptyServerPermission(true) },
      { 'server-a': emptyServerPermission(false) },
    ],
  ])('marks every capability list changed when %s', (_name, oldPermissions, newPermissions) => {
    // When
    const changed = CapabilitiesService.comparePermissions(oldPermissions, newPermissions);

    // Then
    expect(changed).toEqual({
      toolsChanged: true,
      resourcesChanged: true,
      promptsChanged: true,
    });
  });

  test.each([
    [
      'adding a disabled tool override',
      emptyServerPermission(true),
      serverPermissionWithOverride('tools'),
      { toolsChanged: true, resourcesChanged: false, promptsChanged: false },
    ],
    [
      'removing a disabled tool override',
      serverPermissionWithOverride('tools'),
      emptyServerPermission(true),
      { toolsChanged: true, resourcesChanged: false, promptsChanged: false },
    ],
    [
      'adding a disabled resource override',
      emptyServerPermission(true),
      serverPermissionWithOverride('resources'),
      { toolsChanged: false, resourcesChanged: true, promptsChanged: false },
    ],
    [
      'removing a disabled resource override',
      serverPermissionWithOverride('resources'),
      emptyServerPermission(true),
      { toolsChanged: false, resourcesChanged: true, promptsChanged: false },
    ],
    [
      'adding a disabled prompt override',
      emptyServerPermission(true),
      serverPermissionWithOverride('prompts'),
      { toolsChanged: false, resourcesChanged: false, promptsChanged: true },
    ],
    [
      'removing a disabled prompt override',
      serverPermissionWithOverride('prompts'),
      emptyServerPermission(true),
      { toolsChanged: false, resourcesChanged: false, promptsChanged: true },
    ],
  ])('marks the affected capability list changed when %s', (_name, oldServer, newServer, expected) => {
    // When
    const changed = CapabilitiesService.comparePermissions(
      { 'server-a': oldServer },
      { 'server-a': newServer },
    );

    // Then
    expect(changed).toEqual(expected);
  });

  test('persists permission metadata changes without capability-list notifications', async () => {
    // Given
    const permissions = {
      'server-a': {
        ...emptyServerPermission(true),
        serverName: 'Updated display metadata',
      },
    };

    // When
    await new UserHandler().handleUpdateUserPermissions({
      data: { targetId: 'user-1', permissions },
    });

    // Then
    expect(updateUser).toHaveBeenCalledWith('user-1', {
      permissions: JSON.stringify(permissions),
    });
    expect(session.updatePermissions).toHaveBeenCalledWith(permissions);
    expect(session.sendToolListChanged).not.toHaveBeenCalled();
    expect(session.sendResourceListChanged).not.toHaveBeenCalled();
    expect(session.sendPromptListChanged).not.toHaveBeenCalled();
    expect(notifyPermissionChangedByUser).toHaveBeenCalledWith('user-1');
  });

  test('updates active sessions when action 1012 changes permissions', async () => {
    // Given
    const permissions = { 'server-a': emptyServerPermission(false) };

    // When
    await new UserHandler().handleUpdateUser({
      data: { userId: 'user-1', permissions },
    });

    // Then
    expect(session.updatePermissions).toHaveBeenCalledWith(permissions);
    expect(notifyPermissionChangedByUser).toHaveBeenCalledWith('user-1');
  });

  test('updates permissions and profile fields in one action 1012 database write', async () => {
    // Given
    const permissions = { 'server-a': emptyServerPermission(false) };

    // When
    await new UserHandler().handleUpdateUser({
      data: {
        userId: 'user-1',
        name: 'Updated Name',
        notes: 'Updated notes',
        permissions,
      },
    });

    // Then
    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(updateUser).toHaveBeenCalledWith('user-1', {
      name: 'Updated Name',
      notes: 'Updated notes',
      permissions: JSON.stringify(permissions),
    });
  });
});
