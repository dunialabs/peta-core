import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DangerLevel, ServerStatus } from '../../types/enums.js';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListPromptsResult, ListResourcesResult, ListToolsResult, ServerCapabilities, Tool, Resource, Prompt, ListResourceTemplatesResult, ResourceTemplate, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Server } from '@prisma/client';
import { ServerConfigCapabilities, ToolCapabilityConfig, ResourceCapabilityConfig, PromptCapabilityConfig, ServerConfigWithEnabled } from '../types/mcp.js';
import { CapabilitiesService } from "../services/CapabilitiesService.js";
import { IAuthStrategy, TokenInfo } from '../auth/IAuthStrategy.js';
import { createLogger } from '../../logger/index.js';
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ServerManager } from "./ServerManager.js";

/**
 * Downstream Server context object
 */
export class ServerContext {
  // Static private variable for generating auto-incrementing ID
  private static nextId: number = 1;
  
  // Read-only instance ID property
  readonly id: string;
  
  serverID: string;
  serverEntity: Server;
  status: ServerStatus;
  capabilities?: ServerCapabilities;
  capabilitiesConfig: ServerConfigCapabilities;
  tools?: ListToolsResult;
  resources?: ListResourcesResult;
  resourceTemplates?: ListResourceTemplatesResult;
  prompts?: ListPromptsResult;
  lastSync: Date;
  connection: Client | undefined; // MCP SDK Server/Client object
  transport: Transport |  undefined;
  readonly maxTimeoutCount: number = 3;
  timeoutCount: number = 0;
  errorCount: number;
  lastError?: string;

  // User ID, only temporary Server has value
  userId?: string;

  // User Token, used for encryption/decryption when updating OAuth refresh token
  // Only used in scenarios requiring refresh token persistence (e.g., Notion OAuth)
  userToken?: string;

  // Last activity time (for idle detection in lazy start)
  lastActive: number;

  // Cached capabilities (preloaded from database)
  cachedTools?: ListToolsResult;
  cachedResources?: ListResourcesResult;
  cachedResourceTemplates?: ListResourceTemplatesResult;
  cachedPrompts?: ListPromptsResult;

  // Authentication related fields
  private authStrategy?: IAuthStrategy;
  private tokenRefreshTimer?: NodeJS.Timeout;
  private currentTokenInfo?: TokenInfo;
  
  // Logger for ServerContext
  private logger = createLogger('ServerContext');

  constructor(serverEntity: Server) {
    // Assign ID and increment counter
    this.id = String(ServerContext.nextId++);

    this.serverID = serverEntity.serverId;
    this.serverEntity = serverEntity;
    this.status = ServerStatus.Offline;
    this.lastSync = new Date();
    this.lastActive = Date.now();
    this.errorCount = 0;

    this.capabilitiesConfig = { tools: {}, resources: {}, prompts: {} };
    if (serverEntity.capabilities) {
      try {
        this.capabilitiesConfig = JSON.parse(serverEntity.capabilities) as ServerConfigCapabilities;
        this.capabilitiesConfig.prompts ??= {};
        this.capabilitiesConfig.resources ??= {};
        this.capabilitiesConfig.tools ??= {};
      } catch (error) {
        this.logger.error({ error, serverId: this.serverID }, 'Error parsing server capabilities');
      }
    }

    // Preload cached capabilities from database
    this.loadCachedCapabilities(serverEntity);
  }

  /**
   * Load cached capabilities from serverEntity
   */
  private loadCachedCapabilities(serverEntity: Server): void {
    try {
      if (serverEntity.cachedTools) {
        this.cachedTools = JSON.parse(serverEntity.cachedTools);
      }
      if (serverEntity.cachedResources) {
        this.cachedResources = JSON.parse(serverEntity.cachedResources);
      }
      if (serverEntity.cachedResourceTemplates) {
        this.cachedResourceTemplates = JSON.parse(serverEntity.cachedResourceTemplates);
      }
      if (serverEntity.cachedPrompts) {
        this.cachedPrompts = JSON.parse(serverEntity.cachedPrompts);
      }

      this.logger.debug({ serverId: this.serverID }, 'Cached capabilities loaded');
    } catch (error) {
      this.logger.error({ error, serverId: this.serverID }, 'Failed to load cached capabilities');
    }
  }

  updateCapabilities(newCaps: ServerCapabilities) {
    this.capabilities = newCaps;
    this.lastSync = new Date();
  }

  updateCapabilitiesConfig(newCaps: string) {
    try {
      this.serverEntity.capabilities = newCaps;
      this.capabilitiesConfig = JSON.parse(newCaps) as ServerConfigCapabilities;
    } catch (error) {
      this.logger.error({ error, serverName: this.serverEntity.serverName }, 'Error parsing server capabilities config');
    }
    this.lastSync = new Date();
  }

  async updateTools(newTools: ListToolsResult) {
    this.tools = newTools;
    this.lastSync = new Date();

    // Persist to database
    await this.persistCapabilitiesCache({ tools: newTools });
  }

  async updateResources(newResources?: ListResourcesResult) {
    this.resources = newResources;
    this.lastSync = new Date();

    // Persist to database
    if (newResources) {
      await this.persistCapabilitiesCache({ resources: newResources });
    }
  }

  async updateResourceTemplates(newResourceTemplates?: ListResourceTemplatesResult) {
    this.resourceTemplates = newResourceTemplates;
    this.lastSync = new Date();

    // Persist to database
    if (newResourceTemplates) {
      await this.persistCapabilitiesCache({ resourceTemplates: newResourceTemplates });
    }
  }

  async updatePrompts(newPrompts: ListPromptsResult) {
    this.prompts = newPrompts;
    this.lastSync = new Date();

    // Persist to database
    await this.persistCapabilitiesCache({ prompts: newPrompts });
  }
// Get server's own permission configuration
  getMcpCapabilities(): ServerConfigWithEnabled {
    // Build structure conforming to McpServerCapabilities type
    const tools: { [toolName: string]: ToolCapabilityConfig } = {};
    const resources: { [resourceName: string]: ResourceCapabilityConfig } = {};
    const prompts: { [promptName: string]: PromptCapabilityConfig } = {};

    // Get capabilities, use default values if not present
    const capabilities = { tools: this.capabilitiesConfig.tools ?? {}, resources: this.capabilitiesConfig.resources ?? {}, prompts: this.capabilitiesConfig.prompts ?? {} };

    // Handle tools
    if (this.tools?.tools) {
      this.tools.tools.forEach((tool: Tool) => {
        const toolValue = capabilities.tools[tool.name];
        let dangerLevel: DangerLevel;
        if (toolValue?.dangerLevel) {
          dangerLevel = toolValue.dangerLevel;
        } else {
          const destructiveHint = tool.annotations?.destructiveHint === true;
          dangerLevel = destructiveHint ? DangerLevel.Notification : DangerLevel.Silent;
        }

        tools[tool.name] = { enabled: toolValue?.enabled ?? true, description: tool.description, dangerLevel: dangerLevel };
      });
    } else {
      Object.assign(tools, capabilities.tools);
    }

    // Handle resources
    if (this.resources?.resources) {
      this.resources.resources.forEach((resource: Resource) => {
        resources[resource.name] = { enabled: capabilities.resources[resource.name]?.enabled ?? true, description: resource.description };
      });
      this.resourceTemplates?.resourceTemplates.forEach((resourceTemplate: ResourceTemplate) => {
        resources[resourceTemplate.name] = { enabled: capabilities.resources[resourceTemplate.name]?.enabled ?? true, description: resourceTemplate.description };
      });
    } else {
      Object.assign(resources, capabilities.resources);
    }

    // Handle prompts
    if (this.prompts?.prompts) {
      this.prompts.prompts.forEach((prompt: Prompt) => {
        prompts[prompt.name] = { enabled: capabilities.prompts[prompt.name]?.enabled ?? true, description: prompt.description };
      });
    } else {
      Object.assign(prompts, capabilities.prompts);
    }

    return {
      enabled: this.serverEntity.enabled,
      serverName: this.serverEntity.serverName,
      allowUserInput: this.serverEntity.allowUserInput,
      authType: this.serverEntity.authType,
      category: this.serverEntity.category,
      configTemplate: this.serverEntity.configTemplate || '',
      configured: true,  // ServerContext only exists for configured servers
      tools,
      resources,
      prompts,
    };
  }

  getDangerLevel(toolName: string): DangerLevel | undefined {
    return this.capabilitiesConfig.tools[toolName]?.dangerLevel;
  }

  getToolDescription(toolName: string): string {
    return this.tools?.tools?.find((tool: Tool) => tool.name === toolName)?.description ?? this.capabilitiesConfig.tools[toolName]?.description ?? '';
  }

  updateStatus(newStatus: ServerStatus) {
    this.status = newStatus;
  }

  async recordTimeout(error: any): Promise<boolean | undefined> {

    if (!(error instanceof McpError)) {
      return undefined;
    }

    if (error.code !== ErrorCode.RequestTimeout) {
      return undefined;
    }

    this.timeoutCount += 1;

    if (this.timeoutCount >= this.maxTimeoutCount) {
      try {
        this.connection?.ping({ timeout: 50000 });
        this.clearTimeout();
      } catch (error) {
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
          if (this.serverEntity.allowUserInput) {
            await ServerManager.instance.reconnectTemporaryServer(this.serverEntity, this.userId!, this.userToken!);
          } else {
            const token = ServerManager.instance.getOwnerToken();
            if (token) {
              await ServerManager.instance.reconnectServer(this.serverEntity, token);
            }
          }
          return true;
        }
      }
    }
    return false;
  }

  clearTimeout() {
    this.timeoutCount = 0;
  }

  recordError(error: string) {
    this.errorCount += 1;
    this.lastError = error;
  }

  clearError() {
    this.errorCount = 0;
    this.lastError = undefined;
  }

  isCapabilityChanged(newCapabilities: ServerConfigCapabilities): { toolsChanged: boolean, resourcesChanged: boolean, promptsChanged: boolean } {
    let toolsChanged = CapabilitiesService.isCapabilityListChanged(this.capabilitiesConfig.tools, newCapabilities.tools);
    let resourcesChanged = CapabilitiesService.isCapabilityListChanged(this.capabilitiesConfig.resources, newCapabilities.resources);
    let promptsChanged = CapabilitiesService.isCapabilityListChanged(this.capabilitiesConfig.prompts, newCapabilities.prompts);
    return { toolsChanged, resourcesChanged, promptsChanged };
  }

  /**
   * Start automatic token refresh
   * @param authStrategy Authentication strategy
   * @returns Initial access token
   */
  async startTokenRefresh(authStrategy: IAuthStrategy): Promise<string> {
    this.authStrategy = authStrategy;

    // Get initial token
    this.currentTokenInfo = await authStrategy.getInitialToken();
    this.logger.info({
      serverName: this.serverEntity.serverName,
      expiresIn: this.currentTokenInfo.expiresIn
    }, 'Initial token obtained');

    // Check if strategy provides complete OAuth configuration (Notion OAuth specific)
    // If token information was updated during initial token fetch, also need to persist to database
    if (this.authStrategy.getCurrentOAuthConfig) {
      const oauthConfig = this.authStrategy.getCurrentOAuthConfig();
      if (oauthConfig) {
        await this.updateRefreshTokenToDatabase(oauthConfig);
      }
    }

    // Start timer (using real expiration time)
    this.scheduleNextRefresh();

    return this.currentTokenInfo.accessToken;
  }

  /**
   * Schedule next refresh (based on token real expiration time)
   */
  private scheduleNextRefresh(): void {
    if (!this.currentTokenInfo) {
      return;
    }

    // Clear old timer
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    // Calculate time until expiration (refresh 5 minutes early)
    const REFRESH_BUFFER = 5 * 60 * 1000; // 5 minutes
    // Node.js setTimeout maximum delay (~24.8 days); anything larger overflows to immediate execution.
    const MAX_TIMEOUT_MS = 2_147_000_000;
    const now = Date.now();
    const timeUntilExpiry = this.currentTokenInfo.expiresAt - now;
    let refreshDelay = Math.max(timeUntilExpiry - REFRESH_BUFFER, 10000); // Wait at least 10 seconds

    // Clamp to Node's maximum supported delay to avoid tight refresh loops when expiresAt is far in the future.
    if (refreshDelay > MAX_TIMEOUT_MS) {
      this.logger.debug({
        serverName: this.serverEntity.serverName,
        requestedDelaySeconds: Math.round(refreshDelay / 1000),
        clampedDelaySeconds: Math.round(MAX_TIMEOUT_MS / 1000)
      }, 'Refresh delay exceeds setTimeout limit, clamping to maximum supported delay');
      refreshDelay = MAX_TIMEOUT_MS;
    }

    this.logger.debug({
      serverName: this.serverEntity.serverName,
      refreshDelaySeconds: Math.round(refreshDelay / 1000)
    }, 'Next token refresh scheduled');

    this.tokenRefreshTimer = setTimeout(async () => {
      await this.performTokenRefresh();
    }, refreshDelay);
  }

  /**
   * Perform token refresh
   */
  private async performTokenRefresh(): Promise<void> {
    if (!this.authStrategy) {
      return;
    }

    try {
      this.logger.debug({ serverName: this.serverEntity.serverName }, 'Refreshing token...');

      const newTokenInfo = await this.authStrategy.refreshToken();
      this.currentTokenInfo = newTokenInfo;

      this.logger.info({
        serverName: this.serverEntity.serverName,
        expiresIn: newTokenInfo.expiresIn
      }, 'Token refreshed successfully');

      // Check if strategy provides complete OAuth configuration (Notion OAuth specific)
      if (this.authStrategy.getCurrentOAuthConfig) {
        const oauthConfig = this.authStrategy.getCurrentOAuthConfig();
        if (oauthConfig) {
          await this.updateRefreshTokenToDatabase(oauthConfig);
        }
      }

      // Notify downstream server
      await this.notifyTokenUpdate(newTokenInfo.accessToken);

      // Schedule next refresh
      this.scheduleNextRefresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it's an OAuth authentication error (401/400)
      // These errors usually mean refresh token has expired, been revoked, or configuration is wrong
      const isAuthError = errorMessage.includes('401') ||
                          errorMessage.includes('400') ||
                          errorMessage.includes('Unauthorized') ||
                          errorMessage.includes('Bad Request');

      if (isAuthError) {
        // OAuth authentication failed, stop automatic refresh
        this.logger.fatal({
          error,
          serverName: this.serverEntity.serverName,
          errorMessage
        }, 'OAuth authentication failed - stopping token refresh. Please check OAuth configuration (refresh_token may be invalid or revoked)');

        this.lastError = errorMessage;
        // Stop timer, no more retries
        this.stopTokenRefresh();
      } else {
        // Other errors (network issues, etc.), retry after 3 minutes
        this.logger.error({
          error,
          serverName: this.serverEntity.serverName,
          errorMessage
        }, 'Failed to refresh token - will retry in 3 minutes');

        this.tokenRefreshTimer = setTimeout(async () => {
          await this.performTokenRefresh();
        }, 3 * 60 * 1000);
      }
    }
  }

  /**
   * Notify downstream server of token update
   */
  private async notifyTokenUpdate(newToken: string): Promise<void> {
    if (!this.connection || !this.transport) {
      this.logger.warn({
        serverName: this.serverEntity.serverName
      }, 'Cannot notify token update: no connection');
      return;
    }

    try {
      const transport = this.transport as any;
      if (transport.send) {
        await transport.send({
          jsonrpc: '2.0',
          method: 'notifications/token/update',
          params: {
            token: newToken,
            timestamp: Date.now(),
          },
        });
        this.logger.debug({
          serverName: this.serverEntity.serverName
        }, 'Token update notification sent');
      }
    } catch (error) {
      this.logger.error({
        error,
        serverName: this.serverEntity.serverName
      }, 'Failed to send token update notification');
    }
  }

  async closeConnection(status: ServerStatus): Promise<void> {
    if (!this.connection) {
      return;
    }

    this.status = status;
    
    if (this.transport instanceof StreamableHTTPClientTransport) {
      await this.transport?.terminateSession();
    }

    await this.connection.close();
    this.connection = undefined;
  }


  /**
   * Stop automatic token refresh
   */
  stopTokenRefresh(): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }

    if (this.authStrategy?.cleanup) {
      this.authStrategy.cleanup();
    }

    this.authStrategy = undefined;
    this.currentTokenInfo = undefined;

    this.logger.info({ serverName: this.serverEntity.serverName }, 'Token refresh stopped');
  }

  /**
   * Update OAuth configuration to database
   *
   * Used to support complete persistence of OAuth configuration (e.g., Notion OAuth token cache)
   * - Temporary Server (has userId): Update user.launchConfigs
   * - Regular Server (no userId, has userToken): Update server.launchConfig
   *
   * @param oauthConfig Complete OAuth configuration (includes accessToken, refreshToken, expiresAt, etc.)
   */
  private async updateRefreshTokenToDatabase(oauthConfig: any): Promise<void> {
    try {
      const usePetaOauthConfig = this.serverEntity.usePetaOauthConfig;
      if (usePetaOauthConfig) {
        this.logger.debug({
          serverName: this.serverEntity.serverName
        }, 'Skipping OAuth config persistence for Peta-managed OAuth');
        return;
      }

      // 1. Both missing → return (cannot update)
      if (!this.userId && !this.userToken) {
        this.logger.debug({
          serverName: this.serverEntity.serverName
        }, 'No userId and userToken, skipping OAuth config update');
        return;
      }

      // 2. Dynamically import ServerManager
      const { ServerManager } = await import('./ServerManager.js');

      // 3. Has userId (temporary Server) → update user configuration
      if (this.userId) {
        this.logger.debug({
          serverName: this.serverEntity.serverName,
          userId: this.userId,
          hasAccessToken: !!oauthConfig.accessToken,
          hasExpiresAt: !!oauthConfig.expiresAt
        }, 'Updating user launch config with OAuth tokens...');

        await ServerManager.instance.updateUserLaunchConfig(this, oauthConfig);

        this.logger.info({
          serverName: this.serverEntity.serverName,
          userId: this.userId
        }, 'User launch config updated with OAuth tokens successfully');
      }
      // 4. No userId but has userToken (regular Server) → update server configuration
      else {
        this.logger.debug({
          serverName: this.serverEntity.serverName,
          hasAccessToken: !!oauthConfig.accessToken,
          hasExpiresAt: !!oauthConfig.expiresAt
        }, 'Updating server launch config with OAuth tokens...');

        await ServerManager.instance.updateServerLaunchConfig(this, oauthConfig);

        this.logger.info({
          serverName: this.serverEntity.serverName
        }, 'Server launch config updated with OAuth tokens successfully');
      }

      // ✅ After successful persistence, notify strategy to reset flag
      // Placed here: good encapsulation, avoids duplication, safer
      if (this.authStrategy?.markConfigAsPersisted) {
        this.authStrategy.markConfigAsPersisted();
        this.logger.debug({
          serverName: this.serverEntity.serverName
        }, 'OAuth config marked as persisted');
      }
    } catch (error) {
      this.logger.error({
        error,
        serverName: this.serverEntity.serverName,
        userId: this.userId
      }, 'Failed to update OAuth config');
      // ⚠️ Don't throw error, flag remains true, will retry next time
    }
  }

  /**
   * Get current access token
   */
  getCurrentToken(): string | undefined {
    return this.currentTokenInfo?.accessToken;
  }

  /**
   * Get token expiration time
   */
  getTokenExpiresAt(): number | undefined {
    return this.currentTokenInfo?.expiresAt;
  }

  /**
   * Persist capabilities cache to database
   */
  private async persistCapabilitiesCache(data: {
    tools?: any;
    resources?: any;
    resourceTemplates?: any;
    prompts?: any;
  }): Promise<void> {
    try {
      const { ServerRepository } = await import('../../repositories/ServerRepository.js');
      await ServerRepository.updateCapabilitiesCache(this.serverID, data);

      this.logger.debug({ serverId: this.serverID, updatedFields: Object.keys(data) }, 'Capabilities cache updated');
    } catch (error) {
      this.logger.error({ error, serverId: this.serverID }, 'Failed to persist capabilities cache');
      // Don't throw error to avoid affecting main flow
    }
  }
}
