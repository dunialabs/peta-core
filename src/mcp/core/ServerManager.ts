import { ServerContext } from './ServerContext.js';
import { ServerRepository } from '../../repositories/ServerRepository.js';
import { UserRepository } from '../../repositories/UserRepository.js';
import { DownstreamTransportFactory } from './DownstreamTransportFactory.js';
import { Client, ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import { ServerAuthType, ServerCategory, ServerStatus } from '../../types/enums.js';
import { Permissions, ServerConfigCapabilities } from '../types/mcp.js';
import { CryptoService } from '../../security/CryptoService.js';
import { AuthStrategyFactory } from '../auth/AuthStrategyFactory.js';
import { PetaAuthStrategy } from '../auth/PetaAuthStrategy.js';
import { AuthError, AuthErrorType } from '../../types/auth.types.js';
import { McpServerCapabilities } from '../types/mcp.js';
import { GlobalRequestRouter } from './GlobalRequestRouter.js';
import { LogService } from '../../log/LogService.js';
import { SessionStore } from './SessionStore.js';
import { ServerLogger } from '../../log/ServerLogger.js';
import { MCPEventLogType } from '../../types/enums.js';
import {
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
  ElicitRequestSchema,
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  CancelledNotificationSchema,
  ProgressNotificationSchema,
  type CancelledNotification,
  type ProgressNotification,
  type ToolListChangedNotification,
  type ResourceListChangedNotification,
  type PromptListChangedNotification,
  ResourceUpdatedNotificationSchema,
  ResourceUpdatedNotification,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { APP_INFO } from '../../config/config.js';
import { Server, User } from '@prisma/client';
import { ClientSession } from './ClientSession.js';
import { socketNotifier } from '../../socket/SocketNotifier.js';
import { ProxyContext } from '../../types/mcp.types.js';
import { createLogger } from '../../logger/index.js';
import * as path from 'path';
import { resolveHostPath } from '../../utils/DockerHostPathResolver.js';

/**
 * Subscription state structure
 */
interface SubscriptionState {
  subscribedSessions: Set<string>;  // Session IDs subscribed to this resource
  downstreamSubscribed: boolean;     // Whether already subscribed to downstream
}

/**
 * Global ServerContext manager
 * Manages connections to all downstream servers, shared by all client sessions
 */
export class ServerManager {
  private serverContexts: Map<string, ServerContext> = new Map();
  private serverLoggers: Map<string, ServerLogger> = new Map();
  // Temporary server storage, key format: `${serverId}:${userId}`
  private temporaryServers: Map<string, ServerContext> = new Map();
  private temporaryServerLoggers: Map<string, ServerLogger> = new Map();
  private globalRouter?: GlobalRequestRouter;
  private clientOptions: ClientOptions = {
    capabilities: {
      // Declare client capabilities so server knows it can initiate reverse requests
      // sampling: {},
      // roots: { listChanged: true },
      // elicitation: {}
    }
  };

  // Resource subscription state management key: `${serverId}::${resourceUri}`
  private resourceSubscriptions: Map<string, SubscriptionState> = new Map();

  // Concurrent protection: waiting queues for servers being started
  private serverWaitQueues: Map<string, Promise<ServerContext>> = new Map();

  // Owner token cache (for lazy start)
  private ownerToken?: string;

  // Idle check timer
  private idleCheckTimer?: NodeJS.Timeout;
  private readonly IDLE_CHECK_INTERVAL = 5 * 60 * 1000;  // Check every 5 minutes
  private readonly IDLE_TIMEOUT = 5 * 60 * 1000;  // 5 minute idle timeout

  // Logger for ServerManager
  private logger = createLogger('ServerManager');

  static readonly instance: ServerManager = new ServerManager();

  private constructor() {

    this.getAllEnabledServers().then((servers) => {
      for (const server of servers) {
        if (server.allowUserInput) {
          continue;
        }

        if (!this.isLazyStartApplicable(server)) {
          continue;
        }

        const context = new ServerContext(server);
        this.serverContexts.set(server.serverId, context);

        // Create ServerLogger for this server
        const serverLogger = new ServerLogger(server.serverId);
        this.serverLoggers.set(server.serverId, serverLogger);

        // Initialize in Sleeping state, don't start
        context.status = ServerStatus.Sleeping;
      }
      this.logger.info({ count: servers.length }, 'All enabled servers initialized in sleeping state (lazy start enabled)');

      this.startIdleCheck();
    }).catch((error) => {
      this.logger.error({ error }, 'Failed to initialize enabled servers in sleeping state');
    });
  }

  /**
   * Set Owner token (called only when Owner accesses API)
   */
  setOwnerToken(token: string): void {
    this.ownerToken = token;
  }

  /**
   * Get Owner token (for lazy start)
   */
  getOwnerToken(): string {
    if (!this.ownerToken) {
      throw new McpError(ErrorCode.InvalidParams, 'Owner token not available. Please ensure Owner has accessed the API at least once.');
    }
    return this.ownerToken;
  }

  /**
   * Ensure server is available (lazy start)
   *
   * @param serverId Server ID
   * @param userId User ID (for temporary servers)
   * @returns ServerContext
   */
  async ensureServerAvailable(
    serverId: string,
    userId?: string
  ): Promise<ServerContext> {
    
    let context = this.getServerContext(serverId, userId);

    if (!context) {
      throw new McpError(ErrorCode.InvalidParams, `Server ${serverId} not found in server contexts`);
    }

    // Case 1: Server is online, update last activity time
    if (context.status === ServerStatus.Online) {
      context.lastActive = Date.now();
      return context;
    }

    let key: string;
    if (context.serverEntity.allowUserInput) {
      key = `${serverId}:${userId}`;
    } else {
      key = serverId;
    }


    // Case 2: Server is starting (another request triggered start), wait for completion
    if (this.serverWaitQueues.has(key)) {
      this.logger.debug({ serverId, userId }, 'Server is starting, waiting for completion');
      return await this.serverWaitQueues.get(key)!;
    }

    // Case 3: Server is sleeping, offline, or doesn't exist - need to start
    if (context.status === ServerStatus.Sleeping || context.status === ServerStatus.Offline) {
      // Create start promise and add to queue (prevent concurrent starts)
      const startPromise = this.wakeupServer(context, userId);
      this.serverWaitQueues.set(key, startPromise);

      try {
        await startPromise;
        context.lastActive = Date.now();
        return context;
      } finally {
        // Clean up queue after start completes
        this.serverWaitQueues.delete(key);
      }
    }

    // Case 4: Server is connecting (not in queue, regular startup flow)
    if (context?.status === ServerStatus.Connecting) {
      this.logger.debug({ serverId, userId }, 'Server is connecting, waiting');
      // Wait for connection to complete
      return await this.waitForServerReady(serverId, userId);
    }

    // Case 5: Server is in error state
    throw new  McpError(ErrorCode.InvalidParams, `Server ${serverId} is in error state: ${context?.lastError || 'Unknown error'}`);
  }

  /**
   * Wake up sleeping server
   */
  private async wakeupServer(
    context: ServerContext,
    userId?: string
  ): Promise<ServerContext> {
    const serverId = context.serverEntity.serverId;
    this.logger.info({ serverName: context.serverEntity.serverName, serverId, userId }, 'Waking up server from sleep');

    // Check if lazy start is applicable
    if (!this.isLazyStartApplicable(context.serverEntity)) {
      throw new McpError(ErrorCode.InvalidParams, `Server ${context.serverEntity.serverName} does not support lazy start`);
    }

    // Get token
    let token: string;
    if (context.serverEntity.allowUserInput) {
      if (!userId) {
        throw new McpError(ErrorCode.InvalidParams, 'User ID is required for temporary servers');
      }
      const session = SessionStore.instance?.getUserFirstSession(userId);
      if (!session) {
        throw new McpError(ErrorCode.InvalidParams, `User ${userId} has no active session`);
      }
      token = session.token;
    } else {
      token = this.getOwnerToken();
    }

    // Start server with error handling
    try {
      await this.createServerConnection(context, token);

      this.logger.info({
        serverId,
        userId,
        from: 'Sleeping',
        to: 'Online'
      }, 'Server woken up successfully');
      return context;
    } catch (error) {
      this.logger.error({ error, serverId, userId }, 'Failed to wake up server');

      if (error instanceof McpError) {
        throw error;
      }

      // Throw error to let caller handle
      throw new McpError(ErrorCode.InternalError, String(error));
    }
  }

  /**
   * Wait for server to be ready
   */
  private async waitForServerReady(
    serverId: string,
    userId?: string,
    timeoutMs: number = 50000  // 50 second timeout
  ): Promise<ServerContext> {
    const startTime = Date.now();
    const checkInterval = 100;  // Check every 100ms

    while (Date.now() - startTime < timeoutMs) {
      const context = this.getServerContext(serverId, userId);

      if (context?.status === ServerStatus.Online) {
        return context;
      }

      if (context?.status === ServerStatus.Error) {
        throw new Error(`Server ${serverId} failed to start: ${context.lastError}`);
      }

      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error(`Server ${serverId} startup timeout after ${timeoutMs}ms`);
  }

  /**
   * Check if server is applicable for lazy start
   */
  private isLazyStartApplicable(server: Server): boolean {
    // Global switch check
    const globalEnabled = process.env.LAZY_START_ENABLED !== 'false';  // Default enabled
    if (!globalEnabled) {
      return false;
    }

    // Server-specific disable
    if (!server.lazyStartEnabled) {
      return false;
    }

    // // Only applicable for stdio type
    // return server.transportType === 'stdio';
    return true;
  }

  private injectOAuthTokenEnv(
    authType: ServerAuthType,
    launchConfig: Record<string, any>,
    accessToken: string
  ): void {
    switch (authType) {
      case ServerAuthType.GoogleAuth:
      case ServerAuthType.GoogleCalendarAuth:
      case ServerAuthType.FigmaAuth:
      case ServerAuthType.GithubAuth:
      case ServerAuthType.CanvaAuth:
        launchConfig.env = {
          ...launchConfig.env,
          accessToken: accessToken,
        };
        break;

      case ServerAuthType.ZendeskAuth:
        let zendeskSubdomain = launchConfig.env?.zendeskSubdomain;
        if (!zendeskSubdomain) {
          throw new Error('[ServerManager] Missing zendeskSubdomain for server auth type ZendeskAuth');
        }

        zendeskSubdomain = zendeskSubdomain.replace('https://', '').replace('.zendesk.com', '');
        launchConfig.env = {
          ...launchConfig.env,
          "zendeskSubdomain": zendeskSubdomain,
          accessToken: accessToken,
        };
        break;

      case ServerAuthType.NotionAuth:
        launchConfig.env = {
          ...launchConfig.env,
          notionToken: accessToken,
        };
        break;

      default:
        break;
    }
  }

  /**
   * Start idle check timer
   */
  private startIdleCheck(): void {
    this.idleCheckTimer = setInterval(() => {
      this.checkIdleServers();
    }, this.IDLE_CHECK_INTERVAL);

    this.logger.info('Idle check timer started');
  }

  /**
   * Check and sleep idle servers
   */
  private async checkIdleServers(): Promise<void> {
    const now = Date.now();
    const serversToSleep: ServerContext[] = [];

    // Check normal servers
    for (const context of this.serverContexts.values()) {
      if (this.shouldSleep(context, now)) {
        serversToSleep.push(context);
      }
    }

    // Check temporary servers
    for (const context of this.temporaryServers.values()) {
      if (this.shouldSleep(context, now)) {
        serversToSleep.push(context);
      }
    }

    // Sleep idle servers
    for (const context of serversToSleep) {
      await this.sleepServer(context);
    }

    if (serversToSleep.length > 0) {
      this.logger.info({ count: serversToSleep.length }, 'Idle servers put to sleep');
    }
  }

  /**
   * Determine if server should sleep
   */
  private shouldSleep(context: ServerContext, now: number): boolean {
    // Only online servers can sleep
    if (context.status !== ServerStatus.Online) {
      return false;
    }

    // Check if lazy start is enabled
    if (!this.isLazyStartApplicable(context.serverEntity)) {
      return false;
    }

    if (context.serverEntity.transportType !== 'stdio') {
      return false;
    }

    // Check if exceeded idle time
    const idleTime = now - context.lastActive;
    return idleTime >= this.IDLE_TIMEOUT;
  }

  /**
   * Sleep server
   */
  private async sleepServer(context: ServerContext): Promise<void> {
    try {
      this.logger.info({
        serverName: context.serverEntity.serverName,
        userId: context.userId,
        idleTime: (Date.now() - context.lastActive) / 1000 + ' seconds',
        from: 'Online',
        to: 'Sleeping'
      }, 'Putting server to sleep');

      // Stop token refresh
      context.stopTokenRefresh();

      // Close connection
      await context.closeConnection(ServerStatus.Sleeping);

      this.logger.info({
        serverName: context.serverEntity.serverName,
        userId: context.userId,
        status: 'Sleeping'
      }, 'Server transitioned to sleeping state');
    } catch (error) {
      this.logger.error({ error, serverName: context.serverEntity.serverName }, 'Failed to put server to sleep');
    }
  }

  /**
   * Stop idle check (called on shutdown)
   */
  private stopIdleCheck(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = undefined;
      this.logger.info('Idle check timer stopped');
    }
  }

  /**
   * Get server context
   */
  getServerContext(serverID: string, userId?: string): ServerContext | undefined {
    const serverContext = this.serverContexts.get(serverID);
    if (serverContext) {
      return serverContext;
    }
    if (userId) {
      return this.getTemporaryServer(serverID, userId);
    }
    return undefined;
  }

  getServerContextByID(id: string): ServerContext | undefined {
    return Array.from(this.serverContexts.values()).find((context) => context.id === id);
  }
  
  /**
   * Get all servers
   */
  async getAllServers(): Promise<Server[]> {
    return await ServerRepository.findAll();
  }

  async getAllEnabledServers(): Promise<Server[]> {
    return await ServerRepository.findEnabled();
  }


  /**
   * Get all available server IDs
   */
  getAvailableServers(): ServerContext[] {
    const availableServers = Array.from(this.serverContexts.values()).filter((context) => context.status === ServerStatus.Online || context.status === ServerStatus.Sleeping);
    const temporaryServers = Array.from(this.temporaryServers.values()).filter((context) => context.status === ServerStatus.Online || context.status === ServerStatus.Sleeping);
    return [...availableServers, ...temporaryServers];
  }

  getUserAvailableServers(user: User): ServerContext[] {
    const permissions = JSON.parse(user.permissions) as Permissions;
    const availableServers = this.getAvailableServers();
    const result: ServerContext[] = [];
    for (const server of availableServers) {
      const enabled = permissions[server.serverEntity.serverId]?.enabled ?? server.serverEntity.publicAccess;
      if (!enabled) {
        continue;
      }
      if (server.serverEntity.allowUserInput && server.userId !== user.userId) {
        continue;
      }
      result.push(server);
    }
    return result;
  }

  getAvailableServersCapabilities(): McpServerCapabilities {
    const capabilities: McpServerCapabilities = {};
    for (const context of this.getAvailableServers()) {
      const mcpCaps = context.getMcpCapabilities();
      if (context.serverEntity.allowUserInput) {
        mcpCaps.tools = {};
        mcpCaps.resources = {};
        mcpCaps.prompts = {};
        mcpCaps.configured = true;
      }
      capabilities[context.serverID] = mcpCaps;
    }
    return capabilities;
  }
  
  /**
   * Add new server connection
   */
  async addServer(serverEntity: Server, token: string): Promise<ServerContext> {
    let context: ServerContext | undefined;
    if (this.serverContexts.has(serverEntity.serverId)) {
      this.logger.debug({ serverName: serverEntity.serverName }, 'Server already exists');

      const serverContext = this.serverContexts.get(serverEntity.serverId)!;

      if (serverContext.serverEntity.launchConfig !== serverEntity.launchConfig) {
        await this.removeServer(serverEntity.serverId);
      } else if (serverContext.status === ServerStatus.Online) {
        return serverContext;
      } else if (serverContext.status === ServerStatus.Connecting) {
        return serverContext;
      } else if (serverContext.status === ServerStatus.Sleeping) {
        context = serverContext;
      } else {
        await this.removeServer(serverEntity.serverId);
      }
    }
    if (!context) {
      const serverContext = new ServerContext(serverEntity);
      this.serverContexts.set(serverEntity.serverId, serverContext);
  
      // Create ServerLogger for this server
      const serverLogger = new ServerLogger(serverEntity.serverId);
      this.serverLoggers.set(serverEntity.serverId, serverLogger);
      context = serverContext;
    }

    await this.createServerConnection(context, token);
    return context;
  }

  addSleepingServer(server: Server): ServerContext | undefined {
    if (server.allowUserInput) {
      return undefined;
    }

    if (!this.isLazyStartApplicable(server)) {
      return undefined;
    }

    if (this.serverContexts.has(server.serverId)) {
      return this.serverContexts.get(server.serverId)!;
    }

    const context = new ServerContext(server);
    this.serverContexts.set(server.serverId, context);

    // Create ServerLogger for this server
    const serverLogger = new ServerLogger(server.serverId);
    this.serverLoggers.set(server.serverId, serverLogger);

    // Initialize in Sleeping state, don't start
    context.status = ServerStatus.Sleeping;
    return context;
  }
  
  /**
   * Remove server connection
   */
  async removeServer(serverID: string): Promise<ServerContext | undefined> {
    const serverContext = this.serverContexts.get(serverID);
    if (serverContext) {
      // Log ServerClose event (1311) before cleanup
      const serverLogger = this.serverLoggers.get(serverID);
      if (serverLogger) {
        await serverLogger.logServerLifecycle({
          action: MCPEventLogType.ServerClose,
        });
      }

      // Stop token refresh timer
      serverContext.stopTokenRefresh();

      try {
        await serverContext.closeConnection(ServerStatus.Offline);
      } catch (error) {
        this.logger.error({ error, serverID }, 'Error closing server connection');
      }

      this.serverContexts.delete(serverID);
      this.serverLoggers.delete(serverID); // Clean up ServerLogger
      this.logger.info({ serverID }, 'Server context removed');
      return serverContext;
    } else {
      return undefined;
    }
  }
  
  /**
   * Disconnect and reconnect server (for API key change)
   */
  async reconnectServer(serverEntity: Server, token: string): Promise<ServerContext> {
    // First disconnect existing connection
    const context = await this.removeServer(serverEntity.serverId);
    context?.clearError();
    context?.clearTimeout();

    // Recreate connection with new API key
    let serverContext: ServerContext;
    if (context) {
      serverContext = context;
      serverContext.serverEntity = serverEntity;
    } else {
      serverContext = new ServerContext(serverEntity);
    }
    this.serverContexts.set(serverEntity.serverId, serverContext);

    if (!this.serverLoggers.has(serverEntity.serverId)) {
      const serverLogger = new ServerLogger(serverEntity.serverId);
      this.serverLoggers.set(serverEntity.serverId, serverLogger);
    }

    await this.createServerConnection(serverContext, token);

    this.logger.info({ serverName: serverEntity.serverName }, 'Server reconnected with new API key');
    return serverContext;
  }

  async reconnectTemporaryServer(serverEntity: Server, userId: string, token: string): Promise<ServerContext> {
    const serverId = serverEntity.serverId;
    const internalKey = `${serverId}:${userId}`;

    let context = await this.closeTemporaryServer(serverEntity.serverId, userId);
    context?.clearError();
    context?.clearTimeout();

    let serverContext: ServerContext;
    if (context) {
      serverContext = context;
      serverContext.serverEntity = serverEntity;
    } else {
      serverContext = new ServerContext(serverEntity);
      serverContext.userId = userId;
      serverContext.userToken = token;
    }
    this.temporaryServers.set(internalKey, serverContext);

    if (!this.temporaryServerLoggers.has(internalKey)) {
      const serverLogger = new ServerLogger(internalKey);
      this.temporaryServerLoggers.set(internalKey, serverLogger);
    }

    await this.createServerConnection(serverContext, token);
    return serverContext;
  }
  
  /**
   * Update server configuration
   */
  async updateServerCapabilitiesConfig(serverId: string, capabilities: string): Promise<{ toolsChanged: boolean, resourcesChanged: boolean, promptsChanged: boolean }> {
    const currentContext = this.serverContexts.get(serverId);
    
    if (!currentContext) {
      return { toolsChanged: false, resourcesChanged: false, promptsChanged: false };
    }

    // Get current server configuration for comparison
    const currentServerEntity = currentContext.serverEntity;
    if (currentServerEntity.capabilities === capabilities) {
      return { toolsChanged: false, resourcesChanged: false, promptsChanged: false };
    }

    try {
      const newCapabilitiesConfig = JSON.parse(capabilities) as ServerConfigCapabilities;
      if (!newCapabilitiesConfig.tools) {
        newCapabilitiesConfig.tools = {};
      }
      if (!newCapabilitiesConfig.resources) {
        newCapabilitiesConfig.resources = {};
      }
      if (!newCapabilitiesConfig.prompts) {
        newCapabilitiesConfig.prompts = {};
      }
      const oldCapabilitiesConfig = currentContext.capabilitiesConfig;
      if (!oldCapabilitiesConfig.tools) {
        oldCapabilitiesConfig.tools = {};
      }
      if (!oldCapabilitiesConfig.resources) {
        oldCapabilitiesConfig.resources = {};
      }
      if (!oldCapabilitiesConfig.prompts) {
        oldCapabilitiesConfig.prompts = {};
      }

      const { toolsChanged, resourcesChanged, promptsChanged } = currentContext.isCapabilityChanged(newCapabilitiesConfig);
      currentContext.lastSync = new Date();
      currentContext.updateCapabilitiesConfig(capabilities);
      return { toolsChanged, resourcesChanged, promptsChanged };
    } catch (error) {
      this.logger.error({ error, serverId }, 'Failed to update server configuration');
      return { toolsChanged: true, resourcesChanged: true, promptsChanged: true };
    }
  }
  
  /**
   * Create server connection
   */
  private async createServerConnection(
    serverContext: ServerContext, 
    token: string
  ): Promise<void> {
    
    if (serverContext.status === ServerStatus.Online) {
      return;
    } else if (serverContext.status === ServerStatus.Connecting) {
      return;
    }

    const serverEntity: Server = serverContext.serverEntity;

    try {
      serverContext.status = ServerStatus.Connecting;
      serverContext.userToken = token;
      
      // 1. Parse launch_config
      const baseLaunchConfig = await this.decryptLaunchConfig(token, serverEntity);

      const launchConfig: Record<string, any> = JSON.parse(baseLaunchConfig);

      // 2. Initialize authentication (handle OAuth token)
      await this.initializeAuthentication(serverContext, launchConfig, token);

      const category = serverContext.serverEntity.category;
      switch (category) {
        case ServerCategory.RestApi:
          if (!serverEntity.configTemplate || serverEntity.configTemplate.trim() === '' || serverEntity.configTemplate.trim() === '{}') {
            throw new Error(`[ServerManager] Missing configTemplate for server ${serverEntity.serverId}`);
          }
          const config = JSON.parse(serverEntity.configTemplate);
          config.apis[0].auth = launchConfig.auth;
          delete launchConfig.auth;
          launchConfig.env ??= {
            type: "none"
          };
          launchConfig.env.GATEWAY_CONFIG = JSON.stringify(config);
          break;
        case ServerCategory.Skills:
          // Rewrite ./skills/<serverId> volume paths to host-absolute paths when running inside Docker
          await this.resolveSkillsVolumeMounts(launchConfig);
          break;
        default:
          break;
      }

      // 4. Create transport using dynamic transport factory
      const { transport, transportType } = await DownstreamTransportFactory.create(launchConfig);

      // 1.5 Detect and cache transport type if not already set
      if (!serverEntity.transportType || serverEntity.transportType !== transportType) {

        await ServerRepository.update(serverEntity.serverId, { transportType });
        serverEntity.transportType = transportType;

        this.logger.info({ serverId: serverEntity.serverId, transportType }, 'Transport type detected and cached');
      }

      transport.onclose = () => {
        this.logger.warn({ serverName: serverEntity.serverName }, 'Transport closed');

        if (serverContext.status === ServerStatus.Sleeping) {
          return;
        }

        const affectedSessions = SessionStore.instance?.getSessionsUsingServer(serverEntity.serverId) ?? [];
        
        serverContext.status = ServerStatus.Error;
        serverContext.recordError(`Transport closed by server`);

        if (serverEntity.allowUserInput) {
          void this.closeTemporaryServer(serverEntity.serverId, serverContext.userId!).catch((error) => {
            this.logger.error({ error, serverName: serverEntity.serverName, userId: serverContext.userId }, 'Error closing temporary server after transport close');
          });
        } else {
          void this.removeServer(serverEntity.serverId).catch((error) => {
            this.logger.error({ error, serverName: serverEntity.serverName }, 'Error removing server after transport close');
          });
        }

        this.notifyUsersOfServerChange(serverEntity.serverId, affectedSessions, 'server_error', {
          toolsChanged: (serverContext.tools?.tools?.length ?? 0) > 0,
          resourcesChanged: (serverContext.resources?.resources?.length ?? 0) > 0,
          promptsChanged: (serverContext.prompts?.prompts?.length ?? 0) > 0
        });
      };
      
      // 5. Create MCP client
      const client = new Client(
        {
          name: APP_INFO.name,
          version: APP_INFO.version
        },
        this.clientOptions
      );
      
      // 6. Establish connection
      await client.connect(transport);
      this.logger.info({ serverName: serverEntity.serverName }, 'Connection established');
      if (serverEntity.category === ServerCategory.CustomRemote || serverEntity.category === ServerCategory.CustomStdio) {
        const serverInfo = client.getServerVersion();
        if (serverInfo?.name && serverInfo.name !== serverEntity.serverName) {
          let name = serverInfo.name.trim();
          if (serverEntity.allowUserInput) {
            name += ' Personal';
          }

          await ServerRepository.update(serverEntity.serverId, {
            serverName: name
          });
          serverEntity.serverName = name;
        }
      }

      // 7. Register global reverse request handlers
      this.registerReverseRequestHandlers(client, serverEntity.serverId);

      await client.ping({ timeout: 5000 });

      serverContext.status = ServerStatus.Online;
      
      // 7. Save connection to context
      serverContext.connection = client;
      serverContext.transport = transport;

      // 8. Get server capabilities
      await this.updateServerCapabilities(serverContext);
      this.logger.info({ serverName: serverEntity.serverName }, 'Server connection established');

      // 9. Log ServerInit event (1310)
      const serverLogger = this.serverLoggers.get(serverEntity.serverId);
      if (serverLogger) {
        await serverLogger.logServerLifecycle({
          action: MCPEventLogType.ServerInit,
        });
      }
    } catch (error) {
      this.logger.warn({ error, serverName: serverEntity.serverName }, 'Failed to get capabilities');
      serverContext.status = ServerStatus.Error;
      serverContext.recordError(String(error));

      throw error;
    }
  }

  async updateServerCapabilities(serverContext: ServerContext): Promise<void> {
    
    if (!serverContext.connection) {
      return;
    }

    const client = serverContext.connection;

    try {

      const capabilities = client.getServerCapabilities();

      if (capabilities) {
        serverContext.updateCapabilities(capabilities);

        const serverCapabilities = serverContext.capabilitiesConfig;
        const toolsEmpty = Object.keys(serverCapabilities.tools ?? {}).length === 0;
        const resourcesEmpty = Object.keys(serverCapabilities.resources ?? {}).length === 0;
        const promptsEmpty = Object.keys(serverCapabilities.prompts ?? {}).length === 0;

        if (capabilities.tools?.listChanged === true) {
          client.setNotificationHandler(
            ToolListChangedNotificationSchema,
            async (notification: ToolListChangedNotification) => {
              try {
                const tools = await client.listTools();
                await serverContext.updateTools(tools);
                this.globalRouter?.handleToolsListChanged(serverContext.serverEntity.serverId);
  
                // Log ServerCapabilityUpdate (1313)
                const serverLogger = this.serverLoggers.get(serverContext.serverEntity.serverId);
                if (serverLogger) {
                  await serverLogger.logServerCapabilityUpdate({
                    requestParams: { type: 'tools/listChanged', toolsCount: tools.tools?.length || 0 }
                  });
                }
              } catch (error) {
                serverContext.recordTimeout(error);
                this.logger.warn({ error, serverName: serverContext.serverEntity.serverName }, 'Failed to get tools');
              }
            }
          );
        }

        if (capabilities.resources?.listChanged === true) {
          client.setNotificationHandler(
            ResourceListChangedNotificationSchema,
            async (notification: ResourceListChangedNotification) => {
              try {
                const resources = await client.listResources();
                await serverContext.updateResources(resources);
                const resourceTemplates = await client.listResourceTemplates();
                await serverContext.updateResourceTemplates(resourceTemplates);
                this.globalRouter?.handleResourcesListChanged(serverContext.serverEntity.serverId);
  
                // Log ServerCapabilityUpdate (1313)
                const serverLogger = this.serverLoggers.get(serverContext.serverEntity.serverId);
                if (serverLogger) {
                  await serverLogger.logServerCapabilityUpdate({
                    requestParams: { type: 'resources/listChanged', resourcesCount: resources.resources?.length || 0 }
                  });
                }
              } catch (error) {
                serverContext.recordTimeout(error);
                this.logger.warn({ error, serverName: serverContext.serverEntity.serverName }, 'Failed to get resources');
              }
            }
          );
        }

        if (capabilities.resources?.subscribe === true) {
          client.setNotificationHandler(
            ResourceUpdatedNotificationSchema,
            async (notification: ResourceUpdatedNotification) => {
              this.globalRouter?.handleResourceUpdated(serverContext.serverEntity.serverId, notification);
            }
          );
        }

        if (capabilities.prompts?.listChanged === true) {
          client.setNotificationHandler(
            PromptListChangedNotificationSchema,
            async (notification: PromptListChangedNotification) => {

              try {
                const prompts = await client.listPrompts();
                await serverContext.updatePrompts(prompts);
                this.globalRouter?.handlePromptsListChanged(serverContext.serverEntity.serverId);
  
                // Log ServerCapabilityUpdate (1313)
                const serverLogger = this.serverLoggers.get(serverContext.serverEntity.serverId);
                if (serverLogger) {
                  await serverLogger.logServerCapabilityUpdate({
                    requestParams: { type: 'prompts/listChanged', promptsCount: prompts.prompts?.length || 0 }
                  });
                }
              } catch (error) {
                serverContext.recordTimeout(error);
                this.logger.warn({ error, serverName: serverContext.serverEntity.serverName }, 'Failed to get prompts');
              }
            }
          );
        }

        try {
          const tools = await client.listTools();
          if (tools) {
            await serverContext.updateTools(tools);
          }
        } catch (error) {
          this.logger.warn({ error, serverName: serverContext.serverEntity.serverName }, 'Failed to get tools');
        }

        try {
          if (capabilities.resources) {
            const resources = await client.listResources();
            await serverContext.updateResources(resources);

            const resourceTemplates = await client.listResourceTemplates();
            await serverContext.updateResourceTemplates(resourceTemplates);
          }
        } catch (error) {
          this.logger.warn({ error, serverName: serverContext.serverEntity.serverName }, 'Failed to get resources');
        }

        try {
          if (capabilities.prompts) {
            const prompts = await client.listPrompts();
            if (prompts) {
              await serverContext.updatePrompts(prompts);
            }
          }
        } catch (error) {
          this.logger.warn({ error, serverName: serverContext.serverEntity.serverName }, 'Failed to get prompts');
        }

        if (toolsEmpty && resourcesEmpty && promptsEmpty) {
          try {
            const configTemplateValue = serverContext.serverEntity.configTemplate!;
            const template = JSON.parse(configTemplateValue);
            const config = template?.toolDefaultConfig;
            if (config !== undefined) {
              const defaultConfig = typeof config === 'string' ? JSON.parse(config) : config;
              serverContext.updateCapabilitiesConfig(JSON.stringify({tools: defaultConfig, resources: {}, prompts: {}}));
            }
          } catch (error) {
            this.logger.error({ error }, 'Invalid configTemplate JSON');
          }

          const newCapabilities = serverContext.getMcpCapabilities();

          if (serverContext.serverEntity.allowUserInput) {
            if (serverContext.userId) {
              const user = await UserRepository.findById(serverContext.userId);
              if (user) {
                const userPreferences = JSON.parse(user.userPreferences || '{}');
                userPreferences[serverContext.serverID] = newCapabilities;
                await UserRepository.updateUserPreferences(serverContext.userId, userPreferences);
              }
            }
          }
          
          await ServerRepository.updateCapabilities(serverContext.serverID, JSON.stringify({tools: newCapabilities.tools, resources: newCapabilities.resources, prompts: newCapabilities.prompts}));
        }
      }
    } catch (error) {
      this.logger.warn({ error, serverName: serverContext.serverEntity.serverName }, 'Failed to get capabilities');
    }
  }

  /**
   * Initialize authentication (handle different authentication methods based on authType)
   */
  private async initializeAuthentication(
    serverContext: ServerContext,
    launchConfig: Record<string, any>,
    token: string
  ): Promise<void> {
    const category = serverContext.serverEntity.category;
    if (category !== ServerCategory.Template) {
      return;
    }

    const authType = serverContext.serverEntity.authType;
    const usePetaOauthConfig = serverContext.serverEntity.usePetaOauthConfig;

    // For testing the temporary block
    if (usePetaOauthConfig && serverContext.serverEntity.authType !== ServerAuthType.ApiKey) {
      const initialToken = await this.initializePetaAuth(serverContext, launchConfig, token);
      this.injectOAuthTokenEnv(authType, launchConfig, initialToken);
      delete launchConfig.oauth;

      this.logger.info({
        serverName: serverContext.serverEntity.serverName,
        usePetaOauthConfig
      }, 'OAuth initialized with Peta config');
      return;
    }

    switch (authType) {
      case ServerAuthType.GoogleAuth:
      case ServerAuthType.GoogleCalendarAuth:
      case ServerAuthType.NotionAuth:
      case ServerAuthType.FigmaAuth:
      case ServerAuthType.GithubAuth:
      case ServerAuthType.CanvaAuth:
      case ServerAuthType.ZendeskAuth:
        serverContext.userToken = token;
        await this.initializeOAuthWithRefresh(serverContext, launchConfig);
        break;

      case ServerAuthType.ApiKey:
        // API Key doesn't need special handling, just pass through
        break;

      default:
        this.logger.warn(
          { authType: serverContext.serverEntity.authType, serverName: serverContext.serverEntity.serverName },
          'Unknown auth type'
        );
    }
  }

  /**
   * Initialize OAuth authentication that uses refresh tokens
   */
  private async initializeOAuthWithRefresh(
    serverContext: ServerContext,
    launchConfig: Record<string, any>
  ): Promise<void> {
    const authType = serverContext.serverEntity.authType;

    // 1. Verify OAuth configuration exists
    if (
      !launchConfig.oauth?.clientId ||
      !launchConfig.oauth?.clientSecret ||
      !launchConfig.oauth?.refreshToken
    ) {
      throw new Error(
        `[ServerManager] Missing OAuth configuration for server ${serverContext.serverID}. Required: clientId, clientSecret, refreshToken`
      );
    }

    if (
      [ServerAuthType.ZendeskAuth].includes(authType) &&
      (!launchConfig.oauth.tokenUrl || typeof launchConfig.oauth.tokenUrl !== 'string')
    ) {
      throw new Error(
        `[ServerManager] Missing OAuth tokenUrl for server ${serverContext.serverID} (ZendeskAuth)`
      );
    }

    // 2. Create authentication strategy
    const authStrategy = AuthStrategyFactory.create(
      serverContext.serverEntity.authType,
      launchConfig.oauth
    );

    if (!authStrategy) {
      throw new Error(
        `[ServerManager] Failed to create auth strategy for server ${serverContext.serverID}`
      );
    }

    // 3. Start token refresh and get initial token
    const initialToken = await serverContext.startTokenRefresh(authStrategy);

    // 4. Inject access token into environment variables (don't pass OAuth config)
    this.injectOAuthTokenEnv(serverContext.serverEntity.authType, launchConfig, initialToken);

    // 5. Remove oauth config (don't pass to downstream server)
    delete launchConfig.oauth;

    this.logger.info({
      serverName: serverContext.serverEntity.serverName,
      authType: serverContext.serverEntity.authType
    }, 'OAuth initialized');
  }

  private async initializePetaAuth(
    serverContext: ServerContext,
    launchConfig: Record<string, any>,
    token: string
  ): Promise<string> {
    if (!launchConfig.oauth?.clientId) {
      throw new Error(
        `[ServerManager] Missing OAuth configuration for server ${serverContext.serverID}. Required: clientId`
      );
    }

    const authStrategy = new PetaAuthStrategy({
      userToken: token,
      server: serverContext.serverEntity,
      clientId: launchConfig.oauth.clientId,
      key: launchConfig.oauth.key,
      accessToken: launchConfig.oauth.accessToken,
      expiresAt: launchConfig.oauth.expiresAt
    });

    return await serverContext.startTokenRefresh(authStrategy);
  }

  /**
   * Update OAuth configuration for regular server
   *
   * Used to update OAuth configuration stored in server.launchConfig
   * Supports complete OAuth configuration updates (accessToken, refreshToken, expiresAt, etc.)
   * Only for regular Server, temporary Server uses updateUserLaunchConfig()
   *
   * @param serverContext Regular server context (must have userToken)
   * @param oauthConfig OAuth configuration object (can include accessToken, refreshToken, expiresAt, etc.)
   */
  async updateServerLaunchConfig(
    serverContext: ServerContext,
    oauthConfig: any
  ): Promise<void> {
    try {
      const serverId = serverContext.serverID;
      const serverEntity = serverContext.serverEntity;
      const userToken = serverContext.userToken;

      // 1. Check if userToken exists
      if (!userToken) {
        this.logger.warn(
          { serverId, serverName: serverEntity.serverName },
          'No userToken available for OAuth config update'
        );
        return;
      }

      // 2. Decrypt launchConfig
      const decryptedLaunchConfig = await CryptoService.decryptDataFromString(
        serverEntity.launchConfig,
        userToken
      );
      const launchConfig = JSON.parse(decryptedLaunchConfig);

      // 3. Check if oauth config exists
      if (!launchConfig.oauth) {
        launchConfig.oauth = {};
      }

      // 4. Update complete oauth config
      // Use spread operator to merge update (compatible with different types of OAuth config)
      launchConfig.oauth = {
        ...launchConfig.oauth,
        ...oauthConfig,
      };

      this.logger.debug({
        serverId,
        serverName: serverEntity.serverName,
        hasAccessToken: !!oauthConfig.accessToken,
        hasRefreshToken: !!oauthConfig.refreshToken,
        hasExpiresAt: !!oauthConfig.expiresAt,
        expiresAt: oauthConfig.expiresAt
          ? new Date(oauthConfig.expiresAt).toISOString()
          : 'N/A'
      }, 'Updating OAuth config in server launchConfig');

      // 5. Re-encrypt launchConfig
      const updatedLaunchConfigStr = JSON.stringify(launchConfig);
      const encryptedLaunchConfigData = await CryptoService.encryptData(
        updatedLaunchConfigStr,
        userToken
      );

      // 6. Serialize encrypted data to string
      const encryptedLaunchConfig = JSON.stringify(encryptedLaunchConfigData);

      // 7. Save to database
      const updatedServer = await ServerRepository.updateLaunchConfig(
        serverId,
        encryptedLaunchConfig
      );

      // 8. Update serverEntity in memory
      serverContext.serverEntity = updatedServer;

      this.logger.info({
        serverId,
        serverName: serverEntity.serverName,
        updatedFields: Object.keys(oauthConfig).join(', ')
      }, 'Server OAuth config updated successfully');
    } catch (error) {
      this.logger.error(
        { error, serverId: serverContext.serverID },
        'Failed to update server OAuth config'
      );
      // Don't throw error to avoid interrupting token refresh flow
    }
  }

  /**
   * Update user's launchConfig (for temporary Server OAuth configuration updates)
   *
   * This method is used to update individual user's Server configuration, including accessToken, refreshToken, expiresAt
   * Temporary Server configuration is stored in user.launchConfigs, requiring complete flow of decrypt, update, encrypt, save
   *
   * @param serverContext Temporary Server context (must have userId and userToken)
   * @param oauthConfig New OAuth configuration (includes accessToken, refreshToken, expiresAt)
   */
  async updateUserLaunchConfig(
    serverContext: ServerContext,
    oauthConfig: any
  ): Promise<void> {
    try {
      const userId = serverContext.userId;
      const serverId = serverContext.serverID;
      const userToken = serverContext.userToken;

      // 1. Validate parameters
      if (!userId || !userToken) {
        this.logger.warn(
          { serverId, userId },
          'Missing userId or userToken for user launch config update'
        );
        return;
      }

      // 2. Read user from database
      const user = await UserRepository.findById(userId);
      if (!user) {
        this.logger.warn({ userId }, 'User not found for launch config update');
        return;
      }

      // 3. Parse launchConfigs
      const launchConfigs = JSON.parse(user.launchConfigs || '{}');

      // 4. Decrypt this server's launchConfig
      const encryptedConfig = launchConfigs[serverId];
      if (!encryptedConfig) {
        this.logger.warn(
          { serverId, userId },
          'Server config not found in user launchConfigs'
        );
        return;
      }

      const decryptedStr = await CryptoService.decryptDataFromString(
        JSON.stringify(encryptedConfig),
        userToken
      );
      const launchConfig = JSON.parse(decryptedStr);

      // 5. Update oauth configuration
      if (!launchConfig.oauth) {
        launchConfig.oauth = {};
      }

      launchConfig.oauth = {
        ...launchConfig.oauth,
        ...oauthConfig,
      };

      this.logger.debug(
        {
          serverId,
          userId,
          hasAccessToken: !!oauthConfig.accessToken,
          expiresAt: oauthConfig.expiresAt
            ? new Date(oauthConfig.expiresAt).toISOString()
            : 'N/A',
        },
        'Updating OAuth config in launchConfig'
      );

      // 6. Re-encrypt
      const encryptedData = await CryptoService.encryptData(
        JSON.stringify(launchConfig),
        userToken
      );

      // 7. Update launchConfigs
      launchConfigs[serverId] = encryptedData;

      // 8. Save to database
      await UserRepository.updateLaunchConfigs(userId, launchConfigs);

      // 9. Synchronously update all sessions for this user (refer to src/user/UserRequestHandler.ts :262-266)
      const launchConfigsStr = JSON.stringify(launchConfigs);
      if (SessionStore.instance) {
        const userSessions = SessionStore.instance.getUserSessions(userId);
        for (const session of userSessions) {
          session.launchConfigs = launchConfigsStr;
        }

        this.logger.debug(
          { serverId, userId, sessionCount: userSessions.length },
          'Synced launchConfigs to user sessions'
        );
      }

      this.logger.info(
        { serverId, userId },
        'User launch config updated with new OAuth tokens'
      );
    } catch (error) {
      this.logger.error(
        {
          error,
          serverId: serverContext.serverID,
          userId: serverContext.userId,
        },
        'Failed to update user launch config'
      );
      // Don't throw error to avoid interrupting token refresh flow
    }
  }

  async decryptLaunchConfig(token: string, serverEntity: Server) : Promise<string> {
    const serverName = serverEntity.serverName;
    try {
      // Decrypt launch config
      const launchConfig = await CryptoService.decryptDataFromString(
        serverEntity.launchConfig, // encrypted launch config
        token // rawBase64 key
      );

      return launchConfig;
    } catch (error) {
      throw new AuthError(
        AuthErrorType.INVALID_TOKEN,
        `Failed to decrypt launch config for server ${serverName}`,
        'owner',
        error
      );
    }
  }

  async connectAllServers(token: string) : Promise<{ successServers: { serverId: string; serverName: string; proxyId: number }[]; failedServers: { serverId: string; serverName: string; proxyId: number }[] }> {

    // Create connections for all serverContexts concurrently
    const connectPromises: Promise<Server>[] = [];

    const enabledServers = await this.getAllEnabledServers();
    const contexts: ServerContext[] = [];
    for (const server of enabledServers) {
      if (server.allowUserInput) {
        continue;
      }
      try {
        const context = this.serverContexts.get(server.serverId);
        if (context?.status === ServerStatus.Online || context?.status === ServerStatus.Connecting || context?.status === ServerStatus.Sleeping) {
          continue;
        }
        this.serverContexts.delete(server.serverId);
        const serverContext = new ServerContext(server);
        this.serverContexts.set(server.serverId, serverContext);

        if (!this.serverLoggers.has(server.serverId)) {
          const serverLogger = new ServerLogger(server.serverId);
          this.serverLoggers.set(server.serverId, serverLogger);
        }

        // Check if lazy start is applicable
        if (this.isLazyStartApplicable(server)) {
          // Initialize in Sleeping state, don't start
          serverContext.status = ServerStatus.Sleeping;
          this.logger.info({ serverId: server.serverId, serverName: server.serverName }, 'Server initialized in sleeping state (lazy start enabled)');
          continue;
        }

        // Not applicable for lazy start, will start normally
        contexts.push(serverContext);
        this.logger.info({ serverName: server.serverName }, 'Server context initialized');
      } catch (error) {
        this.logger.error({ error, serverName: server.serverName }, 'Failed to initialize server');
      }
    }

    for (const serverContext of contexts) {
      connectPromises.push(this.createServerConnection(serverContext, token).then(() => serverContext.serverEntity).catch((error) => serverContext.serverEntity));
    }
    const results = await Promise.allSettled(connectPromises);
    // Return list of successful and failed servers
    const successServers = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    const failedServers = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    return {
      successServers: successServers.map((server) => ({
        serverId: server.serverId,
        serverName: server.serverName,
        proxyId: server.proxyId
      })),
      failedServers: failedServers.map((server) => ({
        serverId: server.serverId,
        serverName: server.serverName,
        proxyId: server.proxyId
      }))
    };
  }
  
  /**
   * Register reverse request handlers
   * Handle requests initiated by Server (Sampling, Roots, Elicitation)
   */
  private registerReverseRequestHandlers(client: Client, serverId: string): void {
    if (!this.globalRouter) {
      this.logger.warn('GlobalRequestRouter not initialized, skipping reverse request handler registration');
      return;
    }

    const router = this.globalRouter;

    if (this.clientOptions.capabilities?.sampling) {
      // Register Sampling request handler
      client.setRequestHandler(
        CreateMessageRequestSchema,
        async (request, extra) => {
          this.logger.debug({
            serverId,
            requestId: extra?.requestId,
            sessionId: extra?.sessionId,
            requestInfo: extra?.requestInfo,
            hasAuthInfo: !!extra?.authInfo,
            hasSendRequest: typeof extra?.sendRequest === 'function',
            hasSendNotification: typeof extra?.sendNotification === 'function'
          }, 'Server requested sampling');

          // Extract proxyContext from _meta
          const proxyContext = request.params._meta?.proxyContext as ProxyContext | undefined;

          if (!proxyContext || !proxyContext.proxyRequestId) {
            this.logger.error({
              serverId,
              requestId: extra?.requestId,
              params: request.params
            }, '[CRITICAL] No proxyContext in sampling request');
            throw new McpError(
              ErrorCode.InvalidRequest,
              'Missing proxyContext for sampling request routing'
            );
          }

          return router.handleSamplingRequest(serverId, request, proxyContext);
        }
      );
    }

    if (this.clientOptions.capabilities?.roots) {
      // Register Roots list request handler
      client.setRequestHandler(
        ListRootsRequestSchema,
        async (request, extra) => {
          this.logger.debug({
            serverId,
            requestId: extra?.requestId,
            sessionId: extra?.sessionId,
            requestInfo: extra?.requestInfo
          }, 'Server requested roots list');

          // Extract proxyContext from _meta
          const proxyContext = request.params?._meta?.proxyContext as ProxyContext | undefined;

          if (!proxyContext || !proxyContext.proxyRequestId) {
            this.logger.error({
              serverId,
              requestId: extra?.requestId,
              params: request.params
            }, '[CRITICAL] No proxyContext in roots list request');
            throw new McpError(
              ErrorCode.InvalidRequest,
              'Missing proxyContext for roots list request routing'
            );
          }

          return router.handleRootsListRequest(serverId, request, proxyContext);
        }
      );
    }

    if (this.clientOptions.capabilities?.elicitation) {
      // Register Elicitation request handler
      client.setRequestHandler(
        ElicitRequestSchema,
        async (request, extra) => {
          this.logger.debug({
            serverId,
            requestId: extra?.requestId,
            sessionId: extra?.sessionId,
            requestInfo: extra?.requestInfo,
            params: request.params
          }, 'Server requested user input');
  
          // Extract proxyContext from _meta
          const proxyContext = request.params._meta?.proxyContext as ProxyContext | undefined;
  
          if (!proxyContext || !proxyContext.proxyRequestId) {
            this.logger.error({
              serverId,
              requestId: extra?.requestId,
              params: request.params
            }, '[CRITICAL] No proxyContext in elicitation request');
            throw new McpError(
              ErrorCode.InvalidRequest,
              'Missing proxyContext for elicitation request routing'
            );
          }
  
          return router.handleElicitationRequest(serverId, request, proxyContext);
        }
      );
    }

    this.logger.info({ serverId }, 'Reverse request handlers registered');
    
    // Register cancellation notification handler from server
    client.setNotificationHandler(
      CancelledNotificationSchema,
      async (notification: CancelledNotification) => {
        this.logger.debug({ serverId, requestId: notification.params.requestId }, 'Server sent cancellation');

        // Extract sessionId from proxyRequestId (format: "sessionId:originalId:timestamp")
        const proxyRequestId = String(notification.params.requestId);
        const sessionId = proxyRequestId.split(':')[0];

        if (!sessionId) {
          this.logger.error({ proxyRequestId }, 'Failed to extract sessionId from proxyRequestId');
          return;
        }

        // Get ProxySession through SessionStore
        const proxySession = SessionStore.instance!.getProxySession(sessionId);
        if (proxySession) {
          try {
            // Forward cancellation notification to client
            await proxySession.forwardCancellationToClient(notification);
          } catch (error) {
            this.logger.error({ error, serverId, sessionId }, 'Failed to forward cancellation from server');
          }
        } else {
          this.logger.warn({ sessionId }, 'No ProxySession found for sessionId');
        }
      }
    );
    
    // Register progress notification handler from server
    client.setNotificationHandler(
      ProgressNotificationSchema,
      async (notification: ProgressNotification) => {
        this.logger.debug({ serverId }, 'Server sent progress notification');

        // progressToken is actually proxyRequestId (format: "sessionId:originalId:timestamp")
        const proxyRequestId = String(notification.params.progressToken);
        const sessionId = proxyRequestId.split(':')[0];

        if (!sessionId) {
          this.logger.error({ proxyRequestId }, 'Failed to extract sessionId from progressToken');
          return;
        }

        // Get ProxySession through SessionStore
        const proxySession = SessionStore.instance!.getProxySession(sessionId);
        if (proxySession) {
          try {
            // Forward progress notification to client
            await proxySession.forwardProgressToClient(notification);
          } catch (error) {
            this.logger.error({ error, serverId, sessionId }, 'Failed to forward progress from server');
          }
        } else {
          this.logger.warn({ sessionId }, 'No ProxySession found for sessionId');
        }
      }
    );

    client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      async (notification: ResourceUpdatedNotification) => {
        this.logger.debug({ serverId }, 'Server sent resource updated notification');

        router.handleResourceUpdated(serverId, notification);
      }
    );
  }

  async notifyUsersOfServerChange(serverId: string, affectedSessions: ClientSession[], changeType: string, changed: { toolsChanged: boolean, resourcesChanged: boolean, promptsChanged: boolean }): Promise<void> {
    try {
      this.logger.info({ serverId, changeType, changed }, 'Notifying users of server change');
      
      socketNotifier.notifyUserPermissionChangedByServer(serverId);
      
      if (affectedSessions.length === 0) {
        this.logger.debug({ serverId }, 'No affected sessions for server');
        return;
      }

      if (!changed.toolsChanged && !changed.resourcesChanged && !changed.promptsChanged) {
        return;
      }

      for (const session of affectedSessions) {
        try {
          if (changed.toolsChanged) {
            session.sendToolListChanged();
          }
          if (changed.resourcesChanged) {
            session.sendResourceListChanged();
          }
          if (changed.promptsChanged) {
            session.sendPromptListChanged();
          }
        }
        catch (error) {
          this.logger.error({ error, sessionId: session.sessionId }, 'Failed to notify session');
        }
      }

      this.logger.info({ serverId, changeType, sessionCount: affectedSessions.length }, 'Notified sessions about server change');
    } catch (error) {
      this.logger.error({ error, serverId, changeType, changed }, 'Failed to notify users of server change');
    }
  }

  /**
   * Health check all servers
   */
  async healthCheck(): Promise<{ [serverID: string]: ServerStatus }> {
    const results: { [serverID: string]: ServerStatus } = {};
    const servers = await this.getAllServers();
    for (const server of servers) {
      const context = this.serverContexts.get(server.serverId);
      if (context) {
        results[server.serverId] = context.status;
        continue;
      } else {
        results[server.serverId] = ServerStatus.Offline;
      }
    }
    
    return results;
  }

  async getAllServersStatus(): Promise<{ [serverName: string]: string }> {
    const results: { [serverName: string]: string } = {};
    const servers = await this.getAllServers();
    for (const server of servers) {
      if (server.allowUserInput) {
        const contexts = Array.from(this.temporaryServers.values()).filter((context) => context.serverEntity.serverId === server.serverId);
        if (contexts.length > 0) {
          const statusCount: { [key: string]: number } = {};
          for (const context of contexts) {
            statusCount[context.status.toString()] = (statusCount[context.status.toString()] || 0) + 1;
          }
          results[server.serverName] = Object.entries(statusCount).map(([status, count]) => `${ServerStatus[Number.parseInt(status)]}(${count})`).join(", ");
        } else {  
          results[server.serverName] = ServerStatus[ServerStatus.Offline];
        }
      } else {
        const context = this.serverContexts.get(server.serverId);
        if (context) {
          results[server.serverName] = ServerStatus[context.status];
          continue;
        } else {
          results[server.serverName] = ServerStatus[ServerStatus.Offline];
        }
      }
    }
    
    return results;
  }
  
  /**
   * Aggregate resource subscription (reference counting)
   *
   * @param serverId Server ID
   * @param resourceUri Original resource URI (without prefix)
   * @param sessionId Session ID
   */
  async subscribeResource(serverId: string, resourceUri: string, sessionId: string, userId: string): Promise<void> {
    const subscriptionKey = `${serverId}::${resourceUri}`;
    this.logger.debug({ subscriptionKey, sessionId }, 'Subscribe request');

    const serverContext = this.getServerContext(serverId, userId);
    if (serverContext?.capabilities?.resources?.subscribe !== true) {
      this.logger.debug({ serverId }, 'Server does not support resource subscription');
      return;
    }

    // Get or create subscription state
    let state = this.resourceSubscriptions.get(subscriptionKey);
    if (!state) {
      state = {
        subscribedSessions: new Set(),
        downstreamSubscribed: false
      };
      this.resourceSubscriptions.set(subscriptionKey, state);
    }

    // If already subscribed, return directly
    if (state.subscribedSessions.has(sessionId)) {
      this.logger.debug({ sessionId, subscriptionKey }, 'Session already subscribed');
      return;
    }

    // Add session to subscription list
    state.subscribedSessions.add(sessionId);

    // If this is the first subscription, send subscription request to downstream
    if (!state.downstreamSubscribed) {
      if (!serverContext || !serverContext.connection) {
        throw new Error(`Server ${serverId} not available for subscription`);
      }

      try {
        // Send subscription request to downstream
        await serverContext.connection.subscribeResource(
          {
            uri: resourceUri
          }
        );

        state.downstreamSubscribed = true;
        this.logger.info({ subscriptionKey }, 'Subscribed to downstream resource');
      } catch (error) {
        // Subscription failed, remove session record
        state.subscribedSessions.delete(sessionId);
        if (state.subscribedSessions.size === 0) {
          this.resourceSubscriptions.delete(subscriptionKey);
        }
        throw error;
      }
    }

    this.logger.info({ subscriptionKey, subscriberCount: state.subscribedSessions.size }, 'Subscription successful');
  }

  /**
   * Aggregate resource unsubscription (reference counting)
   *
   * @param serverId Server ID
   * @param resourceUri Original resource URI (without prefix)
   * @param sessionId Session ID
   */
  async unsubscribeResource(serverId: string, resourceUri: string, sessionId: string, userId: string): Promise<void> {
    const subscriptionKey = `${serverId}::${resourceUri}`;
    this.logger.debug({ subscriptionKey, sessionId }, 'Unsubscribe request');

    const state = this.resourceSubscriptions.get(subscriptionKey);
    if (!state) {
      this.logger.debug({ subscriptionKey }, 'No subscription found');
      return;
    }

    // Remove session
    state.subscribedSessions.delete(sessionId);

    // If no sessions are subscribed, unsubscribe from downstream
    if (state.subscribedSessions.size === 0 && state.downstreamSubscribed) {
      const serverContext = this.getServerContext(serverId, userId);
      if (serverContext && serverContext.connection) {
        try {
          // Send unsubscription request to downstream
          await serverContext.connection.unsubscribeResource(
            {
              uri: resourceUri
            }
          );

          this.logger.info({ subscriptionKey }, 'Unsubscribed from downstream resource');
        } catch (error) {
          this.logger.error({ error, subscriptionKey }, 'Failed to unsubscribe from downstream resource');
        }
      }

      // Clean up subscription state
      this.resourceSubscriptions.delete(subscriptionKey);
    }

    this.logger.info({ subscriptionKey, remainingSubscribers: state.subscribedSessions.size }, 'Unsubscription successful');
  }

  /**
   * Get resource subscriber set
   *
   * @param subscriptionKey Subscription key `${serverId}::${resourceUri}`
   * @returns Set of subscribed session IDs
   */
  getResourceSubscribers(subscriptionKey: string): Set<string> {
    const state = this.resourceSubscriptions.get(subscriptionKey);
    return state ? state.subscribedSessions : new Set();
  }

  /**
   * Clean up all subscriptions for a session
   *
   * @param sessionId Session ID
   */
  async cleanupSessionSubscriptions(sessionId: string, userId: string): Promise<void> {
    this.logger.debug({ sessionId }, 'Cleaning up subscriptions for session');

    const unsubscribePromises: Promise<void>[] = [];

    for (const [subscriptionKey, state] of this.resourceSubscriptions.entries()) {
      if (state.subscribedSessions.has(sessionId)) {
        // Parse subscriptionKey
        const [serverId, resourceUri] = subscriptionKey.split('::', 2);
        unsubscribePromises.push(
          this.unsubscribeResource(serverId, resourceUri, sessionId, userId)
        );
      }
    }

    await Promise.all(unsubscribePromises);
    this.logger.info({ sessionId, subscriptionCount: unsubscribePromises.length }, 'Cleaned up subscriptions for session');
  }

  /**
   * Close all server connections
   */
  async shutdown(): Promise<void> {
    // Stop idle check timer
    this.stopIdleCheck();

    const closePromises = Array.from(this.serverContexts.values()).map(async (context) => {
      try {
        context.stopTokenRefresh();
        await context.closeConnection(ServerStatus.Offline);
      } catch (error) {
        this.logger.error({ error, serverName: context.serverEntity.serverName }, 'Error closing server connection');
      }
    });

    const closeTemporaryPromises = Array.from(this.temporaryServers.values()).map(async (context) => {
      try {
        context.stopTokenRefresh();
        await context.closeConnection(ServerStatus.Offline);
      } catch (error) {
        this.logger.error({ error, serverName: context.serverEntity.serverName, userId: context.userId }, 'Error closing temporary server connection');
      }
    });

    await Promise.all([...closePromises, ...closeTemporaryPromises]);
    this.serverContexts.clear();
    this.temporaryServers.clear();
    this.temporaryServerLoggers.clear();
    this.resourceSubscriptions.clear(); // Clean up subscription state
    this.serverWaitQueues.clear();
    this.logger.info('All server connections closed');
  }

  // ==================== Temporary Server Management Methods ====================

  /**
   * Create temporary server
   * @param serverId Original serverId
   * @param userId User ID
   * @param serverEntity Server entity (for creating ServerContext)
   * @param token User token (for decrypting launchConfig)
   * @returns ServerContext
   */
  async createTemporaryServer(
    userId: string,
    serverEntity: Server,
    token: string,
    sleep: boolean = false,
  ): Promise<ServerContext> {
    const serverId = serverEntity.serverId;
    const internalKey = `${serverId}:${userId}`;

    // Check if already exists
    if (this.temporaryServers.has(internalKey)) {
      const existingContext = this.temporaryServers.get(internalKey)!;
      if (existingContext.status === ServerStatus.Online) {
        return existingContext;
      }
      // If exists but not online, cleanup first
      await this.closeTemporaryServer(serverId, userId);
    }

    // Create ServerContext
    const serverContext = new ServerContext(serverEntity);
    serverContext.userId = userId;
    this.temporaryServers.set(internalKey, serverContext);

    // Create ServerLogger
    const serverLogger = new ServerLogger(internalKey);
    this.temporaryServerLoggers.set(internalKey, serverLogger);

    if (sleep && this.isLazyStartApplicable(serverEntity)) {
      serverContext.status = ServerStatus.Sleeping;
    } else {
      // Establish connection
      await this.createServerConnection(serverContext, token);
    }
    
    this.logger.info({ internalKey, status: serverContext.status }, 'Temporary server created');
    return serverContext;
  }

  /**
   * Get user's temporary server
   * @param serverId Original serverId
   * @param userId User ID
   * @returns ServerContext or undefined
   */
  getTemporaryServer(serverId: string, userId: string): ServerContext | undefined {
    const internalKey = `${serverId}:${userId}`;
    return this.temporaryServers.get(internalKey);
  }

  /**
   * Get all temporary servers for a template
   * @param serverId Template serverId
   * @returns ServerContext[]
   */
  getTemporaryServers(serverId: string): ServerContext[] {
    return Array.from(this.temporaryServers.values()).filter((context) => context.serverEntity.serverId === serverId);
  }

  /**
   * Get temporary server
   * @param id Temporary serverId
   * @param userId User ID
   * @returns ServerContext or undefined
   */
  getTemporaryServerContextByID(id: string, userId: string): ServerContext | undefined {
    return Array.from(this.temporaryServers.values()).find((context) => context.id === id && context.userId === userId);
  }

  /**
   * Get all temporary servers for user
   * @param userId User ID
   * @returns Map<serverId, ServerContext>
   */
  getUserTemporaryServers(userId: string): Map<string, ServerContext> {
    const result = new Map<string, ServerContext>();
    for (const [key, connection] of this.temporaryServers) {
      if (key.endsWith(`:${userId}`)) {
        const serverId = key.substring(0, key.lastIndexOf(':'));
        result.set(serverId, connection);
      }
    }
    return result;
  }

  /**
   * Close user's specified temporary server
   * @param serverId Original serverId
   * @param userId User ID
   */
  async closeTemporaryServer(serverId: string, userId: string): Promise<ServerContext | undefined> {
    const internalKey = `${serverId}:${userId}`;
    const serverContext = this.temporaryServers.get(internalKey);

    if (serverContext) {
      // Log ServerClose event
      const serverLogger = this.temporaryServerLoggers.get(internalKey);
      if (serverLogger) {
        await serverLogger.logServerLifecycle({
          action: MCPEventLogType.ServerClose,
        });
      }

      // Stop token refresh timer
      serverContext.stopTokenRefresh();

      try {
        await serverContext.closeConnection(ServerStatus.Offline);
      } catch (error) {
        this.logger.error({ error, internalKey }, 'Error closing temporary server connection');
      }

      this.temporaryServers.delete(internalKey);
      this.temporaryServerLoggers.delete(internalKey);
      this.logger.info({ internalKey }, 'Temporary server closed');
      return serverContext;
    }
    return undefined;
  }

  /**
   * Close all temporary servers for user
   * @param userId User ID
   */
  async closeUserTemporaryServers(userId: string): Promise<void> {
    const keysToDelete: string[] = [];

    for (const key of this.temporaryServers.keys()) {
      if (key.endsWith(`:${userId}`)) {
        keysToDelete.push(key);
      }
    }

    await Promise.all(
      keysToDelete.map(async (key) => {
        const serverContext = this.temporaryServers.get(key);
        if (serverContext) {
          // Extract serverId from key
          const serverId = key.substring(0, key.lastIndexOf(':'));

          // Log ServerClose event
          const serverLogger = this.temporaryServerLoggers.get(key);
          if (serverLogger) {
            await serverLogger.logServerLifecycle({
              action: MCPEventLogType.ServerClose,
            });
          }

          // Stop token refresh timer
          serverContext.stopTokenRefresh();

          try {
            await serverContext.closeConnection(ServerStatus.Offline);
          } catch (error) {
            this.logger.error({ error, key }, 'Error closing temporary server connection');
          }

          this.temporaryServers.delete(key);
          this.temporaryServerLoggers.delete(key);
        }
      })
    );

    this.logger.info({ userId }, 'All temporary servers closed for user');
  }

  /**
   * Close all temporary servers based on a template
   * @param serverId Template serverId
   */
  async closeAllTemporaryServersByTemplate(serverId: string): Promise<void> {
    const keysToDelete: string[] = [];
    const prefix = `${serverId}:`;

    for (const key of this.temporaryServers.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }

    await Promise.all(
      keysToDelete.map(async (key) => {
        const serverContext = this.temporaryServers.get(key);
        if (serverContext) {
          // Log ServerClose event
          const serverLogger = this.temporaryServerLoggers.get(key);
          if (serverLogger) {
            await serverLogger.logServerLifecycle({
              action: MCPEventLogType.ServerClose,
            });
          }

          // Stop token refresh timer
          serverContext.stopTokenRefresh();

          try {
            await serverContext.closeConnection(ServerStatus.Offline);
          } catch (error) {
            this.logger.error({ error, key }, 'Error closing temporary server connection');
          }

          this.temporaryServers.delete(key);
          this.temporaryServerLoggers.delete(key);
        }
      })
    );

    this.logger.info({ serverId }, 'All temporary servers closed for template');
  }

  /**
   * When peta-core runs inside Docker, rewrite relative ./skills/<id> volume mount
   * sources in a Docker-based launchConfig to host-absolute paths.
   *
   * The Docker daemon always interprets bind-mount sources relative to the host
   * filesystem, so a relative path like "./skills/myServer" that exists only
   * inside the peta-core container will not be found by the daemon.
   *
   * We query the Docker socket to discover the host-side path that is mounted
   * at /data/skills (the peta-core container mount point), then substitute that
   * host path into any child-container volume args that target /app/skills.
   *
   * Note: We use the fixed mount point /data/skills for the Docker socket lookup,
   * independent of SKILLS_CONFIG.SKILLS_DIR, because these are two separate
   * concerns: the mount point is determined by docker-compose, while SKILLS_DIR
   * controls where the application reads/writes files.
   *
   * This is a no-op on macOS/Windows native installs, or when the Docker socket
   * is not available.
   */
  private async resolveSkillsVolumeMounts(launchConfig: Record<string, any>): Promise<void> {
    // Only applies to stdio-style Docker invocations
    if (launchConfig.command !== 'docker' || !Array.isArray(launchConfig.args)) {
      return;
    }

    // Only needed when peta-core itself is running inside Docker
    if (process.env.PETA_CORE_IN_DOCKER !== 'true') {
      return;
    }

    // peta-core container mount used to resolve host absolute path.
    const CORE_CONTAINER_SKILLS_MOUNT = '/data/skills';
    // Child skillsmcp container destination mount.
    const CHILD_CONTAINER_SKILLS_MOUNT = '/app/skills';

    const hostSkillsDir = await resolveHostPath(CORE_CONTAINER_SKILLS_MOUNT);
    if (!hostSkillsDir) {
      // Not in Docker, socket unavailable, or mount not found – leave args unchanged
      return;
    }

    this.logger.debug(
      { containerMount: CORE_CONTAINER_SKILLS_MOUNT, childMount: CHILD_CONTAINER_SKILLS_MOUNT, hostSkillsDir },
      'Rewriting skills volume mount paths to host-absolute paths'
    );

    launchConfig.args = (launchConfig.args as string[]).map((arg) =>
      this.rewriteSkillsVolumeArg(arg, CHILD_CONTAINER_SKILLS_MOUNT, hostSkillsDir)
    );
  }

  /**
   * Rewrite a single Docker volume argument if its destination matches the
   * skills directory.
   *
   * Handles the standard bind-mount format:  <source>:<destination>[:<options>]
   * Rewrites recognized source prefixes to the resolved host skills path.
   */
  private rewriteSkillsVolumeArg(
    arg: string,
    childContainerSkillsDir: string,
    hostSkillsDir: string
  ): string {
    // Volume specs always contain at least one colon
    if (!arg.includes(':')) {
      return arg;
    }

    const colonIdx = arg.indexOf(':');
    const source = arg.slice(0, colonIdx);
    const rest = arg.slice(colonIdx); // includes the leading ':'

    // Verify the destination matches or is under child skills dir.
    const afterColon = rest.slice(1); // strip leading ':'
    const destAndOptions = afterColon.split(':');
    const dest = destAndOptions[0];
    if (dest !== childContainerSkillsDir && !dest.startsWith(childContainerSkillsDir + '/')) {
      return arg;
    }

    const sourcePrefixes = ['./skills/', '/app/skills/', '/data/skills/'];
    const matchedPrefix = sourcePrefixes.find((prefix) => source.startsWith(prefix));
    if (!matchedPrefix) {
      return arg;
    }

    // Rewrite: <prefix><serverId> -> <hostSkillsDir>/<serverId>
    const serverId = source.slice(matchedPrefix.length);
    if (!serverId) {
      return arg;
    }

    const newSource = path.join(hostSkillsDir, serverId);
    return newSource + rest;
  }
}
