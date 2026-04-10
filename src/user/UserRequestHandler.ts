/**
 * UserRequestHandler - Core business logic layer (transport-agnostic)
 *
 * This module handles all user-related business operations independently of
 * the transport protocol (HTTP API or Socket.IO). Both UserController (HTTP)
 * and SocketService (Socket) call methods in this handler.
 *
 * Architecture:
 * - Layer 1 (this file): Business logic (transport-agnostic)
 * - Layer 2a: Socket.IO communication layer
 * - Layer 2b: HTTP API layer
 */

import { SessionStore } from '../mcp/core/SessionStore.js';
import { McpServerCapabilities } from '../mcp/types/mcp.js';
import { createLogger } from '../logger/index.js';
import { socketNotifier } from '../socket/SocketNotifier.js';
import { DangerLevel, ServerAuthType, ServerCategory } from '../types/enums.js';
import { EncryptedData } from '../security/CryptoService.js';
import {
  UserError,
  UserErrorCode,
  SessionData,
  ConfigureServerRequest,
  ConfigureServerResponseData,
  UnconfigureServerRequest,
  UnconfigureServerResponseData,
} from './types.js';
import { AuthUtils } from '../utils/AuthUtils.js';
import { exchangeAuthorizationCode } from '../mcp/oauth/exchange.js';
import { PETA_AUTH_CONFIG } from '../config/petaAuthConfig.js';
import {
  fetchIntercomTokenMetadata,
  INTERCOM_FAKE_REFRESH_TOKEN,
} from '../mcp/auth/IntercomTokenHelper.js';

export class UserRequestHandler {
  private logger = createLogger('UserRequestHandler');

  static instance: UserRequestHandler = new UserRequestHandler();
  static getInstance(): UserRequestHandler {
    return UserRequestHandler.instance;
  }

  private constructor() {}

  /**
   * Handle GET_CAPABILITIES: Get user's capability configuration
   *
   * @param userId - User ID
   * @returns Promise<McpServerCapabilities> - Complete capability configuration
   *
   */
  async handleGetCapabilities(userId: string): Promise<McpServerCapabilities> {
    this.logger.debug({ userId }, 'Getting user capabilities');

    // Import dynamically to avoid circular dependency
    const { CapabilitiesService } = await import('../mcp/services/CapabilitiesService.js');
    const capabilitiesService = CapabilitiesService.getInstance();
    const capabilities = await capabilitiesService.getUserCapabilities(userId);

    this.logger.debug({ userId }, 'User capabilities retrieved successfully');
    return capabilities;
  }

  /**
   * Handle SET_CAPABILITIES: Set user's capability configuration
   *
   * @param userId - User ID
   * @param submittedCapabilities - User-submitted capability configuration
   * @returns Promise<void>
   *
   */
  async handleSetCapabilities(
    userId: string,
    submittedCapabilities: McpServerCapabilities,
  ): Promise<void> {
    this.logger.debug({ userId }, 'Setting user capabilities');

    // Import dependencies dynamically
    const UserRepository = (await import('../repositories/UserRepository.js')).default;

    // 1. Get current complete capabilities (for validation)
    const currentCapabilities = await this.handleGetCapabilities(userId);

    // 2. Extract and validate enabled fields (only save enabled for existing items)
    const validatedPreferences = this.extractEnabledFields(
      submittedCapabilities,
      currentCapabilities,
    );

    // 3. Update database
    await UserRepository.update(userId, {
      userPreferences: JSON.stringify(validatedPreferences),
    });

    this.logger.info({ userId }, 'User preferences updated');

    // 4. Notify all active sessions
    await SessionStore.instance.updateUserPreferences(userId);
  }

  /**
   * Extract and validate enabled fields
   *
   * Only save enabled status for server/tool/resource/prompt that exist in current.
   * Ignore other fields and non-existent items.
   *
   * @param submitted - User submitted complete configuration
   * @param current - Current actual complete configuration (for validation)
   * @returns Validated user_preferences (only contains enabled fields)
   *
   */
  private extractEnabledFields(
    submitted: McpServerCapabilities,
    current: McpServerCapabilities,
  ): McpServerCapabilities {
    // Start with a deep copy of current so non-overridable fields stay intact
    const merged: McpServerCapabilities = JSON.parse(JSON.stringify(current));

    for (const [serverId, currentServer] of Object.entries(current)) {
      const submittedServer = submitted[serverId] as any;
      if (!submittedServer) {
        continue; // no updates for this server, keep current as-is
      }

      if (typeof submittedServer.enabled === 'boolean') {
        merged[serverId].enabled = submittedServer.enabled;
      }

      // Tools: enabled + dangerLevel
      for (const [toolName, currentTool] of Object.entries(currentServer.tools || {})) {
        const submittedTool = submittedServer.tools?.[toolName];
        if (!submittedTool) continue;

        if (typeof submittedTool.enabled === 'boolean') {
          merged[serverId].tools[toolName].enabled = submittedTool.enabled;
        }

        if (submittedTool.dangerLevel !== undefined) {
          Object.keys(DangerLevel).includes(submittedTool.dangerLevel.toString());
          if (this.isValidDangerLevel(submittedTool.dangerLevel)) {
            merged[serverId].tools[toolName].dangerLevel = submittedTool.dangerLevel;
          } else {
            this.logger.debug(
              { serverId, toolName, dangerLevel: submittedTool.dangerLevel },
              'Skipping invalid dangerLevel',
            );
          }
        }
      }

      // Resources: only enabled
      for (const [resourceName] of Object.entries(currentServer.resources || {})) {
        const submittedResource = submittedServer.resources?.[resourceName];
        if (!submittedResource) continue;

        if (typeof submittedResource.enabled === 'boolean') {
          merged[serverId].resources[resourceName].enabled = submittedResource.enabled;
        }
      }

      // Prompts: only enabled
      for (const [promptName] of Object.entries(currentServer.prompts || {})) {
        const submittedPrompt = submittedServer.prompts?.[promptName];
        if (!submittedPrompt) continue;

        if (typeof submittedPrompt.enabled === 'boolean') {
          merged[serverId].prompts[promptName].enabled = submittedPrompt.enabled;
        }
      }
    }

    return merged;
  }

  private isValidDangerLevel(value: any): value is DangerLevel {
    return Object.values(DangerLevel)
      .filter((v): v is number => typeof v === 'number')
      .includes(value);
  }

  /**
   * Handle CONFIGURE_SERVER: Configure a server for user
   *
   * @param userId - User ID
   * @param userToken - User token (for encrypting launchConfig)
   * @param data - Configuration request data
   * @returns Promise<ConfigureServerResponseData> - Configuration result
   *
   */
  async handleConfigureServer(
    userId: string,
    userToken: string,
    data: ConfigureServerRequest,
  ): Promise<ConfigureServerResponseData> {
    const { serverId, authConf, restfulApiAuth, remoteAuth, stdioEnv } = data;
    this.logger.debug({ userId, serverId }, 'Configuring server for user');

    // Import dependencies dynamically
    const { ServerRepository } = await import('../repositories/ServerRepository.js');
    const UserRepository = (await import('../repositories/UserRepository.js')).default;
    const { CryptoService } = await import('../security/CryptoService.js');
    const { ServerManager } = await import('../mcp/core/ServerManager.js');

    // 1. Validate server exists and allowUserInput=true and enabled=true
    const server = await ServerRepository.findByServerId(serverId);

    if (!server) {
      throw new UserError(`Server ${serverId} not found`, UserErrorCode.SERVER_NOT_FOUND);
    }

    if (!server.allowUserInput) {
      throw new UserError(
        `Server ${serverId} does not allow user input`,
        UserErrorCode.SERVER_NOT_ALLOW_USER_INPUT,
      );
    }

    if (!server.enabled) {
      throw new UserError(`Server ${serverId} is disabled`, UserErrorCode.SERVER_DISABLED);
    }

    if (!server.configTemplate) {
      throw new UserError(
        `Server ${serverId} does not have a configuration template`,
        UserErrorCode.SERVER_NO_CONFIG_TEMPLATE,
      );
    }

    // 2. Save to user.launchConfigs
    const user = await UserRepository.findById(userId);
    if (!user) {
      throw new UserError(`User ${userId} not found`, UserErrorCode.INTERNAL_ERROR);
    }

    // 3. Assemble and encrypt launchConfig
    let launchConfig: any;
    switch (server.category) {
      case ServerCategory.Template:
        if (authConf === undefined || authConf === null || authConf.length === 0) {
          throw new UserError(
            `authConf is required and cannot be empty`,
            UserErrorCode.SERVER_CONFIG_INVALID,
          );
        }
        // 1. Parse configTemplate
        let template: Record<string, any>;
        try {
          template = JSON.parse(server.configTemplate);
        } catch (error: any) {
          throw new UserError(
            `Invalid configTemplate JSON: ${error.message}`,
            UserErrorCode.SERVER_CONFIG_INVALID,
          );
        }

        const oauthConfig = template.oAuthConfig;
        if (oauthConfig && oauthConfig.deskClientId) {
          const key = process.env.JWT_SECRET;
          if (!key) {
            throw new UserError(
              'JWT_SECRET environment variable is not configured',
              UserErrorCode.INTERNAL_ERROR,
            );
          }
          const decryptedLaunchConfig = await CryptoService.decryptDataFromString(
            server.launchConfig,
            key,
          );
          const decryptedLaunchConfigValue = JSON.parse(decryptedLaunchConfig);
          const oauth = decryptedLaunchConfigValue.oauth;
          // 将 authConf 转换为 Record<string, any> key-value pairs key 是 item.key，value 是 item.value 和 item.dataType
          const authConfValue: Record<string, any> = authConf.reduce(
            (acc: Record<string, any>, item: any) => {
              acc[item.key] = { value: item.value, dataType: item.dataType };
              return acc;
            },
            {},
          );
          
          const oauthCode = authConfValue.YOUR_OAUTH_CODE?.value;
          const oauthRedirectUrl = authConfValue.YOUR_OAUTH_REDIRECT_URL?.value;
          const oauthCodeVerifierValue = authConfValue.YOUR_OAUTH_PKCE_VERIFIER?.value;
          const oauthCodeVerifier =
            typeof oauthCodeVerifierValue === 'string' && oauthCodeVerifierValue !== ''
              ? oauthCodeVerifierValue
              : undefined;

          if (typeof oauthCode !== 'string' || oauthCode === '') {
            throw new UserError(
              `code is required and cannot be empty`,
              UserErrorCode.SERVER_CONFIG_INVALID,
            );
          }
          if (typeof oauthRedirectUrl !== 'string' || oauthRedirectUrl === '') {
            throw new UserError(
              `redirectUri is required and cannot be empty`,
              UserErrorCode.SERVER_CONFIG_INVALID,
            );
          }
          // Use the client ID provided by the owner
          const provider = AuthUtils.getOAuthProvider(server.authType);
          if (!provider) {
            throw new UserError('Invalid OAuth provider', UserErrorCode.SERVER_CONFIG_INVALID);
          }

          if (
            server.authType !== ServerAuthType.IntercomAuth &&
            oauth.clientId === oauthConfig.userClientId
          ) {
            // user peta client id
            const keyLength = Math.ceil(userToken.length * 0.5);
            const key = userToken.substring(keyLength) + serverId + true.toString();
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
              code: oauthCode,
              redirectUri: oauthRedirectUrl,
              codeVerifier: oauthCodeVerifier,
              scope: [ServerAuthType.ZendeskAuth].includes(server.authType)
                ? oauthConfig.scope
                : undefined,
            };

            if ((provider === 'zendesk' || provider === 'canvas') && oauthConfig?.tokenUrl) {
              requestBody.tokenUrl = oauthConfig.tokenUrl;
            } else if (provider === 'zendesk' || provider === 'canvas') {
              throw new UserError('Missing OAuth tokenUrl', UserErrorCode.SERVER_CONFIG_INVALID);
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
                this.logger.warn(
                  {
                    status: response.status,
                    provider,
                    clientId:
                      oauth.clientId.substring(0, 10) +
                      '...' +
                      oauth.clientId.substring(oauth.clientId.length - 10),
                  },
                  'Peta OAuth exchange failed',
                );
                throw new UserError(
                  'Failed to exchange OAuth code',
                  UserErrorCode.SERVER_CONFIG_INVALID,
                );
              }

              decryptedLaunchConfigValue.oauth = {
                clientId: oauth.clientId,
                key: hashKey,
                accessToken: result.accessToken,
                expiresAt: result.expiresAt,
              };
              launchConfig = decryptedLaunchConfigValue;

              this.logger.info(
                {
                  serverId,
                  provider,
                  clientId:
                    oauth.clientId.substring(0, 10) +
                    '...' +
                    oauth.clientId.substring(oauth.clientId.length - 10),
                },
                'Peta OAuth exchange succeeded',
              );
            } catch (error) {
              this.logger.error({ err: error }, 'Error exchanging authorization code');
              throw new UserError(
                'Failed to exchange OAuth code',
                UserErrorCode.SERVER_CONFIG_INVALID,
              );
            }
          } else {
            try {
              const exchangeResult = await exchangeAuthorizationCode({
                provider: provider,
                tokenUrl: oauthConfig.tokenUrl,
                clientId: oauth.clientId,
                clientSecret: oauth.clientSecret,
                code: oauthCode,
                redirectUri: oauthRedirectUrl,
                codeVerifier: oauthCodeVerifier,
                scope: [ServerAuthType.ZendeskAuth].includes(server.authType)
                  ? oauthConfig.scope
                  : undefined,
              });

              if (
                server.authType === ServerAuthType.IntercomAuth &&
                !exchangeResult.refreshToken
              ) {
                exchangeResult.refreshToken = INTERCOM_FAKE_REFRESH_TOKEN;
              }

              if (exchangeResult.accessToken && exchangeResult.refreshToken) {
                const expiresAt = exchangeResult.expiresAt ?? Date.now() + 30 * 24 * 60 * 60 * 1000;

                decryptedLaunchConfigValue.oauth = {
                  clientId: oauth.clientId,
                  clientSecret: oauth.clientSecret,
                  accessToken: exchangeResult.accessToken,
                  refreshToken: exchangeResult.refreshToken,
                  expiresAt: expiresAt,
                };
                if (server.authType === ServerAuthType.IntercomAuth) {
                  const intercomMetadata = await fetchIntercomTokenMetadata(exchangeResult.accessToken);
                  decryptedLaunchConfigValue.oauth.intercomRegion =
                    intercomMetadata!.intercomRegion;
                }
                if (server.authType === ServerAuthType.PipedriveAuth) {
                  if (!exchangeResult.apiDomain) {
                    throw new UserError(
                      'Pipedrive OAuth response missing api_domain',
                      UserErrorCode.SERVER_CONFIG_INVALID,
                    );
                  }
                  decryptedLaunchConfigValue.oauth.apiDomain = exchangeResult.apiDomain;
                }
                if ([ServerAuthType.ZendeskAuth].includes(server.authType)) {
                  decryptedLaunchConfigValue.oauth.tokenUrl = oauthConfig.tokenUrl;
                }
                if (server.authType === ServerAuthType.ZendeskAuth) {
                  decryptedLaunchConfigValue.oauth.scope = oauthConfig.scope;
                  if (
                    exchangeResult.raw.refresh_token_expires_in &&
                    typeof exchangeResult.raw.refresh_token_expires_in === 'number'
                  ) {
                    decryptedLaunchConfigValue.oauth.refreshTokenExpiresAt =
                      Date.now() + exchangeResult.raw.refresh_token_expires_in * 1000;
                  }
                }
                launchConfig = decryptedLaunchConfigValue;
              } else {
                throw new UserError(
                  'Failed to exchange OAuth code',
                  UserErrorCode.SERVER_CONFIG_INVALID,
                );
              }
            } catch (error) {
              this.logger.error({ err: error }, 'Error exchanging authorization code');
              throw new UserError(
                'Failed to exchange OAuth code',
                UserErrorCode.SERVER_CONFIG_INVALID,
              );
            }
          }
        } else {
          launchConfig = this.assembleLaunchConfig(template, authConf);
        }
        break;
      case ServerCategory.CustomRemote: {
        if (
          remoteAuth === undefined ||
          remoteAuth === null ||
          (remoteAuth.params.length === 0 && remoteAuth.headers.length === 0)
        ) {
          throw new UserError(
            `remoteAuth is required and cannot be empty and must contain either params or headers`,
            UserErrorCode.SERVER_CONFIG_INVALID,
          );
        }
        if (server.configTemplate === '' || server.configTemplate === '{}') {
          throw new UserError(
            `Server ${serverId} does not have a configuration template`,
            UserErrorCode.SERVER_NO_CONFIG_TEMPLATE,
          );
        }
        const configTemplate = JSON.parse(server.configTemplate);
        let url = configTemplate.url;
        if (remoteAuth.params && Object.keys(remoteAuth.params).length > 0) {
          if (url.includes('?')) {
            const urlParts = url.split('?');
            const urlParams = new URLSearchParams(remoteAuth.params);
            url = urlParts[0];
            url = `${url}?${urlParams.toString()}`;
          } else {
            url = `${url}?${new URLSearchParams(remoteAuth.params).toString()}`;
          }
        }
        launchConfig = {
          url: url,
          headers: { ...configTemplate.headers, ...remoteAuth.headers },
        };
        break;
      }
      case ServerCategory.CustomStdio: {
        if (server.configTemplate === '' || server.configTemplate === '{}') {
          throw new UserError(
            `Server ${serverId} does not have a configuration template`,
            UserErrorCode.SERVER_NO_CONFIG_TEMPLATE,
          );
        }
        const stdioTemplate = JSON.parse(server.configTemplate);

        if (!stdioTemplate.command) {
          throw new UserError(
            `Server ${serverId} has invalid stdio configuration: missing command`,
            UserErrorCode.SERVER_CONFIG_INVALID,
          );
        }

        // command, args, and cwd are immutable (set by admin)
        // env is merged: admin defaults + user overrides (user wins on key collision)
        const adminEnv = stdioTemplate.env ?? {};
        const userEnvOverrides = stdioEnv ?? {};

        launchConfig = {
          command: stdioTemplate.command,
          args: stdioTemplate.args ?? [],
          cwd: stdioTemplate.cwd,
          env: { ...adminEnv, ...userEnvOverrides },
        };
        break;
      }
      case ServerCategory.RestApi:
        if (restfulApiAuth === undefined || restfulApiAuth === null || restfulApiAuth.size === 0) {
          throw new UserError(
            `restfulApiAuth is required and cannot be empty`,
            UserErrorCode.SERVER_CONFIG_INVALID,
          );
        }
        launchConfig = JSON.parse(server.launchConfig);
        launchConfig.auth = restfulApiAuth;
        break;
      default:
        throw new UserError(
          `Invalid server category: ${server.category}`,
          UserErrorCode.SERVER_CONFIG_INVALID,
        );
    }

    const encryptedLaunchConfig = await CryptoService.encryptData(
      JSON.stringify(launchConfig),
      userToken,
    );

    const launchConfigs = JSON.parse(user.launchConfigs || '{}');
    launchConfigs[serverId] = encryptedLaunchConfig;

    await UserRepository.updateLaunchConfigs(userId, launchConfigs);

    const launchConfigsStr = JSON.stringify(launchConfigs);
    const userSessions = SessionStore.instance.getUserSessions(userId);
    for (const session of userSessions) {
      session.launchConfigs = launchConfigsStr;
    }

    // 4. Immediately start temporary server
    const tempServerEntity: any = {
      ...server,
      launchConfig: JSON.stringify(encryptedLaunchConfig),
    };

    const serverContext = await ServerManager.instance.createTemporaryServer(
      userId,
      tempServerEntity,
      userToken,
    );

    // 5. Store capabilities to user.userPreferences
    const userPreferences = JSON.parse(user.userPreferences || '{}');
    const mcpCapabilities = serverContext.getMcpCapabilities();
    userPreferences[serverId] = mcpCapabilities;

    await UserRepository.updateUserPreferences(userId, userPreferences);

    // 6. Notify all user clients (if socketNotifier is available)
    socketNotifier.notifyPermissionChangedByUser(userId);

    // 7. Notify all active sessions
    await SessionStore.instance.updateUserPreferences(userId);

    this.logger.info({ userId, serverId }, 'User successfully configured server');

    return {
      serverId: serverId,
      message: 'Server configured and started successfully',
    };
  }

  /**
   * Assemble launchConfig from template and user-provided credentials
   *
   * @param template - Configuration template in JSON string format
   * @param authConf - Authentication configuration provided by user
   * @returns Assembled launchConfig object
   *
   */
  private assembleLaunchConfig(
    template: Record<string, any>,
    authConf: Array<{ key: string; value: string; dataType: number }>,
  ): any {
    // 2. Extract mcpJsonConf
    if (!template.mcpJsonConf) {
      throw new UserError(
        'configTemplate must contain mcpJsonConf field',
        UserErrorCode.SERVER_CONFIG_INVALID,
      );
    }

    // 3. Parse mcpJsonConf
    const mcpJsonConf = template.mcpJsonConf;

    // 4. Deep copy configuration object
    let processedConfig = JSON.parse(JSON.stringify(mcpJsonConf));

    // 5. Validate and apply authConf
    if (!authConf || authConf.length === 0) {
      throw new UserError(
        'authConf is required and cannot be empty',
        UserErrorCode.SERVER_CONFIG_INVALID,
      );
    }

    for (const auth of authConf) {
      // Validate input
      if (!auth.key || typeof auth.key !== 'string') {
        throw new UserError(`Invalid auth.key: ${auth.key}`, UserErrorCode.SERVER_CONFIG_INVALID);
      }

      if (auth.value === undefined || auth.value === null || typeof auth.value !== 'string') {
        throw new UserError(
          `Invalid auth.value for key: ${auth.key}`,
          UserErrorCode.SERVER_CONFIG_INVALID,
        );
      }

      if (auth.dataType === 1) {
        // String replacement method
        const configStr = JSON.stringify(processedConfig);

        // Check if key exists in configuration
        if (!configStr.includes(auth.key)) {
          this.logger.warn({ key: auth.key }, 'Placeholder not found in configuration');
        }

        // Execute replacement (use split/join to avoid regex injection)
        const updatedConfigStr = configStr.split(auth.key).join(auth.value);

        // Validate JSON validity after replacement
        try {
          processedConfig = JSON.parse(updatedConfigStr);
        } catch (error: any) {
          throw new UserError(
            `Configuration became invalid after credential replacement: ${error.message}`,
            UserErrorCode.SERVER_CONFIG_INVALID,
          );
        }
      }
      // TODO: Support other dataTypes (if needed in the future)
    }

    // Handle OAuth expiration dates dynamically
    if (template.authType === ServerAuthType.NotionAuth && !processedConfig.oauth?.expiresAt) {
      processedConfig.oauth = processedConfig.oauth || {};
      processedConfig.oauth.expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    } else if (
      template.authType === ServerAuthType.FigmaAuth &&
      !processedConfig.oauth?.expiresAt
    ) {
      processedConfig.oauth = processedConfig.oauth || {};
      processedConfig.oauth.expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;
    }

    return processedConfig;
  }

  /**
   * Handle UNCONFIGURE_SERVER: Unconfigure a server for user
   *
   * @param userId - User ID
   * @param data - Unconfiguration request data
   * @returns Promise<UnconfigureServerResponseData> - Unconfiguration result
   *
   */
  async handleUnconfigureServer(
    userId: string,
    data: UnconfigureServerRequest,
  ): Promise<UnconfigureServerResponseData> {
    const { serverId } = data;
    this.logger.debug({ userId, serverId }, 'Unconfiguring server for user');

    // Import dependencies dynamically
    const UserRepository = (await import('../repositories/UserRepository.js')).default;
    const { ServerManager } = await import('../mcp/core/ServerManager.js');

    // 1. Get user
    const user = await UserRepository.findById(userId);
    if (!user) {
      throw new UserError(`User ${userId} not found`, UserErrorCode.INTERNAL_ERROR);
    }

    // 2. Check if already configured (idempotency)
    const launchConfigs = JSON.parse(user.launchConfigs || '{}');
    if (!launchConfigs[serverId]) {
      this.logger.debug(
        { serverId, userId },
        'Server not configured, returning success (idempotent)',
      );
      return {
        serverId: serverId,
        message: 'Server not configured (already unconfigured)',
      };
    }

    // 3. Close temporary server (force close, don't wait for pending requests)
    try {
      await ServerManager.instance.closeTemporaryServer(serverId, userId);
      this.logger.info({ serverId, userId }, 'Closed temporary server for user');
    } catch (error: any) {
      this.logger.warn(
        { error: error.message, serverId, userId },
        'Failed to close temporary server',
      );
      // Continue execution, as server may already not exist or be closed
    }

    // 4. Clean up launchConfigs
    delete launchConfigs[serverId];
    await UserRepository.updateLaunchConfigs(userId, launchConfigs);
    this.logger.debug({ serverId, userId }, 'Removed server from user launchConfigs');

    // 5. Clean up userPreferences
    const userPreferences = JSON.parse(user.userPreferences || '{}');
    if (userPreferences[serverId]) {
      delete userPreferences[serverId];
      await UserRepository.updateUserPreferences(userId, userPreferences);
      this.logger.debug({ serverId, userId }, 'Removed server from user userPreferences');
    }

    // 6. Notify all related users (if socketNotifier is available)
    await socketNotifier.notifyUserPermissionChangedByServer(serverId);

    // 7. Notify all active sessions
    await SessionStore.instance.updateUserPreferences(userId);

    this.logger.info({ serverId, userId }, 'User successfully unconfigured server');

    return {
      serverId: serverId,
      message: 'Server unconfigured successfully',
    };
  }

  /**
   * Handle GET_ONLINE_SESSIONS: Get user's online session list
   *
   * @param userId - User ID
   * @returns Promise<SessionData[]> - List of online sessions
   *
   * New implementation - migrates data building logic from SocketNotifier.notifyOnlineSessions
   */
  async handleGetOnlineSessions(userId: string): Promise<SessionData[]> {
    this.logger.debug({ userId }, 'Getting user online sessions');

    // Import ClientSession type dynamically
    const { ClientSession } = await import('../mcp/core/ClientSession.js');

    // Get all MCP ClientSessions for the user
    const sessions = SessionStore.instance.getUserSessions(userId);

    // Build session data
    const sessionData = sessions.map((session: any) => ({
      sessionId: session.sessionId,
      clientName: session.clientInfo?.name || 'Unknown Client',
      userAgent: session.authContext.userAgent || 'Unknown',
      lastActive: session.lastActive,
    }));

    this.logger.debug({ userId, count: sessionData.length }, 'Retrieved user online sessions');
    return sessionData;
  }
}
