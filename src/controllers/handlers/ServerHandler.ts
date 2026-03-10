import { SessionStore } from '../../mcp/core/SessionStore.js';
import { ServerManager } from '../../mcp/core/ServerManager.js';
import { ServerRepository } from '../../repositories/ServerRepository.js';
import { AuthUtils } from '../../utils/AuthUtils.js';
import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { Server } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { LogService } from '../../log/LogService.js';
import { MCPEventLogType, ServerAuthType, ServerCategory, ServerStatus } from '../../types/enums.js';
import { socketNotifier } from '../../socket/SocketNotifier.js';
import { ServerContext } from '../../mcp/core/ServerContext.js';
import UserRepository from '../../repositories/UserRepository.js';
import { ClientSession } from '../../mcp/core/ClientSession.js';
import { createLogger } from '../../logger/index.js';
import { CryptoService } from '../../security/CryptoService.js';
import { exchangeAuthorizationCode } from '../../mcp/oauth/exchange.js';
import { PETA_AUTH_CONFIG } from '../../config/petaAuthConfig.js';

/**
 * Server operation handler (2000-2999)
 */
export class ServerHandler {
  
  // Logger for ServerHandler
  private logger = createLogger('ServerHandler');

  constructor() {}

  /**
   * Start server (2001)
   */
  async handleStartServer(request: AdminRequest<any>, token: string): Promise<any> {
    const { targetId } = request.data;

    // Find server configuration
    let serverEntity = await ServerRepository.findByServerId(targetId);
    if (!serverEntity) {
      throw new AdminError(`Server ${targetId} not found`, AdminErrorCode.SERVER_NOT_FOUND);
    }

    serverEntity = await ServerRepository.update(targetId, { enabled: true });

    if (serverEntity.allowUserInput === true) {
      const servers = ServerManager.instance.getTemporaryServers(targetId);
      for (const server of servers) {
        server.serverEntity = serverEntity;
      }
      // Notify related users of server capability changes
      const changed = {
        toolsChanged: true,
        resourcesChanged: true,
        promptsChanged: true,
      }
      this.notifyUsersOfServerChange(targetId, SessionStore.instance.getSessionsUsingServer(targetId), 'server_started', changed);
      return null;
    }

    // Check if launchConfig is empty (template servers cannot be started directly)
    if (!serverEntity.launchConfig || serverEntity.launchConfig.trim() === '') {
      throw new AdminError(
        `Cannot start template server ${targetId}. Users must configure it first through client.`,
        AdminErrorCode.INVALID_REQUEST
      );
    }

    const serverContext = await ServerManager.instance.addServer(serverEntity, token);

    const changed = {
      toolsChanged: (serverContext.tools?.tools?.length ?? 0) > 0,
      resourcesChanged: (serverContext.resources?.resources?.length ?? 0) > 0,
      promptsChanged: (serverContext.prompts?.prompts?.length ?? 0) > 0
    };

    // Notify related users of server capability changes
    this.notifyUsersOfServerChange(targetId, SessionStore.instance.getSessionsUsingServer(targetId), 'server_started', changed);

    // Log audit event
    AuthUtils.logAuthEvent('server_started', undefined, targetId, true, JSON.stringify(changed));

    return null;
  }

  /**
   * Stop server (2002)
   */
  async handleStopServer(request: AdminRequest<any>): Promise<any> {
    const { targetId } = request.data;
    await this.stopServer(targetId);
    return null;
  }

  /**
   * Update server capabilities configuration (2003)
   */
  async handleUpdateServerCapabilities(request: AdminRequest<any>): Promise<any> {
    const { targetId, capabilities } = request.data;

    const entity = await ServerRepository.findByServerId(targetId);
    if (!entity) {
      throw new AdminError(`Server ${targetId} not found`, AdminErrorCode.SERVER_NOT_FOUND);
    }

    const updatedCapabilities = await this.getUpdatedCapabilities(capabilities, entity.capabilities);
    if (!updatedCapabilities) {
      return null;
    }

    await this.updateServerCapabilities(targetId, updatedCapabilities);

    // Log admin operation
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminServerEdit,
      requestParams: JSON.stringify({ targetId: targetId, capabilities: capabilities })
    });

    return null;
  }

  /**
   * Update server launch command (2004)
   */
  async handleUpdateServerLaunchCmd(request: AdminRequest<any>, token: string): Promise<any> {
    const { targetId, launchConfig } = request.data;
    await this.updateServerLaunchConfig(targetId, launchConfig, token);

    // Log admin operation
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminServerEdit,
      requestParams: JSON.stringify({ targetId: targetId })
    });

    return null;
  }

  /**
   * Connect all servers (2005)
   */
  async handleConnectAllServers(request: AdminRequest<any>, token: string): Promise<{ successServers: { serverId: string; serverName: string; proxyId: number }[]; failedServers: { serverId: string; serverName: string; proxyId: number }[] }> {
    const { successServers, failedServers } = await ServerManager.instance.connectAllServers(token);

    for (const server of successServers) {
      const serveContext = ServerManager.instance.getServerContext(server.serverId);
      this.notifyUsersOfServerChange(server.serverId, SessionStore.instance.getSessionsUsingServer(server.serverId), 'server_started', {
        toolsChanged: (serveContext?.tools?.tools?.length ?? 0) > 0,
        resourcesChanged: (serveContext?.resources?.resources?.length ?? 0) > 0,
        promptsChanged: (serveContext?.prompts?.prompts?.length ?? 0) > 0
      });
    }

    this.logger.debug({ successServers, failedServers }, 'Server batch start result');

    return {
      successServers: successServers,
      failedServers: failedServers
    };
  }

  /**
   * Create server (2010)
   */
  async handleCreateServer(request: AdminRequest<any>, token: string): Promise<any> {
    const { serverId, serverName, enabled, launchConfig, capabilities, createdAt, updatedAt, allowUserInput, proxyId, toolTmplId, authType, configTemplate, category, lazyStartEnabled, publicAccess, anonymousAccess, anonymousRateLimit } = request.data;

    if (!serverId) {
      throw new AdminError('Missing required field: serverId', AdminErrorCode.INVALID_REQUEST);
    }

    // Check if server already exists
    const existingServer = await ServerRepository.findByServerId(serverId);
    if (existingServer) {
      throw new AdminError('Server already exists', AdminErrorCode.SERVER_ALREADY_EXISTS);
    }

    // launchConfig must be a string
    if (typeof launchConfig !== 'string' || launchConfig.trim() === '' || launchConfig.trim() === '{}') {
      throw new AdminError('launchConfig must be a string and cannot be empty', AdminErrorCode.INVALID_REQUEST);
    }

    const authTypeValue = authType ?? ServerAuthType.ApiKey;
    if (typeof authTypeValue !== 'number' || !Object.values(ServerAuthType).includes(authTypeValue as ServerAuthType)) {
      throw new AdminError('Invalid authType', AdminErrorCode.INVALID_REQUEST);
    }

    // Validate consistency between allowUserInput and configTemplate
    const allowUserInputValue: boolean = allowUserInput ?? false;
    if (typeof allowUserInputValue !== 'boolean') {
      throw new AdminError('Invalid allowUserInput', AdminErrorCode.INVALID_REQUEST);
    }

    if (typeof category !== 'number' || !Object.values(ServerCategory).includes(category as ServerCategory)) {
      throw new AdminError('Invalid category', AdminErrorCode.INVALID_REQUEST);
    }

    if (anonymousRateLimit !== undefined && (typeof anonymousRateLimit !== 'number' || !Number.isInteger(anonymousRateLimit) || anonymousRateLimit < 1 || anonymousRateLimit > 1000)) {
      throw new AdminError('Invalid anonymousRateLimit: must be an integer between 1 and 1000 (per-source-IP, per-minute)', AdminErrorCode.INVALID_REQUEST);
    }

    const configTemplateInvalid = !configTemplate || configTemplate.trim() === '' || configTemplate.trim() === '{}';
    if ((allowUserInputValue === true || category === ServerCategory.Template || category === ServerCategory.RestApi || category === ServerCategory.Skills) && configTemplateInvalid) {
      throw new AdminError(
        'configTemplate is required for this server',
        AdminErrorCode.INVALID_REQUEST
      );
    }
    let usePetaOauthConfigValue = true;
    let configTemplateStr = configTemplate ?? null;
    let launchConfigStr = launchConfig;
    if (category === ServerCategory.Template) {
      const configTemplateValue = JSON.parse(configTemplate || '{}');
      const oauthConfig = configTemplateValue.oAuthConfig;
      if (oauthConfig && typeof oauthConfig.clientId === 'string' && oauthConfig.clientId.trim() !== '') {
        const decryptedLaunchConfig = await CryptoService.decryptDataFromString(launchConfig, token);
        const decryptedLaunchConfigValue = JSON.parse(decryptedLaunchConfig);
        const oauth = decryptedLaunchConfigValue.oauth;
        if (!oauth.clientId || oauth.clientId.trim() === '') {
          throw new AdminError('Missing required field: clientId', AdminErrorCode.INVALID_REQUEST);
        }

        const provider = AuthUtils.getOAuthProvider(authType);
        if (!provider) {
          throw new AdminError('Invalid OAuth provider', AdminErrorCode.INVALID_REQUEST);
        }

        // owner authentication flow
        if (allowUserInputValue === false) {
          if (oauth && oauth.code) {
            if (oauth.clientId === oauthConfig.clientId) {
              usePetaOauthConfigValue = true;
              // user peta client id
              const keyLength = Math.ceil(token.length * 0.5);
              const key = token.substring(keyLength) + serverId + allowUserInputValue.toString();
              const hashKey = await CryptoService.hash(key);

              const requestBody: {
                clientId: string;
                provider: string;
                key: string;
                code: string;
                redirectUri: string;
                tokenUrl?: string;
                codeVerifier?: string;
                scope?: string;
              } = {
                clientId: oauth.clientId,
                provider: provider,
                key: hashKey,
                code: oauth.code,
                redirectUri: oauth.redirectUri,
                codeVerifier: oauth.codeVerifier,
                scope: [ServerAuthType.ZendeskAuth].includes(authType) ? oauthConfig.scope : undefined
              };

              if ((provider === 'zendesk' || provider === 'canvas') && oauthConfig?.tokenUrl) {
                requestBody.tokenUrl = oauthConfig.tokenUrl;
              } else if (provider === 'zendesk' || provider === 'canvas') {
                throw new AdminError('Missing OAuth tokenUrl', AdminErrorCode.INVALID_REQUEST);
              }

              try {
                const response = await fetch(`${PETA_AUTH_CONFIG.BASE_URL}/v1/oauth/exchange`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify(requestBody),
                });

                const result = await response.json();
                if (!response.ok || !result?.accessToken || !result?.expiresAt) {
                  this.logger.warn({
                    status: response.status,
                    provider,
                    clientId: oauth.clientId.substring(0, 10) + '...' + oauth.clientId.substring(oauth.clientId.length - 10)
                  }, 'Peta OAuth exchange failed');
                  throw new AdminError('Failed to exchange OAuth code', AdminErrorCode.INVALID_REQUEST);
                }

                decryptedLaunchConfigValue.oauth = {
                  clientId: oauth.clientId,
                  key: hashKey,
                  accessToken: result.accessToken,
                  expiresAt: result.expiresAt
                };
                const encryptedData = await CryptoService.encryptData(JSON.stringify(decryptedLaunchConfigValue), token);
                launchConfigStr = JSON.stringify(encryptedData);

                this.logger.info({
                  serverId,
                  provider,
                  clientId: oauth.clientId.substring(0, 10) + '...' + oauth.clientId.substring(oauth.clientId.length - 10)
                }, 'Peta OAuth exchange succeeded');
              } catch (error) {
                this.logger.error({ err: error }, 'Error exchanging authorization code');
                throw new AdminError('Failed to exchange OAuth code', AdminErrorCode.INVALID_REQUEST);
              }
            } else {
              usePetaOauthConfigValue = false;
              // Use the client ID provided by the owner
              if (!oauth.clientSecret || oauth.clientSecret.trim() === '') {
                throw new AdminError('Invalid OAuth client secret', AdminErrorCode.INVALID_REQUEST);
              }

              const clientId = oauth.clientId;
              const clientSecret = oauth.clientSecret;

              try {
                const exchangeResult = await exchangeAuthorizationCode({
                  provider: provider,
                  tokenUrl: oauthConfig.tokenUrl,
                  clientId: clientId,
                  clientSecret: clientSecret,
                  code: oauth.code,
                  redirectUri: oauth.redirectUri,
                  codeVerifier: oauth.codeVerifier,
                  scope: [ServerAuthType.ZendeskAuth].includes(authType) ? oauthConfig.scope : undefined
                });

                if (exchangeResult.accessToken && exchangeResult.refreshToken) {
                  const expiresAt = exchangeResult.expiresAt ?? (Date.now() + 30 * 24 * 60 * 60 * 1000);
                  decryptedLaunchConfigValue.oauth = {
                    clientId: clientId,
                    clientSecret: clientSecret,
                    accessToken: exchangeResult.accessToken,
                    refreshToken: exchangeResult.refreshToken,
                    expiresAt: expiresAt
                  };
                  if ([ServerAuthType.ZendeskAuth].includes(authType)) {
                    decryptedLaunchConfigValue.oauth.tokenUrl = oauthConfig.tokenUrl;
                  }
                  if (authType === ServerAuthType.ZendeskAuth) {
                    decryptedLaunchConfigValue.oauth.scope = oauthConfig.scope;
                    if (exchangeResult.raw.refresh_token_expires_in && typeof exchangeResult.raw.refresh_token_expires_in === 'number') {
                      decryptedLaunchConfigValue.oauth.refreshTokenExpiresAt = Date.now() + exchangeResult.raw.refresh_token_expires_in * 1000;
                    }
                  }
                  const encryptedData = await CryptoService.encryptData(JSON.stringify(decryptedLaunchConfigValue), token);
                  launchConfigStr = JSON.stringify(encryptedData);
                } else {
                  throw new AdminError('Failed to exchange OAuth code', AdminErrorCode.INVALID_REQUEST);
                }
              } catch (error) {
                this.logger.error({ err: error }, 'Error exchanging authorization code');
                throw new AdminError('Failed to exchange OAuth code', AdminErrorCode.INVALID_REQUEST);
              }
            }
          } else {
            throw new AdminError('Invalid OAuth code', AdminErrorCode.INVALID_REQUEST);
          }
        } else {
          if (oauth.clientId !== oauthConfig.userClientId) {
            usePetaOauthConfigValue = false;
            // Use the client ID provided by the owner
            if (!oauth.clientSecret || oauth.clientSecret.trim() === '') {
              throw new AdminError('Invalid OAuth client secret', AdminErrorCode.INVALID_REQUEST);
            }
          }
          const key = process.env.JWT_SECRET;
          if (!key) {
            throw new AdminError('JWT_SECRET environment variable is required', AdminErrorCode.INVALID_REQUEST);
          }
          const encryptedData = await CryptoService.encryptData(decryptedLaunchConfig, key);
          launchConfigStr = JSON.stringify(encryptedData);
          configTemplateValue.oAuthConfig.deskClientId = oauth.clientId;
          configTemplateStr = JSON.stringify(configTemplateValue);
        }
      }
    }

    const server = await ServerRepository.create({
      serverId,
      serverName: serverName ?? '',
      enabled: enabled ?? true,
      launchConfig: launchConfigStr,
      capabilities: JSON.stringify({tools: {}, resources: {}, prompts: {}}),
      createdAt: createdAt ?? Math.floor(Date.now() / 1000),
      updatedAt: updatedAt ?? Math.floor(Date.now() / 1000),
      allowUserInput: allowUserInputValue,
      proxyId: proxyId ?? 0,
      toolTmplId: toolTmplId ?? null,
      authType: authTypeValue,
      configTemplate: configTemplateStr,
      category: category,
      lazyStartEnabled: lazyStartEnabled,
      publicAccess: publicAccess ?? false,
      usePetaOauthConfig: usePetaOauthConfigValue,
      anonymousAccess: anonymousAccess ?? false,
      anonymousRateLimit: anonymousRateLimit ?? 10
    });

    // Log admin operation
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminServerCreate,
      requestParams: JSON.stringify({ serverId: serverId, authType: authType })
    });

    return { server : server };
  }

  /**
   * Query server list (2011)
   */
  async handleGetServers(request: AdminRequest<any>): Promise<any> {
    const { proxyId, enabled, serverId } = request.data || {};

    // Select fields to exclude: transportType, cachedTools, cachedResources, cachedResourceTemplates, cachedPrompts
    const select = {
      serverId: true,
      serverName: true,
      enabled: true,
      launchConfig: true,
      capabilities: true,
      createdAt: true,
      updatedAt: true,
      allowUserInput: true,
      configTemplate: true,
      proxyId: true,
      toolTmplId: true,
      authType: true,
      category: true,
      lazyStartEnabled: true,
      publicAccess: true,
      usePetaOauthConfig: true,
      anonymousAccess: true,
      anonymousRateLimit: true
    };

    // Exact query for specific server
    if (serverId) {
      const server = await prisma.server.findUnique({
        where: { serverId },
        select
      });
      if (server && server.category === ServerCategory.Template) {
        server.configTemplate = null;
      }
      return { servers: server ? [server] : [] };
    }

    // Build query conditions
    const where: any = {};
    if (proxyId !== undefined) {
      where.proxyId = proxyId;
    }
    if (enabled !== undefined) {
      where.enabled = enabled;
    }

    const servers = await prisma.server.findMany({ where, select });
    for (const server of servers) {
      if (server.category === ServerCategory.Template) {
        server.configTemplate = null;
      }
    }
    return { servers : servers };
  }

  /**
   * Update server (2012)
   */
  async handleUpdateServer(request: AdminRequest<any>, token: string): Promise<any> {
    const { serverId, serverName, launchConfig, capabilities, enabled, allowUserInput, configTemplate, lazyStartEnabled, publicAccess, anonymousAccess, anonymousRateLimit } = request.data;

    if (!serverId) {
      throw new AdminError('Missing required field: serverId', AdminErrorCode.INVALID_REQUEST);
    }

    // Check if server exists
    const existingServer = await ServerRepository.findByServerId(serverId);
    if (!existingServer) {
      throw new AdminError('Server not found', AdminErrorCode.SERVER_NOT_FOUND);
    }

    // Prevent modification of allowUserInput and configTemplate
    if (allowUserInput !== undefined && allowUserInput !== existingServer.allowUserInput) {
      throw new AdminError(
        'allowUserInput field is immutable after server creation',
        AdminErrorCode.INVALID_REQUEST
      );
    }
    const isRestApiOrCustomRemote = existingServer.category === ServerCategory.RestApi || existingServer.category === ServerCategory.CustomRemote;
    if (!isRestApiOrCustomRemote && configTemplate !== undefined) {
      throw new AdminError(
        'configTemplate field is immutable after server creation',
        AdminErrorCode.INVALID_REQUEST
      );
    }

    // Prepare update data
    const updateData: any = {};
    if (serverName !== undefined) updateData.serverName = serverName;
    if (launchConfig !== undefined) {
      updateData.launchConfig = typeof launchConfig === 'string' ? launchConfig : JSON.stringify(launchConfig);
      if (updateData.launchConfig !== existingServer.launchConfig) {
        if (!(existingServer.category === ServerCategory.Template && existingServer.allowUserInput === true && existingServer.authType === ServerAuthType.ApiKey)) {
          throw new AdminError('This type of server does not allow modification of the launch configuration.', AdminErrorCode.INVALID_REQUEST);
        }
      }
    }
    if (isRestApiOrCustomRemote && configTemplate !== undefined && configTemplate !== null && configTemplate.trim() !== '' && configTemplate.trim() !== existingServer.configTemplate) {
      updateData.configTemplate = configTemplate;
    }
    if (lazyStartEnabled !== undefined && lazyStartEnabled !== existingServer.lazyStartEnabled) {
      updateData.lazyStartEnabled = lazyStartEnabled;
    }
    if (publicAccess !== undefined && publicAccess !== existingServer.publicAccess) {
      updateData.publicAccess = publicAccess;
    }
    if (anonymousAccess !== undefined && anonymousAccess !== existingServer.anonymousAccess) {
      updateData.anonymousAccess = anonymousAccess;
    }
    if (anonymousRateLimit !== undefined) {
      if (typeof anonymousRateLimit !== 'number' || !Number.isInteger(anonymousRateLimit) || anonymousRateLimit < 1 || anonymousRateLimit > 1000) {
        throw new AdminError('Invalid anonymousRateLimit: must be an integer between 1 and 1000 (per-source-IP, per-minute)', AdminErrorCode.INVALID_REQUEST);
      }
      if (anonymousRateLimit !== existingServer.anonymousRateLimit) {
        updateData.anonymousRateLimit = anonymousRateLimit;
      }
    }

    const updatedCapabilities = await this.getUpdatedCapabilities(capabilities, existingServer.capabilities);
    if (updatedCapabilities) {
      updateData.capabilities = updatedCapabilities;
    }
    updateData.enabled = enabled ?? existingServer.enabled;

    // Check if publicAccess will change
    const willHandlePublicAccessChange = publicAccess !== undefined && publicAccess !== existingServer.publicAccess;

    let server = await ServerRepository.update(serverId, updateData);

    let serverContext: ServerContext | undefined;
    const affectedSessions = SessionStore.instance.getSessionsUsingServer(serverId);
    if (existingServer.enabled === true && updateData.enabled === true) {
      // Server remains enabled
      if (updateData.capabilities !== undefined && updateData.launchConfig !== undefined) {
        await this.updateServerLaunchConfig(serverId, updateData.launchConfig, token);
      } else if (updateData.capabilities !== undefined) {
        await this.updateServerCapabilities(serverId, updateData.capabilities);
        serverContext = await this.updateLazyStartEnabled(existingServer, server, updateData.lazyStartEnabled);
      } else if (updateData.launchConfig !== undefined) {
        await this.updateServerLaunchConfig(serverId, updateData.launchConfig, token);
      } else if (updateData.lazyStartEnabled !== undefined) {
        serverContext = await this.updateLazyStartEnabled(existingServer, server, updateData.lazyStartEnabled);
      }
      if (existingServer.allowUserInput) {
        const temporaryServers = ServerManager.instance.getTemporaryServers(serverId);
        for (const temporaryServer of temporaryServers) {
          temporaryServer.serverEntity = server;
          if (willHandlePublicAccessChange) {
            serverContext = temporaryServer;
          }
        }
      } else {
        const context = ServerManager.instance.getServerContext(serverId);
        serverContext = context;
        if (context) {
          context.serverEntity = server;
          if (willHandlePublicAccessChange || updateData.anonymousAccess) {
            serverContext = context;
          }
        }
      }
    } else if (existingServer.enabled === true && updateData.enabled === false) {
      // Server changed from enabled to disabled
      if (existingServer.allowUserInput) {
        const temporaryServers = ServerManager.instance.getTemporaryServers(serverId);
        if (temporaryServers.length > 0) {
          serverContext = temporaryServers[0];
        }
        await ServerManager.instance.closeAllTemporaryServersByTemplate(serverId);
      } else {
        serverContext = await ServerManager.instance.removeServer(serverId);
      }

    } else if (existingServer.enabled === false && updateData.enabled === true) {
      // Server changed from disabled to enabled
      serverContext = await ServerManager.instance.addServer(serverId, token);
    }

    if (serverContext) {
      const changed = {
        toolsChanged: (serverContext?.tools?.tools?.length ?? 0) > 0,
        resourcesChanged: (serverContext?.resources?.resources?.length ?? 0) > 0,
        promptsChanged: (serverContext?.prompts?.prompts?.length ?? 0) > 0
      };
      this.notifyUsersOfServerChange(serverId, affectedSessions, 'server_updated', changed);
    }
    // Log admin operation
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminServerEdit,
      requestParams: JSON.stringify({ serverId: serverId })
    });

    server = structuredClone(server);
    if (server.category !== ServerCategory.RestApi) {
      server.configTemplate = null;
    }
    server.transportType = null;
    server.cachedTools = null;
    server.cachedResources = null;
    server.cachedResourceTemplates = null;
    server.cachedPrompts = null;

    return { server: server };
  }

  /**
   * Delete server (2013)
   */
  async handleDeleteServer(request: AdminRequest<any>): Promise<any> {
    const { serverId } = request.data;

    if (!serverId) {
      throw new AdminError('Missing required field: serverId', AdminErrorCode.INVALID_REQUEST);
    }

    // If it's a template server (allowUserInput=true), clean up all user configurations
    const server = await ServerRepository.findByServerId(serverId);
    if (!server) {
      throw new AdminError('Server not found', AdminErrorCode.SERVER_NOT_FOUND);
    }
    if (server.allowUserInput) {
      // 1. Close all temporary servers based on this template
      await ServerManager.instance.closeAllTemporaryServersByTemplate(serverId);

      // 2. Clean up all users' launchConfigs and userPreferences
      await UserRepository.removeServerFromAllUsers(serverId);

      this.logger.info({ serverId }, 'Cleaned up all user configurations for template server');
    }

    const affectedSessions = SessionStore.instance.getSessionsUsingServer(serverId);
    await ServerRepository.delete(serverId);
    

    // Log admin operation
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminServerDelete,
      requestParams: JSON.stringify({ serverId: serverId })
    });

    // Notify all related users of server capability changes
    let changed: { toolsChanged: boolean; resourcesChanged: boolean; promptsChanged: boolean };
    if (server.allowUserInput) {
      changed = {
        toolsChanged: true,
        resourcesChanged: true,
        promptsChanged: true
      };
    } else {
      const serverContext = await ServerManager.instance.removeServer(serverId);
      changed = {
        toolsChanged: (serverContext?.tools?.tools?.length ?? 0) > 0,
        resourcesChanged: (serverContext?.resources?.resources?.length ?? 0) > 0,
        promptsChanged: (serverContext?.prompts?.prompts?.length ?? 0) > 0
      };
    }

    this.notifyUsersOfServerChange(serverId, affectedSessions, 'server_deleted', changed);

    return { message: 'Server deleted successfully' };
  }

  /**
   * Delete servers by proxy in bulk (2014)
   */
  async handleDeleteServersByProxy(request: AdminRequest<any>): Promise<any> {
    const { proxyId } = request.data;

    if (proxyId === undefined) {
      throw new AdminError('Missing required field: proxyId', AdminErrorCode.INVALID_REQUEST);
    }

    const servers = await ServerRepository.findByProxyId(proxyId);
    for (const server of servers) {
      const affectedSessions = SessionStore.instance.getSessionsUsingServer(server.serverId);
      const serverContext = await ServerManager.instance.removeServer(server.serverId);
      if (serverContext) {
        const changed = {
          toolsChanged: (serverContext?.tools?.tools?.length ?? 0) > 0,
          resourcesChanged: (serverContext?.resources?.resources?.length ?? 0) > 0,
          promptsChanged: (serverContext?.prompts?.prompts?.length ?? 0) > 0
        };
        this.notifyUsersOfServerChange(server.serverId, affectedSessions, 'server_deleted', changed);
      } else if (server.allowUserInput) {
        await ServerManager.instance.closeAllTemporaryServersByTemplate(server.serverId);
        const changed = {
          toolsChanged: true,
          resourcesChanged: true,
          promptsChanged: true
        };
        this.notifyUsersOfServerChange(server.serverId, affectedSessions, 'server_deleted', changed);
      }
    }

    const count = await ServerRepository.deleteByProxyId(proxyId);
    return { deletedCount: count };
  }

  /**
   * Count servers (2015)
   */
  async handleCountServers(request: AdminRequest<any>): Promise<any> {
    const count = await ServerRepository.countAll();
    return { count : count };
  }

  // ==================== Helper Methods ====================

  /**
   * Notify related users of server changes
   */
  private async notifyUsersOfServerChange(serverId: string, affectedSessions: ClientSession[], changeType: string, changed: { toolsChanged: boolean, resourcesChanged: boolean, promptsChanged: boolean }): Promise<void> {
    try {
      this.logger.debug({ serverId, changeType, changed }, 'Notifying users of server change');

      socketNotifier.notifyUserPermissionChangedByServer(serverId);

      if (affectedSessions.length === 0) {
        this.logger.debug({ serverId }, 'No affected sessions for server');
        return;
      }

      if (!changed.toolsChanged && !changed.resourcesChanged && !changed.promptsChanged) {
        return;
      }

      // Send capability change notification for each session
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
        } catch (error) {
          this.logger.error({ error, sessionId: session.sessionId }, 'Failed to notify session');
        }
      }

      this.logger.info({ serverId, changeType, sessionCount: affectedSessions.length }, 'Notified sessions about server change');
    } catch (error) {
      this.logger.error({ error, serverId, changeType }, 'Error notifying users of server change');
    }
  }

  /**
   * Stop server
   */
  private async stopServer(targetId: string): Promise<void> {

    const server = await ServerRepository.findByServerId(targetId);
    if (!server) {
      throw new AdminError(`Server ${targetId} not found`, AdminErrorCode.SERVER_NOT_FOUND);
    }
    const affectedSessions = SessionStore.instance.getSessionsUsingServer(targetId);
    let changed: { toolsChanged: boolean; resourcesChanged: boolean; promptsChanged: boolean };
    if (server.allowUserInput) {
      await ServerManager.instance.closeAllTemporaryServersByTemplate(targetId);
      changed = {
        toolsChanged: true,
        resourcesChanged: true,
        promptsChanged: true
      };
    } else {
      const serverContext = await ServerManager.instance.removeServer(targetId);
      changed = {
        toolsChanged: (serverContext?.tools?.tools?.length ?? 0) > 0,
        resourcesChanged: (serverContext?.resources?.resources?.length ?? 0) > 0,
        promptsChanged: (serverContext?.prompts?.prompts?.length ?? 0) > 0
      };
    }

    await ServerRepository.update(targetId, { enabled: false });
    this.notifyUsersOfServerChange(targetId, affectedSessions, 'server_stopped', changed);
    return;
  }

  private async getUpdatedCapabilities(newCapabilities: any, oldCapabilities: string): Promise<string | undefined> {
    if (newCapabilities) {

      const newCapabilitiesString = typeof newCapabilities === 'string' ? newCapabilities : JSON.stringify(newCapabilities);
      const oldCapabilitiesString = typeof oldCapabilities === 'string' ? oldCapabilities : JSON.stringify(oldCapabilities);
      if (newCapabilitiesString === oldCapabilitiesString) {
        return undefined;
      }
      
      const newCapabilitiesObj = typeof newCapabilities === 'string' ? JSON.parse(newCapabilities) : newCapabilities;
      const oldCapabilitiesObj = oldCapabilities ? JSON.parse(oldCapabilities) : {};
      let changed = false;
      if (newCapabilitiesObj.tools && Object.keys(newCapabilitiesObj.tools).length > 0) {
        for (const [toolName, toolConfig] of Object.entries(newCapabilitiesObj.tools)) {
          oldCapabilitiesObj.tools[toolName] = toolConfig;
        }
        changed = true;
      }
      if (newCapabilitiesObj.resources && Object.keys(newCapabilitiesObj.resources).length > 0) {
        for (const [resourceName, resourceConfig] of Object.entries(newCapabilitiesObj.resources)) {
          oldCapabilitiesObj.resources[resourceName] = resourceConfig;
        }
        changed = true;
      }
      if (newCapabilitiesObj.prompts && Object.keys(newCapabilitiesObj.prompts).length > 0) {
        for (const [promptName, promptConfig] of Object.entries(newCapabilitiesObj.prompts)) {
          oldCapabilitiesObj.prompts[promptName] = promptConfig;
        }
        changed = true;
      }
      if (changed) {
        return JSON.stringify(oldCapabilitiesObj);
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  }

  /**
   * Update server capabilities
   */
  private async updateServerCapabilities(targetId: string, capabilities: string): Promise<void> {

    await ServerRepository.updateCapabilities(targetId, capabilities);
    const changed = await ServerManager.instance.updateServerCapabilitiesConfig(targetId, capabilities);
    this.notifyUsersOfServerChange(targetId, SessionStore.instance.getSessionsUsingServer(targetId), 'capabilities_updated', changed);
  }

  private async updateServerLaunchConfig(targetId: string, launchConfig: string, token: string): Promise<void> {
    const entity = await ServerRepository.findByServerId(targetId);

    if (!entity) {
      throw new AdminError(`Server ${targetId} not found`, AdminErrorCode.SERVER_NOT_FOUND);
    }

    if (entity.allowUserInput && !(entity.category === ServerCategory.RestApi || entity.category === ServerCategory.CustomRemote)) {
      throw new AdminError(`Server ${targetId} is a template server and cannot be updated`, AdminErrorCode.INVALID_REQUEST);
    }

    let serverContext = ServerManager.instance.getServerContext(targetId);

    const oldLaunchConfig = entity.launchConfig;
    if (launchConfig === oldLaunchConfig) {
      if (entity.category !== ServerCategory.RestApi) {
        return;
      }
      
      if (entity.configTemplate === serverContext?.serverEntity.configTemplate) {
        return;
      }
    }

    const newServer = await ServerRepository.updateLaunchConfig(targetId, launchConfig);

    if (!serverContext) {
      return;
    }
    await ServerManager.instance.reconnectServer(newServer, token);
    await this.notifyUsersOfServerChangeByServerContext(serverContext, SessionStore.instance.getSessionsUsingServer(targetId), 'launch_cmd_updated');
  }

  private async updateLazyStartEnabled(existingServer: Server, newServer: Server, lazyStartEnabled?: boolean | undefined): Promise<ServerContext | undefined> {

    if (lazyStartEnabled === undefined) {
      return undefined;
    }
    if (lazyStartEnabled === existingServer.lazyStartEnabled) {
      return undefined;
    }

    const serverId = existingServer.serverId;
    let serverContext: ServerContext | undefined;

    if (existingServer.allowUserInput) {
      const temporaryServers = ServerManager.instance.getTemporaryServers(serverId);

      for (const temporaryServer of temporaryServers) {
        temporaryServer.serverEntity = newServer;
        if (lazyStartEnabled === false && existingServer.lazyStartEnabled === true) {
          if (temporaryServer.status === ServerStatus.Sleeping && ServerManager.instance.getOwnerToken()) {
            ServerManager.instance.reconnectTemporaryServer(temporaryServer.serverEntity, temporaryServer.userId!, temporaryServer.userToken!);
          }
        }
      }
    } else {
      const context = ServerManager.instance.getServerContext(serverId);
      if (context) {
        context.serverEntity = newServer;
        if (lazyStartEnabled === false && existingServer.lazyStartEnabled === true) {
          if (context.status === ServerStatus.Sleeping && ServerManager.instance.getOwnerToken()) {
            ServerManager.instance.reconnectServer(context.serverEntity, ServerManager.instance.getOwnerToken());
          }
        }
      } else {
        if (lazyStartEnabled === true && existingServer.lazyStartEnabled === false) {
          serverContext = ServerManager.instance.addSleepingServer(existingServer);
        }
      }
    }

    return serverContext;
  }

  private async notifyUsersOfServerChangeByServerContext(serverContext: ServerContext | undefined, affectedSessions: ClientSession[], changeType: string): Promise<void> {
    if (!serverContext) return;
    const changed = {
      toolsChanged: (serverContext?.tools?.tools?.length ?? 0) > 0,
      resourcesChanged: (serverContext?.resources?.resources?.length ?? 0) > 0,
      promptsChanged: (serverContext?.prompts?.prompts?.length ?? 0) > 0
    };
    this.notifyUsersOfServerChange(serverContext.serverID, affectedSessions, changeType, changed);
  }
}
