import { ClientSessionStatus, MCPEventLogType, DangerLevel, ServerStatus } from '../../types/enums.js';
import { Permissions } from '../types/mcp.js';
import { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { ServerContext } from './ServerContext.js';
import { AuthContext, DisconnectReason } from '../../types/auth.types.js';
import { ListToolsResult, ListResourcesResult, ListPromptsResult, Tool, Resource, Prompt, ServerCapabilities, ToolListChangedNotification, ToolListChangedNotificationSchema, ClientCapabilities, ResourceUpdatedNotification, ResourceTemplate, ListResourceTemplatesResult } from "@modelcontextprotocol/sdk/types.js";
import { ServerManager } from './ServerManager.js';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ProxySession } from './ProxySession.js';
import { LogService } from '../../log/LogService.js';
import ServerRepository from '../../repositories/ServerRepository.js';
import { createLogger } from '../../logger/index.js';
import { socketNotifier } from '../../socket/SocketNotifier.js';
/**
 * MCP Client session object
 */
export class ClientSession {
  sessionId: string;
  userId: string;
  token: string;
  lastActive: Date;
  status: ClientSessionStatus;
  connection?: Server;
  capabilities?: ClientCapabilities;
  authContext: AuthContext;
  clientInfo?:  Implementation;
  private sseConnected: boolean = false;
  private lastSseDisconnectedAt?: Date | null;
  private lastUserInfoRefresh?: number;
  private proxySession?: ProxySession;
  private closeTriggered: boolean = false;
  // Logger for ClientSession
  private logger: ReturnType<typeof createLogger>;

  get permissions(): Permissions {
    return this.authContext.permissions;
  }

  set permissions(permissions: Permissions) {
    this.authContext.permissions = permissions;
  }

  get userPreferences(): Permissions {
    return this.authContext.userPreferences;
  }

  set userPreferences(userPreferences: Permissions) {
    this.authContext.userPreferences = userPreferences;
  }

  get launchConfigs(): Record<string, string> {
    return JSON.parse(this.authContext.launchConfigs || '{}');
  }

  set launchConfigs(launchConfigs: string) {
    this.authContext.launchConfigs = launchConfigs;
  }

  constructor(sessionId: string, userId: string, token: string, authContext: AuthContext) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.token = token;
    this.lastActive = new Date();
    this.status = ClientSessionStatus.Active;
    this.authContext = authContext;
    this.launchConfigs = authContext.launchConfigs;
    // Initialize logger with sessionId context
    this.logger = createLogger('ClientSession', { sessionId: this.sessionId });
  }

  connectionInitialized(connection: Server): void {
    this.connection = connection;
    try {
      socketNotifier.notifyOnlineSessions(this.userId);
    } catch (error: any) {
      this.logger.warn({ error: error.message, userId: this.userId }, 'Failed to notify online sessions after creation');
    }

    // Start user-configured temporary servers
    this.startUserTemporaryServers().catch(error => {
      this.logger.error({ error, userId: this.userId }, 'Failed to start temporary servers for user');
    });
  }

  canRequestSampling(): boolean {
    return this.capabilities?.sampling !== undefined;
  }

  canRequestElicitation(): boolean {
    return this.capabilities?.elicitation !== undefined;
  }

  canRequestRoots(): boolean {
    return this.capabilities?.roots !== undefined;
  }

  touch() {
    this.lastActive = new Date();
  }

  markSseConnected(): void {
    if (!this.sseConnected) {
      this.sseConnected = true;
      this.lastSseDisconnectedAt = null;
      this.touch();
      this.logger.debug('GET SSE connected');
    }
  }

  markSseDisconnected(): void {
    if (this.sseConnected) {
      this.sseConnected = false;
      this.lastSseDisconnectedAt = new Date();
      this.logger.debug({ at: this.lastSseDisconnectedAt }, 'GET SSE disconnected');
    }
  }

  isSseConnected(): boolean {
    return this.sseConnected;
  }

  getLastSseDisconnectedAt(): Date | null {
    return this.lastSseDisconnectedAt ?? null;
  }

  isExpired(now?: Date, timeoutMinutes?: number): boolean {
    // Check if user authorization has expired
    if (this.authContext.expiresAt && Math.floor(Date.now() / 1000) > this.authContext.expiresAt) {
      return true;
    }
    
    // Check if session has timed out (if parameters provided)
    if (now && timeoutMinutes) {
      return (now.getTime() - this.lastActive.getTime()) > timeoutMinutes * 60 * 1000;
    }
    
    return false;
  }

  isInactive(now: Date, timeoutMs: number): boolean {
    if (this.isSseConnected()) {
      return false;
    }

    const lastActiveMs = this.lastActive.getTime();
    const lastSseDisconnectedMs = this.lastSseDisconnectedAt ? this.lastSseDisconnectedAt.getTime() : 0;
    const effectiveLast = Math.max(lastActiveMs, lastSseDisconnectedMs);

    return now.getTime() - effectiveLast > timeoutMs;
  }

  /**
   * Update expiration time
   */
  updateExpiresAt(expiresAt: number | null): void {
    this.authContext.expiresAt = expiresAt;
  }

  /**
   * Get last user info refresh time
   */
  getLastUserInfoRefresh(): number | undefined {
    return this.lastUserInfoRefresh;
  }

  /**
   * Update user info refresh time
   */
  updateLastUserInfoRefresh(timestamp: number): void {
    this.lastUserInfoRefresh = timestamp;
  }

  /**
   * Update authentication context
   */
  updateAuthContext(authContext: AuthContext): void {
    this.authContext = authContext;
  }

  /**
   * Update permissions
   */
  updatePermissions(permissions: Permissions): void {
    this.permissions = permissions;
  }

  /**
   * Set associated ProxySession
   */
  setProxySession(proxySession: ProxySession): void {
    this.proxySession = proxySession;
  }

  /**
   * Start user-configured temporary servers
   * Automatically called after ProxySession creation
   */
  async startUserTemporaryServers(): Promise<void> {
    try {

      let notificationToolsChanged = false;
      let notificationResourcesChanged = false;
      let notificationPromptsChanged = false;
      // Iterate through all configured servers
      for (const [serverId, encryptedLaunchConfig] of Object.entries(this.launchConfigs)) {
        if (!encryptedLaunchConfig) {
          continue;
        }

        const serverContext = ServerManager.instance.getTemporaryServer(serverId, this.userId);
        if (serverContext && (serverContext.status === ServerStatus.Online || serverContext.status === ServerStatus.Sleeping)) {
          continue;
        }

        try {
          // Get server entity
          const server = await ServerRepository.findByServerId(serverId);
          if (!server) {
            this.logger.warn({ serverId }, 'Server not found in database, skipping temporary server startup');
            continue;
          }

          // Verify server allows user input
          if (!server.allowUserInput) {
            this.logger.warn({ serverId }, 'Server does not allow user input, skipping temporary server startup');
            continue;
          }

          // Create temporary server entity (using user's encrypted launchConfig)
          const tempServerEntity = {
            ...server,
            launchConfig: JSON.stringify(encryptedLaunchConfig)
          };

          // Start temporary server
          const serverContext = await ServerManager.instance.createTemporaryServer(
            this.userId,
            tempServerEntity,
            this.token,
            true
          );

          if (serverContext.tools?.tools?.length ?? 0 > 0) {
            notificationToolsChanged = true;
          }
          if ((serverContext.resources?.resources?.length ?? 0) > 0 || (serverContext.resourceTemplates?.resourceTemplates?.length ?? 0) > 0) {
            notificationResourcesChanged = true;
          }
          if (serverContext.prompts?.prompts?.length ?? 0 > 0) {
            notificationPromptsChanged = true;
          }

          this.logger.info({
            serverId,
            userId: this.userId,
            toolsCount: serverContext.tools?.tools?.length,
            resourcesCount: serverContext.resources?.resources?.length,
            promptsCount: serverContext.prompts?.prompts?.length
          }, 'Started temporary server for user');
        } catch (error: any) {
          this.logger.error({ error, serverId, userId: this.userId }, 'Failed to start temporary server for user');
          // Continue processing other servers, don't interrupt entire flow
        }
      }

      if (notificationToolsChanged) {
        this.sendToolListChanged();
      }
      if (notificationResourcesChanged) {
        this.sendResourceListChanged();
      }
      if (notificationPromptsChanged) {
        this.sendPromptListChanged();
      }
    } catch (error: any) {
      this.logger.error({ error, userId: this.userId }, 'Failed to load user temporary servers');
    }
  }

  /**
   * Get associated ProxySession
   */
  getProxySession(): ProxySession | undefined {
    return this.proxySession;
  }

  /**
   * Check if server can be accessed
   */
  canAccessServer(serverID: string): boolean {
    const serverContext = ServerManager.instance.getServerContext(serverID, this.userId);
    if (!serverContext) return false;
    if (!serverContext.serverEntity.enabled) return false;
    if (serverContext.status !== ServerStatus.Online && serverContext.status !== ServerStatus.Sleeping) return false;

    const isAnonymous = this.authContext.kind === 'anonymous';
    if (isAnonymous && !serverContext.serverEntity.anonymousAccess) return false;
    const serverPermsEnabled = this.permissions[serverID]?.enabled
      ?? (isAnonymous ? serverContext.serverEntity.anonymousAccess : serverContext.serverEntity.publicAccess);
    const userPreferencesEnabled = this.userPreferences[serverID]?.enabled ?? true;

    if (serverContext.serverEntity.allowUserInput) {
      if (isAnonymous) { return false; }
      if (serverContext.userId !== this.userId) return false;
      return serverPermsEnabled && userPreferencesEnabled;
    } else {
      return serverPermsEnabled && userPreferencesEnabled;
    }
  }

  canAccessServerCapabilities(serverID: string, type: 'tool' | 'resource' | 'prompt', name: string): ServerContext | undefined {
    if (!this.canAccessServer(serverID)) return undefined;
    const serverContext = ServerManager.instance.getServerContext(serverID, this.userId);
    if (!serverContext) return undefined;
    if (!serverContext.serverEntity.enabled) return undefined;
    if (serverContext.status !== ServerStatus.Online && serverContext.status !== ServerStatus.Sleeping) return undefined;

    try {
      const serverPerms = serverContext.capabilitiesConfig;
      if (!serverPerms) return serverContext;
      
      switch (type) {
        case 'tool':
          if (serverPerms.tools[name]?.enabled ?? true) {
            return serverContext;
          }
          break;
        case 'resource':
          if (serverPerms.resources[name]?.enabled ?? true) {
            return serverContext;
          }
          break;
        case 'prompt':
          if (serverPerms.prompts[name]?.enabled ?? true) {
            return serverContext;
          }
          break;
      }
      return undefined;
    } catch (error) {
      this.logger.error({ error }, 'Error parsing server capabilities');
      return undefined;
    }
  }

  /**
   * Check if tool can be used
   */
  canUseTool(serverID: string, toolName: string): boolean {
    const serverContext = this.canAccessServerCapabilities(serverID, 'tool', toolName);
    if (!serverContext) return false;
    
    return this.canUseToolByServerContext(serverContext, toolName);
  }

  private canUseToolByServerContext(serverContext: ServerContext, toolName: string): boolean {
    
    if (serverContext.serverEntity.allowUserInput) {
      if (serverContext.userId !== this.userId) return false;
    } else {
      const serverPerms = this.permissions[serverContext.serverID];
      const serverPermsEnabled = serverPerms?.tools[toolName]?.enabled ?? true;
      if (!serverPermsEnabled) return false;
    }
    
    const userPreferencesEnabled = this.userPreferences[serverContext.serverID]?.tools[toolName]?.enabled ?? true;
    return userPreferencesEnabled;
  }

  /**
   * Check if resource can be accessed
   */
  canAccessResource(serverID: string, resourceName: string): boolean {
    const serverContext = this.canAccessServerCapabilities(serverID, 'resource', resourceName);
    if (!serverContext) return false;
    
    return this.canAccessResourceByServerContext(serverContext, resourceName);
  }

  private canAccessResourceByServerContext(serverContext: ServerContext, resourceName: string): boolean {
    
    if (serverContext.serverEntity.allowUserInput) {
      if (serverContext.userId !== this.userId) return false;
    } else {
      const serverPerms = this.permissions[serverContext.serverID];
      const serverPermsEnabled = serverPerms?.resources[resourceName]?.enabled ?? true;
      if (!serverPermsEnabled) return false;
    }
    
    const userPreferencesEnabled = this.userPreferences[serverContext.serverID]?.resources[resourceName]?.enabled ?? true;
    return userPreferencesEnabled;
  }

  /**
   * Check if prompt can be used
   */
  canUsePrompt(serverID: string, promptName: string): boolean {
    const serverContext = this.canAccessServerCapabilities(serverID, 'prompt', promptName);
    if (!serverContext) return false;
    return this.canUsePromptByServerContext(serverContext, promptName);
  }


  private canUsePromptByServerContext(serverContext: ServerContext, promptName: string): boolean {
    if (serverContext.serverEntity.allowUserInput) {
      if (serverContext.userId !== this.userId) return false;
    } else {
      const serverPerms = this.permissions[serverContext.serverID];
      const serverPermsEnabled = serverPerms?.prompts[promptName]?.enabled ?? true;
      if (!serverPermsEnabled) return false;
    }

    const userPreferencesEnabled = this.userPreferences[serverContext.serverID]?.prompts[promptName]?.enabled ?? true;
    return userPreferencesEnabled;
  }

  /**
   * Get all available servers within permission scope
   */
  getAvailableServers(): ServerContext[] {
    let availableServers: ServerContext[] = [];
    const servers = ServerManager.instance.getAvailableServers();
    for (const server of servers) {
      if (this.canAccessServer(server.serverID)) {
        availableServers.push(server);
      }
    }
    return availableServers;
  }

  getServerCapabilities(): ServerCapabilities {
    let merged: ServerCapabilities = {tools: { listChanged: true}};

    for (const serverContext of this.getAvailableServers()) {
      if (serverContext.capabilities) {

        // prompts
        if (
          merged.prompts == null &&
          serverContext.capabilities.prompts
        ) {
          merged.prompts = {};
        }

        if (serverContext.capabilities.prompts?.listChanged === true) {
          merged.prompts!.listChanged = true;
        }

        // resources.listChanged
        if (
          merged.resources == null &&
          serverContext.capabilities.resources
        ) {
          merged.resources = {};
        }

        if (serverContext.capabilities.resources?.listChanged === true) {
          merged.resources!.listChanged = true;
        }

        // resources.subscribe
        if (merged.resources?.subscribe == null && 
          serverContext.capabilities.resources?.subscribe === true
        ) {
          merged.resources = { 
            ...merged.resources,
            subscribe: true 
          };
        }

        // completions
        if (
          merged.completions == null &&
          serverContext.capabilities.completions
        ) {
          merged.completions = serverContext.capabilities.completions;
        }

        // logging
        if (
          merged.logging == null &&
          serverContext.capabilities.logging
        ) {
          merged.logging = serverContext.capabilities.logging;
        }
      }
    }

    if (merged.resources != null) {
      merged.resources = {
        ...merged.resources,
        listChanged: true
      };
    }

    return merged;
  }

  getDangerLevel(serverID: string, toolName: string): DangerLevel | undefined {
    const dangerLevel = this.userPreferences[serverID]?.tools[toolName]?.dangerLevel;
    return dangerLevel;
  }

  // Get all server tools within permission scope
  listTools(): ListToolsResult {
    const allTools: Tool[] = [];

    const availableServers = this.getAvailableServers();
    for (const serverContext of availableServers) {
      let toolsData: Tool[] | undefined;

      // Prefer real-time data
      if (serverContext.tools?.tools) {
        toolsData = serverContext.tools.tools;
      }
      // Use cached data if real-time data not available
      else if (serverContext.cachedTools?.tools) {
        toolsData = serverContext.cachedTools.tools;
      }

      if (toolsData) {
        // Filter tools within permission scope
        const filteredTools = toolsData.filter((tool: Tool) => {
          return this.canUseToolByServerContext(serverContext, tool.name);
        });

        // Namespace tool names per server and keep the MCP App view URI in the same proxy namespace.
        const prefixedTools = filteredTools.map((tool: Tool) => {
          const userDangerLevel = this.getDangerLevel(serverContext.serverID, tool.name);
          let dangerLevel = userDangerLevel ?? serverContext.getDangerLevel(tool.name);
          let readonly = tool.annotations?.readOnlyHint === true;
          let destructiveHint = tool.annotations?.destructiveHint === true;
          if (destructiveHint !== true && dangerLevel === DangerLevel.Notification) {
            readonly = false;
            destructiveHint = true;
          } else if (dangerLevel === DangerLevel.Silent) {
            readonly = true;
            destructiveHint = false;
          }

          const originalResourceUri = this.getToolUiResourceUri(tool);
          const proxiedResourceUri = originalResourceUri
            ? this.generateNewName(serverContext.id, originalResourceUri)
            : undefined;
          const nextMeta = this.buildToolMetaWithProxiedResourceUri(tool, proxiedResourceUri);

          return {
            ...tool,
            name: this.generateNewName(serverContext.id, tool.name),
            ...(nextMeta ? { _meta: nextMeta } : {}),
            readonly: readonly,
            destructiveHint: destructiveHint
          };
        });
        this.logger.debug({ serverId: serverContext.serverID, toolsLength: prefixedTools.length }, 'Server tools length');
        allTools.push(...prefixedTools);
      }
    }
    this.logger.debug({ serverCount: availableServers.length, totalToolsLength: allTools.length }, 'Total server listTools total length');
    return {
      tools: allTools,
      _meta: {
        totalCount: allTools.length
      }
    };
  }

  /**
   * Get all server resources within permission scope
   */
  listResources(): ListResourcesResult {
    const allResources: Resource[] = [];

    for (const serverContext of this.getAvailableServers()) {
      let resourcesData: Resource[] | undefined;

      // Prefer real-time data
      if (serverContext.resources?.resources) {
        resourcesData = serverContext.resources.resources;
      }
      // Use cached data if real-time data not available
      else if (serverContext.cachedResources?.resources) {
        resourcesData = serverContext.cachedResources.resources;
      }

      if (resourcesData) {
        // Filter resources within permission scope
        const filteredResources = resourcesData.filter((resource: Resource) => {
          // If no specific resource permissions configured, default to allow all
          return this.canAccessResourceByServerContext(serverContext, resource.name);
        });

        // Namespace resource URIs per server so identical app resources can coexist safely.
        const prefixedResources = filteredResources.map((resource: Resource) => ({
          ...resource,
          uri: this.generateNewName(serverContext.id, resource.uri)
        }));
        allResources.push(...prefixedResources);
      }
    }
    
    return {
      resources: allResources,
      _meta: {
        totalCount: allResources.length
      }
    };
  }

  listResourceTemplates(): ListResourceTemplatesResult {
    const allResourceTemplates: ResourceTemplate[] = [];
    for (const serverContext of this.getAvailableServers()) {
      let resourceTemplatesData: ResourceTemplate[] | undefined;

      // Prefer real-time data
      if (serverContext.resourceTemplates?.resourceTemplates) {
        resourceTemplatesData = serverContext.resourceTemplates.resourceTemplates;
      }
      // Use cached data if real-time data not available
      else if (serverContext.cachedResourceTemplates?.resourceTemplates) {
        resourceTemplatesData = serverContext.cachedResourceTemplates.resourceTemplates;
      }

      if (resourceTemplatesData) {
        const filteredResourceTemplates = resourceTemplatesData.filter((resourceTemplate: ResourceTemplate) => {
          return this.canAccessResourceByServerContext(serverContext, resourceTemplate.name);
        });
        const prefixedResourceTemplates = filteredResourceTemplates.map((resourceTemplate: ResourceTemplate) => ({
          ...resourceTemplate,
          uriTemplate: this.generateNewName(serverContext.id, resourceTemplate.uriTemplate)
        }));
        allResourceTemplates.push(...prefixedResourceTemplates);
      }
    }
    return {
      resourceTemplates: allResourceTemplates,
      _meta: {
        totalCount: allResourceTemplates.length
      }
    };
  }

  /**
   * Get all server prompts within permission scope
   */
  listPrompts(): ListPromptsResult {
    const allPrompts: Prompt[] = [];

    for (const serverContext of this.getAvailableServers()) {
      // Prefer real-time data, fall back to cached data
      let promptsData: Prompt[] | undefined;
      if (serverContext.prompts?.prompts) {
        promptsData = serverContext.prompts.prompts;
      } else if (serverContext.cachedPrompts?.prompts) {
        promptsData = serverContext.cachedPrompts.prompts;
      }

      if (promptsData) {
        // Filter prompts within permission scope
        const filteredPrompts = promptsData.filter((prompt: Prompt) => {
          return this.canUsePromptByServerContext(serverContext, prompt.name);
        });

        // Add server ID prefix to each prompt
        const prefixedPrompts = filteredPrompts.map((prompt: Prompt) => ({
          ...prompt,
          name: this.generateNewName(serverContext.id, prompt.name)
        }));

        allPrompts.push(...prefixedPrompts);
      }
    }

    return {
      prompts: allPrompts,
      _meta: {
        totalCount: allPrompts.length
      }
    };
  }

  /**
   * Generate new tool name, resource name, prompt name
   */
  generateNewName(serverID: string, name: string): string {
    return `${name}_-_${serverID}`;
  }

  // MCP Apps may publish the view URI in either nested or flat _meta fields.
  private getToolUiResourceUri(tool: Tool): string | undefined {
    if (
      typeof tool._meta?.ui === 'object' &&
      tool._meta?.ui &&
      'resourceUri' in tool._meta.ui &&
      typeof tool._meta.ui.resourceUri === 'string'
    ) {
      return tool._meta.ui.resourceUri;
    }

    if (typeof tool._meta?.['ui/resourceUri'] === 'string') {
      return tool._meta['ui/resourceUri'];
    }

    return undefined;
  }

  private buildToolMetaWithProxiedResourceUri(
    tool: Tool,
    proxiedResourceUri?: string,
  ): Tool['_meta'] | undefined {
    // Keep both _meta.ui.resourceUri and _meta["ui/resourceUri"] aligned with the proxied URI.
    if (!proxiedResourceUri) {
      return tool._meta;
    }

    const nextMeta: NonNullable<Tool['_meta']> = {
      ...(tool._meta ?? {}),
      'ui/resourceUri': proxiedResourceUri,
    };

    if (typeof tool._meta?.ui === 'object' && tool._meta.ui) {
      nextMeta.ui = {
        ...tool._meta.ui,
        resourceUri: proxiedResourceUri,
      };
    } else {
      nextMeta.ui = {
        resourceUri: proxiedResourceUri,
      };
    }

    return nextMeta;
  }

  /**
   * Parse original serverID and name from name
   */
  parseName(name: string): { serverID: string; originalName: string } | null {
    const index = name.lastIndexOf('_-_');
    if (index === -1) {
      return null;
    }
    const serverID = name.slice(index + 3);
    const serverContext = ServerManager.instance.getServerContextByID(serverID) || ServerManager.instance.getTemporaryServerContextByID(serverID, this.userId);
    if (!serverContext) {
      return null;
    }
    return {
      serverID: serverContext.serverID,
      originalName: name.slice(0, index)
    };
  }

  resolveToolName(name: string): { serverID: string; originalName: string } | null {
    // Accept both proxied names and original names so app hosts can call either form.
    const parsed = this.parseName(name);
    if (parsed) {
      return parsed;
    }

    let match: { serverID: string; originalName: string } | null = null;

    for (const serverContext of this.getAvailableServers()) {
      let toolsData: Tool[] | undefined;

      if (serverContext.tools?.tools) {
        toolsData = serverContext.tools.tools;
      } else if (serverContext.cachedTools?.tools) {
        toolsData = serverContext.cachedTools.tools;
      }

      if (!toolsData) {
        continue;
      }

      const tool = toolsData.find((candidate: Tool) => candidate.name === name);
      if (!tool || !this.canUseToolByServerContext(serverContext, tool.name)) {
        continue;
      }

      if (match) {
        this.logger.warn({ toolName: name, userId: this.userId }, 'Ambiguous tool name across servers');
        return null;
      }

      match = {
        serverID: serverContext.serverID,
        originalName: tool.name,
      };
    }

    return match;
  }

  resolveResourceUri(uri: string): { serverID: string; originalName: string } | null {
    // Accept both proxied and original UI resource URIs during app bootstrap and refresh flows.
    const parsed = this.parseName(uri);
    if (parsed) {
      return parsed;
    }

    let match: { serverID: string; originalName: string } | null = null;

    for (const serverContext of this.getAvailableServers()) {
      let resourcesData: Resource[] | undefined;

      if (serverContext.resources?.resources) {
        resourcesData = serverContext.resources.resources;
      } else if (serverContext.cachedResources?.resources) {
        resourcesData = serverContext.cachedResources.resources;
      }

      if (!resourcesData) {
        continue;
      }

      const resource = resourcesData.find((candidate: Resource) => candidate.uri === uri);
      if (!resource || !this.canAccessResourceByServerContext(serverContext, resource.name)) {
        continue;
      }

      if (match) {
        this.logger.warn({ resourceUri: uri, userId: this.userId }, 'Ambiguous resource URI across servers');
        return null;
      }

      match = {
        serverID: serverContext.serverID,
        originalName: resource.uri,
      };
    }

    return match;
  }

  /**
 * Checks if the server is connected to a transport.
 * @returns True if the server is connected
 */
  isConnected() {
    return this.connection?.transport !== undefined
  }

  /**
   * Register capabilities
   */
  registerCapabilities() {
    if (this.isConnected()) {
      const capabilities = this.getServerCapabilities();
      this.connection!.registerCapabilities(capabilities);
    }
  }

  /**
   * Sends a resource list changed event to the client, if connected.
   */
  sendResourceListChanged() {
    if (this.isConnected()) {
      this.connection!.sendResourceListChanged();
    }
  }

  sendResourceUpdated(serverId: string, notification: ResourceUpdatedNotification) {
    if (this.isConnected()) {
      const serverContext = ServerManager.instance.getServerContext(serverId, this.userId);
      let newNotification = JSON.parse(JSON.stringify(notification));
      newNotification.params.uri = this.generateNewName(serverContext!.id, newNotification.params.uri);
      this.connection!.sendResourceUpdated(newNotification);
    }
  }

  /**
   * Sends a tool list changed event to the client, if connected.
   */
  sendToolListChanged() {
    if (this.isConnected()) {
      this.connection!.sendToolListChanged();
    }
  }

  /**
   * Sends a prompt list changed event to the client, if connected.
   */
  sendPromptListChanged() {
    if (this.isConnected()) {
      this.connection!.sendPromptListChanged();
    }
  }

  /**
   * Send notification
   */
  async sendNotification(notification: any): Promise<void> {

    if (this.isConnected()) {
      await this.connection!.notification(notification);
    } else {
      throw new Error('Connection not available or does not support notifications');
    }
  }

  /**
   * Close session, only disconnect this client connection, do not clean up global serverContext.
   * 1. Send disconnect notification (e.g., MCP SDK's disconnect/close method)
   * 2. Log
   * 3. Mark itself as Closed
   */
  async close(reason: DisconnectReason = DisconnectReason.CLIENT_DISCONNECT) {
    if (this.closeTriggered) {
      this.logger.debug({ reason }, 'ClientSession close already triggered');
      return;
    }
    this.closeTriggered = true;
    this.logger.info({ reason }, 'Closing ClientSession');
    
    try {
      // 1. Close upstream transport layer connection (if exists)
      if (this.connection) {
        try {
          this.logger.debug('Closing upstream connection for session');
          await this.connection.close();
        } catch (error) {
          this.logger.error({ error }, 'Error closing upstream connection for session');
        }
        this.connection = undefined;
      }

      // 2. Notify user online session changes
      try {
        socketNotifier.notifyOnlineSessions(this.userId);
      } catch (error: any) {
        this.logger.warn({ error: error.message, userId: this.userId }, 'Failed to notify online sessions after removal');
      }

      
      // 3. Clean up ProxySession reference
      this.proxySession = undefined;
      
      // 4. Log
      try {
        LogService.getInstance().enqueueLog({
          action: MCPEventLogType.SessionClose,
          userId: this.userId,
          sessionId: this.sessionId,
          error: reason, // Store reason in error field
        });
      } catch (error) {
        this.logger.error({ error }, 'Failed to log session close');
      }
      
      // 5. Mark itself as Closed  
      this.status = ClientSessionStatus.Closed;
      
      this.logger.info({ reason }, 'ClientSession closed successfully');
      
    } catch (error) {
      this.logger.error({ error, reason }, 'Error closing ClientSession');
      // Even if error occurs, mark as closed status
      this.status = ClientSessionStatus.Closed;
      throw error;
    }
  }
}
