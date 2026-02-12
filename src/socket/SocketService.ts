/**
 * SocketService - Socket.IO core service
 *
 * Features:
 * 1. Initialize Socket.IO server (attach to Express HTTP/HTTPS server)
 * 2. Token authentication middleware (integrate existing TokenValidator)
 * 3. User Room management (support multi-device login)
 * 4. Connection mapping management (userId -> UserConnection[])
 * 5. Event listening and handling
 */

import { Server as HttpServer } from 'http';
import { Server as HttpsServer } from 'https';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { TokenValidator } from '../security/TokenValidator.js';
import { AuthError } from '../types/auth.types.js';
import {
  UserConnection,
  ClientInfo,
  SocketEvents,
  SocketData,
  SocketAuthData,
  SocketResponse,
  SocketActionType,
  SOCKET_RESPONSE_EVENT
} from './types/socket.types.js';
import { createLogger } from '../logger/index.js';
import { APP_INFO } from '../config/config.js';
import { ProxyRepository } from '../repositories/ProxyRepository.js';
import { UserRequestHandler } from '../user/UserRequestHandler.js';

/**
 * Pending request storage item
 */
interface PendingRequest {
  resolver: (response: SocketResponse) => void;
  timer: NodeJS.Timeout;
  userId: string;
  action: SocketActionType;
  createdAt: Date;
}

export class SocketService {
  private io: SocketIOServer | null = null;
  private tokenValidator: TokenValidator;
  private connections: Map<string, UserConnection[]> = new Map();
  private serverName: string = "Peta Core";
  private serverId: string = "peta-core";

  // Logger for SocketService
  private logger = createLogger('SocketService');

  // ==================== Request-Response Pattern Support ====================
  /**
   * Pending request mapping (requestId -> PendingRequest)
   * Used to store requests waiting for responses
   */
  private pendingRequests: Map<string, PendingRequest> = new Map();

  constructor() {
    this.tokenValidator = new TokenValidator();
  }

  /**
   * Initialize Socket.IO server
   * @param httpServer HTTP or HTTPS server instance
   */
  initialize(httpServer: HttpServer | HttpsServer): void {
    this.logger.info('Initializing Socket.IO server...');

    // Create Socket.IO server
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: '*',  // Production environment should configure specific domain
        methods: ['GET', 'POST'],
        credentials: true
      },
      path: '/socket.io',
      transports: ['websocket', 'polling'], // Support WebSocket and polling
      pingTimeout: 60000,  // 60 seconds
      pingInterval: 25000  // 25 seconds
    });

    // Register authentication middleware
    this.setupAuthMiddleware();

    // Register connection event handlers
    this.setupConnectionHandlers();

    this.updateServerInfo();

    this.logger.info('Socket.IO server initialized successfully');
  }

  /**
   * Update server information
   */
  updateServerInfo(): void {
    ProxyRepository.findFirst().then((proxy) => {
      if (proxy) {
        this.serverName = proxy.name;
        this.serverId = proxy.proxyKey;
      }
    });
  }

  /**
   * Setup authentication middleware
   * Validates Token during client connection handshake
   */
  private setupAuthMiddleware(): void {
    if (!this.io) {
      throw new Error('Socket.IO server not initialized');
    }

    this.io.use(async (socket, next) => {
      try {
        // 1. Get token from handshake information (supports two methods)
        const authData = socket.handshake.auth as SocketAuthData;
        const authHeader = socket.handshake.headers.authorization;

        let token: string | undefined;

        // Prefer auth.token (recommended method)
        if (authData && authData.token) {
          token = authData.token;
        }
        // Otherwise use Authorization header
        else if (authHeader && authHeader.startsWith('Bearer ')) {
          token = authHeader.replace('Bearer ', '');
        }

        if (!token) {
          this.logger.warn({ socketId: socket.id }, 'Socket connection rejected: Missing token');
          return next(new Error('Missing authentication token'));
        }

        // 2. Call existing validation function (throws AuthError exception)
        const authContext = await this.tokenValidator.validateToken(token);

        // 3. Authentication successful, attach authentication information to socket.data
        socket.data = {
          userId: authContext.userId,
          authContext: authContext,
          userToken: token  // Save token for subsequent encryption operations
        } as SocketData;

        this.logger.info({ userId: authContext.userId, socketId: socket.id }, 'Socket authenticated');
        next();

      } catch (error) {
        // 4. Handle authentication failure
        if (error instanceof AuthError) {
          this.logger.warn({ error: error.message, type: error.type }, 'Socket authentication failed');
          return next(new Error(`Authentication failed: ${error.message}`));
        } else {
          this.logger.error({ error }, 'Socket authentication error');
          return next(new Error('Authentication failed'));
        }
      }
    });
  }

  /**
   * Setup connection event handlers
   */
  private setupConnectionHandlers(): void {
    if (!this.io) {
      throw new Error('Socket.IO server not initialized');
    }

    this.io.on('connection', (socket: Socket) => {
      const socketData = socket.data as SocketData;
      const userId = socketData.userId;

      this.logger.info({ userId, socketId: socket.id }, 'Client connected');

      // 1. Join socket to Room named by userId
      socket.join(userId);

      // 2. Record connection information
      const connection: UserConnection = {
        userId,
        socketId: socket.id,
        connectedAt: new Date()
      };

      // Add to connection mapping
      if (!this.connections.has(userId)) {
        this.connections.set(userId, []);
      }
      this.connections.get(userId)!.push(connection);

      this.logger.debug({ userId, deviceCount: this.connections.get(userId)!.length }, 'User devices online');

      // 3. Listen for client information (optional)
      socket.on(SocketEvents.CLIENT_INFO, (clientInfo: ClientInfo) => {
        this.logger.debug({ userId, clientInfo }, 'Client info received');

        // Update connection information
        const userConnections = this.connections.get(userId);
        if (userConnections) {
          const conn = userConnections.find(c => c.socketId === socket.id);
          if (conn) {
            conn.deviceType = clientInfo.deviceType;
            conn.deviceName = clientInfo.deviceName;
            conn.appVersion = clientInfo.appVersion;
          }
        }

        // Update socket.data
        socketData.deviceType = clientInfo.deviceType;
        socketData.deviceName = clientInfo.deviceName;
        socketData.appVersion = clientInfo.appVersion;
      });

      // 4. Listen for client messages
      socket.on(SocketEvents.CLIENT_MESSAGE, (data: any) => {
        this.logger.debug({ userId, data }, 'Message received');

        // Send acknowledgment
        socket.emit(SocketEvents.ACK, {
          message: 'Message received',
          timestamp: Date.now()
        });
      });

      // 4.1 Listen for client responses (request-response pattern)
      socket.on(SOCKET_RESPONSE_EVENT, (response: SocketResponse) => {
        this.handleClientResponse(response);
      });

      // 4.2 Listen for get capabilities request
      socket.on('get_capabilities', async (request: any) => {
        try {
          // Call UserRequestHandler (transport-agnostic business logic)
          const capabilities = await UserRequestHandler.instance.handleGetCapabilities(userId);

          const response: SocketResponse = {
            requestId: request.requestId,
            success: true,
            data: { capabilities: capabilities },
            timestamp: Date.now()
          };

          socket.emit(SOCKET_RESPONSE_EVENT, response);
        } catch (error: any) {
          this.logger.error({ error, userId }, 'Failed to handle get_capabilities');

          const response: SocketResponse = {
            requestId: request.requestId,
            success: false,
            error: {
              code: 1201, // SERVER_ERROR
              message: error.message || 'Failed to get capabilities'
            },
            timestamp: Date.now()
          };

          socket.emit(SOCKET_RESPONSE_EVENT, response);
        }
      });

      // 4.3 Listen for set capabilities request
      socket.on('set_capabilities', async (request: any) => {
        try {
          // Call UserRequestHandler (transport-agnostic business logic)
          await UserRequestHandler.instance.handleSetCapabilities(userId, request.data);

          const response: SocketResponse = {
            requestId: request.requestId,
            success: true,
            timestamp: Date.now()
          };

          socket.emit(SOCKET_RESPONSE_EVENT, response);
        } catch (error: any) {
          this.logger.error({ error, userId }, 'Failed to handle set_capabilities');

          const response: SocketResponse = {
            requestId: request.requestId,
            success: false,
            error: {
              code: 1201, // SERVER_ERROR
              message: error.message || 'Failed to set capabilities'
            },
            timestamp: Date.now()
          };

          socket.emit(SOCKET_RESPONSE_EVENT, response);
        }
      });

      // 5. Listen for configure Server event
      socket.on('configure_server', async (request: any) => {
        try {
          // Call UserRequestHandler (transport-agnostic business logic)
          const result = await UserRequestHandler.instance.handleConfigureServer(
            userId,
            socketData.userToken,
            request.data
          );

          const response: SocketResponse = {
            requestId: request.requestId,
            success: true,
            data: result,
            timestamp: Date.now()
          };

          socket.emit(SOCKET_RESPONSE_EVENT, response);
        } catch (error: any) {
          this.logger.error({ error, userId }, 'configure_server failed');

          const response: SocketResponse = {
            requestId: request.requestId,
            success: false,
            error: {
              code: 1201, // SERVER_ERROR
              message: error.message || 'Failed to configure server'
            },
            timestamp: Date.now()
          };

          socket.emit(SOCKET_RESPONSE_EVENT, response);
        }
      });

      // 5.1 Listen for unconfigure Server event
      socket.on('unconfigure_server', async (request: any) => {
        try {
          // Call UserRequestHandler (transport-agnostic business logic)
          const result = await UserRequestHandler.instance.handleUnconfigureServer(
            userId,
            request.data
          );

          const response: SocketResponse = {
            requestId: request.requestId,
            success: true,
            data: result,
            timestamp: Date.now()
          };

          socket.emit(SOCKET_RESPONSE_EVENT, response);
        } catch (error: any) {
          this.logger.error({ error, userId }, 'unconfigure_server failed');

          const response: SocketResponse = {
            requestId: request.requestId,
            success: false,
            error: {
              code: 1201, // SERVER_ERROR
              message: error.message || 'Failed to unconfigure server'
            },
            timestamp: Date.now()
          };

          socket.emit(SOCKET_RESPONSE_EVENT, response);
        }
      });

      // 6. Listen for disconnect event
      socket.on('disconnect', (reason: string) => {
        this.logger.info({ userId, socketId: socket.id, reason }, 'Client disconnected');

        // Remove from connection mapping
        const userConnections = this.connections.get(userId);
        if (userConnections) {
          const index = userConnections.findIndex(c => c.socketId === socket.id);
          if (index !== -1) {
            userConnections.splice(index, 1);
          }

          if (userConnections.length === 0) {
            this.connections.delete(userId);
            this.logger.info({ userId }, 'User is now offline (all devices disconnected)');

            // Clear all pending requests for this user
            this.clearUserPendingRequests(userId);
          } else {
            this.logger.debug({ userId, deviceCount: userConnections.length }, 'User still has devices online');
          }
        }
      });

      // 6. Listen for error event
      socket.on('error', (error: Error) => {
        this.logger.error({ error, userId }, 'Socket error');
      });

      socket.emit('server_info', {
        serverId: this.serverId,
        serverName: this.serverName,
        version: APP_INFO.version,
      });

      // 7. Actively push capability configuration after successful connection
      (async () => {
        try {
          // Use socketNotifier to push capability change notification
          const { socketNotifier } = await import('../socket/SocketNotifier.js');
          socketNotifier.notifyPermissionChangedByUser(userId);

          // Push online session information
          socketNotifier.notifyOnlineSessions(userId);

          this.logger.debug({ userId }, 'Initial capabilities and online sessions sent');
        } catch (error: any) {
          this.logger.error({ error, userId }, 'Failed to send initial capabilities and online sessions');
        }
      })();

    });
  }

  /**
   * Get Socket.IO server instance
   */
  getIO(): SocketIOServer {
    if (!this.io) {
      throw new Error('Socket.IO server not initialized');
    }
    return this.io;
  }

  /**
   * Get all connections for a user
   */
  getUserConnections(userId: string): UserConnection[] {
    return this.connections.get(userId) || [];
  }

  /**
   * Get user's online device count
   */
  getUserDeviceCount(userId: string): number {
    return this.connections.get(userId)?.length || 0;
  }

  /**
   * Check if user is online
   */
  isUserOnline(userId: string): boolean {
    return this.connections.has(userId) && this.connections.get(userId)!.length > 0;
  }

  /**
   * Get all online user IDs
   */
  getOnlineUserIds(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Get total connection count
   */
  getTotalConnections(): number {
    let total = 0;
    this.connections.forEach(conns => {
      total += conns.length;
    });
    return total;
  }

  /**
   * Disconnect all client connections (but do not close server)
   * Used to disconnect Socket.IO clients before closing HTTP server
   */
  disconnectAll(): void {
    if (this.io) {
      this.logger.info('Disconnecting all Socket.IO clients...');

      // Clear all pending requests
      this.clearAllPendingRequests();

      // Disconnect all client connections
      this.io.disconnectSockets();

      // Clear connection mapping
      this.connections.clear();

      this.logger.info('All Socket.IO clients disconnected');
    }
  }

  /**
   * Close Socket.IO server
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down Socket.IO server...');

    if (this.io) {
      // Close server (client connections should already be disconnected in disconnectAll())
      await new Promise<void>((resolve) => {
        this.io!.close(() => {
          this.logger.info('Socket.IO server closed');
          resolve();
        });
      });

      this.io = null;
    }

    this.logger.info('Socket.IO server shutdown complete');
  }

  // ==================== Request-Response Pattern Management Methods ====================

  /**
   * Add pending request
   * @param requestId Request ID
   * @param request Pending request object
   */
  addPendingRequest(requestId: string, request: PendingRequest): void {
    this.pendingRequests.set(requestId, request);
    this.logger.debug({ requestId, action: request.action, total: this.pendingRequests.size }, 'Pending request added');
  }

  /**
   * Remove pending request
   * @param requestId Request ID
   */
  removePendingRequest(requestId: string): void {
    const request = this.pendingRequests.get(requestId);
    if (request) {
      clearTimeout(request.timer);
      this.pendingRequests.delete(requestId);
      this.logger.debug({ requestId, total: this.pendingRequests.size }, 'Pending request removed');
    }
  }

  /**
   * Handle client response
   * @param response Response object sent by client
   */
  private handleClientResponse(response: SocketResponse): void {
    this.logger.debug({ requestId: response.requestId, success: response.success }, 'Client response received');

    const pending = this.pendingRequests.get(response.requestId);

    if (pending) {
      // Clear timer
      clearTimeout(pending.timer);

      // Resolve Promise
      pending.resolver(response);

      // Remove pending request
      this.pendingRequests.delete(response.requestId);

      this.logger.debug({ requestId: response.requestId, duration: Date.now() - pending.createdAt.getTime() }, 'Request completed');
    } else {
      this.logger.warn({ requestId: response.requestId }, 'Received response for unknown requestId');
    }
  }

  /**
   * Clear all pending requests for specified user (called when user disconnects)
   * @param userId User ID
   */
  private clearUserPendingRequests(userId: string): void {
    let clearedCount = 0;

    this.pendingRequests.forEach((request, requestId) => {
      if (request.userId === userId) {
        clearTimeout(request.timer);
        this.pendingRequests.delete(requestId);
        clearedCount++;
      }
    });

    if (clearedCount > 0) {
      this.logger.debug({ userId, clearedCount }, 'Cleared pending requests for disconnected user');
    }
  }

  /**
   * Clear all pending requests (called during shutdown)
   */
  private clearAllPendingRequests(): void {
    this.pendingRequests.forEach((request, requestId) => {
      clearTimeout(request.timer);
    });

    const count = this.pendingRequests.size;
    this.pendingRequests.clear();

    if (count > 0) {
      this.logger.debug({ count }, 'Cleared all pending requests');
    }
  }

  /**
   * Get pending request count
   */
  getPendingRequestCount(): number {
    return this.pendingRequests.size;
  }
}
