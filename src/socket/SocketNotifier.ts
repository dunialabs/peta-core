/**
 * SocketNotifier - Socket.IO message push utility class
 *
 * Provides convenient message push functions:
 * 1. notifyUser - Push to all devices of specified user
 * 2. notifyDevice - Push to specific device
 * 3. notifyAll - Broadcast to all online users
 * 4. getUserDeviceCount - Get user's online device count
 * 5. isUserOnline - Check if user is online
 *
 * Usage example:
 * ```typescript
 * import { socketNotifier } from './socket/SocketNotifier.js';
 *
 * // Push to specified user
 * socketNotifier.notifyUser('user123', 'notification', {
 *   type: 'user_disabled',
 *   message: 'Your account has been disabled',
 *   timestamp: Date.now()
 * });
 * ```
 */

import { randomUUID } from 'crypto';
import { SocketService } from './SocketService.js';
import {
  NotificationData,
  SocketEvents,
  SocketRequest,
  SocketResponse,
  SocketActionType,
  SocketErrorCode,
  actionToEventName
} from './types/socket.types.js';
import UserRepository from '../repositories/UserRepository.js';
import { Permissions } from '../mcp/types/mcp.js';
import { createLogger } from '../logger/index.js';
import { UserRequestHandler } from '../user/UserRequestHandler.js';

export class SocketNotifier {
  private socketService: SocketService | null = null;

  // Logger for SocketNotifier
  private logger = createLogger('SocketNotifier');

  static instance: SocketNotifier = new SocketNotifier();
  static getInstance(): SocketNotifier {
    return SocketNotifier.instance;
  }

  private constructor() {}

  /**
   * Set SocketService instance
   * Must be called before using push functions
   */
  setSocketService(socketService: SocketService): void {
    this.socketService = socketService;
  }

  /**
   * Check if service is initialized
   */
  private ensureInitialized(): void {
    if (!this.socketService) {
      throw new Error('SocketNotifier not initialized. Call setSocketService() first.');
    }
  }

  /**
   * Push notification to all devices of specified user
   * @param userId User ID
   * @param event Event name
   * @param data Event data
   * @returns Whether push succeeded (whether user is online)
   */
  notifyUser(userId: string, event: string, data: any): boolean {
    this.ensureInitialized();

    const io = this.socketService!.getIO();
    const isOnline = this.socketService!.isUserOnline(userId);

    if (isOnline) {
      // Use Room mechanism to push to all devices of this user
      io.to(userId).emit(event, data);

      const deviceCount = this.socketService!.getUserDeviceCount(userId);
      this.logger.debug({ userId, deviceCount, event }, 'Notification sent to user');

      return true;
    } else {
      this.logger.debug({ userId, event }, 'User is offline, notification not sent');
      return false;
    }
  }

  /**
   * Push notification to specified device
   * @param socketId Socket ID
   * @param event Event name
   * @param data Event data
   */
  notifyDevice(socketId: string, event: string, data: any): void {
    this.ensureInitialized();

    const io = this.socketService!.getIO();
    io.to(socketId).emit(event, data);

    this.logger.debug({ socketId, event }, 'Notification sent to device');
  }

  /**
   * Broadcast notification to all online users
   * @param event Event name
   * @param data Event data
   */
  notifyAll(event: string, data: any): void {
    this.ensureInitialized();

    const io = this.socketService!.getIO();
    io.emit(event, data);

    const totalConnections = this.socketService!.getTotalConnections();
    this.logger.debug({ totalConnections, event }, 'Broadcast notification sent to all clients');
  }

  /**
   * Get user's online device count
   * @param userId User ID
   * @returns Online device count
   */
  getUserDeviceCount(userId: string): number {
    this.ensureInitialized();
    return this.socketService!.getUserDeviceCount(userId);
  }

  /**
   * Check if user is online
   * @param userId User ID
   * @returns Whether user is online
   */
  isUserOnline(userId: string): boolean {
    this.ensureInitialized();
    return this.socketService!.isUserOnline(userId);
  }

  /**
   * Get all connection information for a user
   * @param userId User ID
   * @returns Connection information array
   */
  getUserConnections(userId: string) {
    this.ensureInitialized();
    return this.socketService!.getUserConnections(userId);
  }

  /**
   * Get all online user ID list
   * @returns Online user ID array
   */
  getOnlineUserIds(): string[] {
    this.ensureInitialized();
    return this.socketService!.getOnlineUserIds();
  }

  /**
   * Get total connection count
   * @returns Total connection count
   */
  getTotalConnections(): number {
    this.ensureInitialized();
    return this.socketService!.getTotalConnections();
  }

  // ==================== Convenient Push Functions (Using Predefined Notification Format) ====================

  /**
   * Push system notification (using standard NotificationData format)
   * @param userId User ID
   * @param notification Notification data
   * @returns Whether push succeeded
   */
  sendNotification(userId: string, notification: NotificationData): boolean {
    return this.notifyUser(userId, SocketEvents.NOTIFICATION, notification);
  }

  /**
   * Push user disabled notification
   * @param userId User ID
   * @param reason Disable reason (optional)
   */
  notifyUserDisabled(userId: string, reason?: string): boolean {
    return this.sendNotification(userId, {
      type: 'user_disabled',
      message: reason || 'Your account has been disabled by administrator',
      timestamp: Date.now(),
      severity: 'error'
    });
  }

  async notifyPermissionChangedByUser(userId: string): Promise<boolean> {
    try {
      // Get capabilities from UserRequestHandler (transport-agnostic business logic)
      const capabilities = await UserRequestHandler.instance.handleGetCapabilities(userId);
      return this.notifyPermissionChanged(userId, capabilities);
    } catch (error: any) {
      this.logger.error({ error: error?.message ?? String(error), userId }, 'Failed to notify permission changed');
      return false;
    }
  }

  /**
   * Push permission change notification
   * @param userId User ID
   * @param capabilities User's complete capability configuration
   */
  notifyPermissionChanged(userId: string, capabilities: any): boolean {
    return this.sendNotification(userId, {
      type: 'permission_changed',
      message: 'User permissions have been updated',
      data: { capabilities: capabilities },
      timestamp: Date.now(),
      severity: 'warning'
    });
  }

  /**
   * Push user online session list notification
   * @param userId User ID
   * @returns Whether notification was successfully pushed
   */
  async notifyOnlineSessions(userId: string): Promise<boolean> {
    this.logger.debug({ userId }, 'Notifying user online sessions');

    try {
      // Get session data from UserRequestHandler (transport-agnostic business logic)
      const sessionData = await UserRequestHandler.instance.handleGetOnlineSessions(userId);

      // Send notification
      const success = this.sendNotification(userId, {
        type: 'online_sessions',
        message: `You have ${sessionData.length} active session(s)`,
        data: { sessions: sessionData },
        timestamp: Date.now(),
        severity: 'info'
      });

      this.logger.debug({ userId, count: sessionData.length, success }, 'Online sessions notification sent');
      return success;

    } catch (error: any) {
      this.logger.error({ error: error.message, userId }, 'Failed to notify online sessions');
      return false;
    }
  }

  // Notify users affected by server capability changes of permission changes
  async notifyUserPermissionChangedByServer(serverId: string): Promise<void> {
    this.logger.info({ serverId }, 'Notifying user permission changed by server');
    try {
      const users = await UserRepository.findAll();
      const onlineUserIds = this.getOnlineUserIds();
      const onlineUsers = users.filter(user => onlineUserIds.includes(user.userId));
      for (const user of onlineUsers) {
        try {
          const permissions = JSON.parse(user.permissions) as Permissions;
          if (!permissions || permissions[serverId]?.enabled !== false) {
            this.notifyPermissionChangedByUser(user.userId);
          }
        } catch (error) {
          this.logger.error({ error, userId: user.userId }, 'Failed to notify user permission changed via Socket for user');
        }
      }
    } catch (error) {
      this.logger.error({ error, serverId }, 'Failed to notify user permission changed via Socket for server');
    }
  }

  /**
   * Push system message
   * @param userId User ID (if null, broadcast to everyone)
   * @param message Message content
   * @param severity Severity level
   */
  sendSystemMessage(userId: string | null, message: string, severity: 'info' | 'warning' | 'error' | 'success' = 'info'): void {
    const notification: NotificationData = {
      type: 'system_message',
      message,
      timestamp: Date.now(),
      severity
    };

    if (userId) {
      this.sendNotification(userId, notification);
    } else {
      this.notifyAll(SocketEvents.NOTIFICATION, notification);
    }
  }

  // ==================== Request-Response Pattern ====================

  /**
   * Send request and wait for client response (core method)
   *
   * This is an async method that waits for client response or timeout.
   * Always returns SocketResponse object, never throws exceptions.
   *
   * @param userId User ID
   * @param action Action type (SocketActionType enum)
   * @param data Request data (generic)
   * @param timeout Timeout in milliseconds, default 55000ms
   * @returns Promise<SocketResponse<TRes>> Response object (success is true/false)
   *
   * @example
   * ```typescript
   * const response = await socketNotifier.sendRequest<
   *   { message: string },
   *   { confirmed: boolean }
   * >('user123', SocketActionType.ASK_USER_CONFIRM, {
   *   message: 'Are you sure you want to delete this server?'
   * }, 15000);
   *
   * if (response.success) {
   *   console.log('User confirmed:', response.data);
   * } else {
   *   console.error('Request failed:', response.error);
   * }
   * ```
   */
  async sendRequest<TReq = any, TRes = any>(
    userId: string,
    action: SocketActionType,
    data: TReq,
    timeout: number = 55000
  ): Promise<SocketResponse<TRes>> {
    this.ensureInitialized();

    // 1. Check if user is online
    if (!this.socketService!.isUserOnline(userId)) {
      this.logger.warn({ userId, action }, 'Request failed: User is offline');
      return {
        requestId: '',
        success: false,
        error: {
          code: SocketErrorCode.USER_OFFLINE,
          message: `User ${userId} is offline`
        },
        timestamp: Date.now()
      };
    }

    // 2. Generate unique requestId
    const requestId = randomUUID();

    // 3. Construct request object
    const request: SocketRequest<TReq> = {
      requestId,
      action,
      data,
      timestamp: Date.now()
    };

    // 4. Create Promise and set timeout
    const response = await new Promise<SocketResponse<TRes>>((resolve) => {
      // Set timeout timer
      const timer = setTimeout(() => {
        this.socketService!.removePendingRequest(requestId);
        this.logger.warn({ requestId, action, timeout }, 'Request timeout');

        resolve({
          requestId,
          success: false,
          error: {
            code: SocketErrorCode.TIMEOUT,
            message: `Request timeout after ${timeout}ms`
          },
          timestamp: Date.now()
        });
      }, timeout);

      // Store resolver and timer
      this.socketService!.addPendingRequest(requestId, {
        resolver: resolve,
        timer,
        userId,
        action,
        createdAt: new Date()
      });

      // 5. Send request (using dynamic event name)
      const eventName = actionToEventName(action);
      const io = this.socketService!.getIO();
      io.to(userId).emit(eventName, request);

      const deviceCount = this.socketService!.getUserDeviceCount(userId);
      this.logger.debug({ userId, action, requestId, event: eventName, deviceCount }, 'Request sent');
    });

    return response;
  }

  /**
   * Request user confirmation for operation (convenient wrapper)
   *
   * @param userId User ID
   * @param toolName Tool name
   * @param toolDescription Tool description
   * @param toolParams Tool parameters (JSON string format)
   * @param timeout Timeout in milliseconds, default 55000ms
   * @returns Promise<boolean> Whether user confirmed (true=confirmed, false=rejected or timeout)
   *
   * @example
   * ```typescript
   * const confirmed = await socketNotifier.askUserConfirm(
   *   'user123',
   *   'delete_server',
   *   'Delete a server permanently',
   *   JSON.stringify({ serverId: 'abc123', force: true })
   * );
   *
   * if (confirmed) {
   *   await deleteServer(serverId);
   * }
   * ```
   */
  async askUserConfirm(
    userId: string,
    userAgent: string,
    ip: string,
    toolName: string,
    toolDescription: string,
    toolParams: string,
    timeout?: number
  ): Promise<boolean> {
    const response = await this.sendRequest<
      { userAgent: string; ip: string; toolName: string; toolDescription: string; toolParams: string },
      { confirmed: boolean }
    >(userId, SocketActionType.ASK_USER_CONFIRM, {
      userAgent,
      ip,
      toolName,
      toolDescription,
      toolParams
    }, timeout);

    return response.success && response.data?.confirmed === true;
  }

  /**
   * Get client status (convenient wrapper)
   *
   * @param userId User ID
   * @param timeout Timeout in milliseconds, default 5000ms
   * @returns Promise<any | null> Client status data, returns null on failure
   */
  async getClientStatus(userId: string, timeout: number = 5000): Promise<any | null> {
    const response = await this.sendRequest(
      userId,
      SocketActionType.GET_CLIENT_STATUS,
      {},
      timeout
    );

    return response.success ? response.data : null;
  }

}

// Export singleton instance
export const socketNotifier = SocketNotifier.instance;
