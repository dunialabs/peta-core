import type { Prisma, User } from '@prisma/client';
import { SessionStore } from '../../mcp/core/SessionStore.js';
import { UserRepository } from '../../repositories/UserRepository.js';
import { DisconnectReason } from '../../types/auth.types.js';
import { Permissions } from '../../mcp/types/mcp.js';
import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { prisma } from '../../config/prisma.js';
import { UserRole, UserStatus, MCPEventLogType } from '../../types/enums.js';
import { LogService } from '../../log/LogService.js';
import { CapabilitiesService } from '../../mcp/services/CapabilitiesService.js';
import { socketNotifier } from '../../socket/SocketNotifier.js';
import { CryptoService } from '../../security/CryptoService.js';
import { createLogger } from '../../logger/index.js';

/**
 * User operation handler (1000-1999)
 */
export class UserHandler {
  // Logger for UserHandler
  private logger = createLogger('UserHandler');

  constructor() {}

  /**
   * Disable user (1001)
   */
  async handleDisableUser(request: AdminRequest<any>): Promise<any> {
    const { targetId } = request.data;
    await this.disableUser(targetId);
    return null;
  }

  /**
   * Update user permissions (1002)
   */
  async handleUpdateUserPermissions(request: AdminRequest<any>): Promise<any> {
    const { targetId, permissions } = request.data;
    await this.updateUserPermissions(targetId, typeof permissions === 'string' ? permissions : JSON.stringify(permissions));

    // Log admin operation
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminUserEdit,
      requestParams: JSON.stringify({ userId: targetId, permissions: permissions })
    });

    return null;
  }

  /**
   * Create user (1010)
   */
  async handleCreateUser(request: AdminRequest<any>, token?: string): Promise<any> {
    const { userId, status, role, permissions, expiresAt, createdAt, updatedAt, ratelimit, name, encryptedToken, proxyId, notes } = request.data;

    // If role is owner, need to query database, error if non-empty data, only one owner allowed, and first created must be owner
    if (role === UserRole.Owner) {
      const users = await UserRepository.findAll();
      if (users.some((u: any) => u.role === UserRole.Owner)) {
        throw new AdminError('There can only be one owner', AdminErrorCode.USER_ALREADY_EXISTS);
      }
      // Owner can only be created as the first user
      if (users.length > 0) {
        throw new AdminError('The owner must be the first user created', AdminErrorCode.INVALID_REQUEST);
      }
    } else if (!token) {
      throw new AdminError('Token is required', AdminErrorCode.FORBIDDEN);
    }

    // Validate required fields
    if (!userId) {
      throw new AdminError('Missing required field: userId', AdminErrorCode.INVALID_REQUEST);
    }

    if (!encryptedToken) {
      throw new AdminError('Missing required field: encryptedToken', AdminErrorCode.INVALID_REQUEST);
    }

    let normalizedExpiresAt = expiresAt ?? 0;
    if (expiresAt !== undefined && expiresAt !== null) {
      const expiresAtNumber = typeof expiresAt === 'string' ? Number.parseInt(expiresAt, 10) : expiresAt;
      if (!Number.isFinite(expiresAtNumber)) {
        throw new AdminError('Invalid expiresAt', AdminErrorCode.INVALID_REQUEST);
      }
      normalizedExpiresAt = expiresAtNumber;
      if (expiresAtNumber >= 1_000_000_000_000) {
        normalizedExpiresAt = Math.floor(expiresAtNumber / 1000);
      }
    }

    // Check if user already exists
    const existingUser = await UserRepository.findByUserId(userId);
    if (existingUser) {
      throw new AdminError('User already exists', AdminErrorCode.USER_ALREADY_EXISTS);
    }

    if (role !== UserRole.Owner) {
      // Validate user data legitimacy: decrypt encryptedToken with token to get token plaintext, then calculate userId from token to verify userId consistency
      const decryptedToken = await CryptoService.decryptDataFromString(encryptedToken, token!);
      const calculatedUserId = await CryptoService.calculateUserId(decryptedToken);
      if (calculatedUserId !== userId) {
        throw new AdminError('Invalid token', AdminErrorCode.INVALID_REQUEST);
      }
    }

    // Create user
    const user = await UserRepository.create({
      userId,
      status: status ?? UserStatus.Enabled,
      role: role ?? UserRole.User,
      permissions: typeof permissions === 'string' ? permissions : JSON.stringify(permissions ?? {}),
      userPreferences: '{}',
      launchConfigs: '{}',
      expiresAt: normalizedExpiresAt,
      createdAt: createdAt ?? Math.floor(Date.now() / 1000),
      updatedAt: updatedAt ?? Math.floor(Date.now() / 1000),
      ratelimit: ratelimit ?? 100,
      name: name ?? '',
      encryptedToken: encryptedToken,
      proxyId: proxyId ?? 0,
      notes: notes ?? null
    });

    // Log admin operation
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminUserCreate,
      requestParams: JSON.stringify({ userId: userId })
    });

    return { user: user };
  }

  /**
   * Query user list (1011)
   */
  async handleGetUsers(request: AdminRequest<any>): Promise<any> {
    const { proxyId, role, excludeRole, userId } = request.data || {};

    // Exact query for specific user
    if (userId) {
      const user = await UserRepository.findByUserId(userId);
      return { users: user ? [user] : [] };
    }

    // Build query conditions
    const where: any = {};
    if (proxyId !== undefined) {
      const proxyIdInt = parseInt(proxyId);
      where.proxyId = proxyIdInt;
    }
    if (role !== undefined) {
      where.role = role;
    }
    if (excludeRole !== undefined) {
      where.role = { not: excludeRole };
    }

    const users = await prisma.user.findMany({
      where,
      select: {
        userId: true,
        status: true,
        role: true,
        permissions: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        ratelimit: true,
        name: true,
        encryptedToken: true,
        proxyId: true,
        notes: true,
      }
    });
    return { users: users };
  }

  /**
   * Update user (1012)
   */
  async handleUpdateUser(request: AdminRequest<any>): Promise<any> {
    const { userId, name, notes, permissions, status, encryptedToken } = request.data;

    if (!userId) {
      throw new AdminError('Missing required field: userId', AdminErrorCode.INVALID_REQUEST);
    }

    // Check if user exists
    const existingUser = await UserRepository.findByUserId(userId);
    if (!existingUser) {
      throw new AdminError('User not found', AdminErrorCode.USER_NOT_FOUND);
    }

    if (status != existingUser.status) {
      if (status === UserStatus.Disabled) {
        await this.disableUser(userId);
      }
    }

    // Prepare update data
    const updateData: Prisma.UserUpdateInput = {};
    if (name !== undefined) updateData.name = name;
    if (notes !== undefined) updateData.notes = notes;
    if (encryptedToken !== undefined) updateData.encryptedToken = encryptedToken;

    if (status !== undefined) updateData.status = status;

    const user = permissions === undefined
      ? await UserRepository.update(userId, updateData)
      : await this.updateUserPermissions(
        userId,
        typeof permissions === 'string' ? permissions : JSON.stringify(permissions),
        updateData,
        existingUser,
      );

    // Log admin operation
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminUserEdit,
      requestParams: JSON.stringify({ userId: userId })
    });

    return { user: user };
  }

  /**
   * Delete user (1013)
   */
  async handleDeleteUser(request: AdminRequest<any>): Promise<any> {
    const { userId } = request.data;

    if (!userId) {
      throw new AdminError('Missing required field: userId', AdminErrorCode.INVALID_REQUEST);
    }

    await this.disableUser(userId);

    await UserRepository.delete(userId);

    // Log admin operation
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminUserDelete,
      requestParams: JSON.stringify({ userId: userId })
    });

    return { message: 'User deleted successfully' };
  }

  /**
   * Delete users by proxy in bulk (1014)
   */
  async handleDeleteUsersByProxy(request: AdminRequest<any>): Promise<any> {
    const { proxyId } = request.data;

    if (proxyId === undefined) {
      throw new AdminError('Missing required field: proxyId', AdminErrorCode.INVALID_REQUEST);
    }

    const users = await UserRepository.findByProxyId(proxyId);
    for (const user of users) {
      await this.disableUser(user.userId);
    }

    const count = await UserRepository.deleteByProxyId(proxyId);

    // Log admin operation
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminUserDelete,
      requestParams: JSON.stringify({ proxyId: proxyId })
    });

    return { deletedCount: count };
  }

  /**
   * Count users (1015)
   */
  async handleCountUsers(request: AdminRequest<any>): Promise<any> {
    const { excludeRole } = request.data || {};

    let count: number;
    if (excludeRole !== undefined) {
      count = await UserRepository.countByCondition({ role: { not: excludeRole } });
    } else {
      count = await prisma.user.count();
    }

    return { count: count };
  }

  /**
   * Get Owner information (1016)
   */
  async handleGetOwner(request: AdminRequest<any>): Promise<any> {
    const owners = await UserRepository.findByRole(UserRole.Owner);

    if (owners.length === 0) {
      throw new AdminError(
        'Owner user not found in the system',
        AdminErrorCode.USER_NOT_FOUND
      );
    }

    return { owner: owners[0] };
  }

  // ==================== Helper Methods ====================

  private async disableUser(targetId: string): Promise<void> {
    // Find user
    const user = await UserRepository.findByUserId(targetId);
    if (!user) {
      throw new AdminError(`User ${targetId} not found`, AdminErrorCode.USER_NOT_FOUND);
    }

    await UserRepository.update(targetId, { status: UserStatus.Disabled });

    // Disconnect all active sessions for this user
    await SessionStore.instance.removeAllUserSessions(
      targetId,
      DisconnectReason.USER_DISABLED
    );

    return;
  }

  private async updateUserPermissions(
    targetId: string,
    permissions: string,
    updateData: Prisma.UserUpdateInput = {},
    existingUser?: User,
  ): Promise<User> {

    // Find user
    const user = existingUser ?? await UserRepository.findByUserId(targetId);
    if (!user) {
      throw new AdminError(`User ${targetId} not found`, AdminErrorCode.USER_NOT_FOUND);
    }

    if (permissions === user.permissions) {
      if (Object.keys(updateData).length === 0) return user;
      return await UserRepository.update(targetId, updateData);
    }

    // Get old permissions (for logging)
    const permissionsJson = JSON.parse(permissions) as Permissions;
    const oldPermissions = JSON.parse(user.permissions) as Permissions;
    const { toolsChanged, resourcesChanged, promptsChanged } = CapabilitiesService.comparePermissions(oldPermissions, permissionsJson);

    const updatedUser = await UserRepository.update(targetId, { ...updateData, permissions });

    // Get user sessions
    const userSessions = SessionStore.instance.getUserSessions(targetId);
    if (userSessions.length > 0) {
      // Update permissions for all active sessions (takes effect immediately)
      for (const session of userSessions) {
        session.updatePermissions(permissionsJson);
        if (toolsChanged) {
          session.sendToolListChanged();
        }
        if (resourcesChanged) {
          session.sendResourceListChanged();
        }
        if (promptsChanged) {
          session.sendPromptListChanged();
        }
      }
    }

    // ✨ Push complete capability configuration via Socket
    try {
      socketNotifier.notifyPermissionChangedByUser(targetId);
    } catch (error) {
      this.logger.error({ error, targetId }, 'Failed to notify permission changed via Socket for user');
    }

    return updatedUser;
  }
}
