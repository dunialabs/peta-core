import { Request, Response, NextFunction } from 'express';
import { SessionStore } from '../mcp/core/SessionStore.js';
import { ServerManager } from '../mcp/core/ServerManager.js';
import {
  AdminActionType,
  AdminRequest,
  AdminResponse,
  AdminErrorCode,
  AdminError
} from '../types/admin.types.js';
import { IpWhitelistService } from '../security/IpWhitelistService.js';
import { UserHandler } from './handlers/UserHandler.js';
import { ServerHandler } from './handlers/ServerHandler.js';
import { QueryHandler } from './handlers/QueryHandler.js';
import { IpWhitelistHandler } from './handlers/IpWhitelistHandler.js';
import { ProxyHandler } from './handlers/ProxyHandler.js';
import { BackupHandler } from './handlers/BackupHandler.js';
import { LogHandler } from './handlers/LogHandler.js';
import { CloudflaredHandler } from './handlers/CloudflaredHandler.js';
import { SkillsHandler } from './handlers/SkillsHandler.js';
import { UserRole } from '../types/enums.js';
import { createLogger } from '../logger/index.js';
import { SocketService } from '../socket/SocketService.js';

/**
 * Configuration server management interface
 * Provides secure management API through unified management interface
 */
export class ConfigController {
  private userHandler: UserHandler;
  private serverHandler: ServerHandler;
  private queryHandler: QueryHandler;
  private ipWhitelistHandler: IpWhitelistHandler;
  private proxyHandler: ProxyHandler;
  private backupHandler: BackupHandler;
  private logHandler: LogHandler;
  private cloudflaredHandler: CloudflaredHandler;
  private skillsHandler: SkillsHandler;
  
  // Logger for ConfigController
  private logger = createLogger('ConfigController');

  constructor(
    private ipWhitelistService?: IpWhitelistService,
  ) {
    // Initialize all Handlers
    this.userHandler = new UserHandler();
    this.serverHandler = new ServerHandler();
    this.queryHandler = new QueryHandler();
    this.ipWhitelistHandler = new IpWhitelistHandler(ipWhitelistService!);
    this.proxyHandler = new ProxyHandler();
    this.backupHandler = new BackupHandler(ipWhitelistService!);
    this.logHandler = new LogHandler();
    this.cloudflaredHandler = new CloudflaredHandler();
    this.skillsHandler = new SkillsHandler();
  }

  /**
   * Set SocketService instance
   * @param socketService SocketService instance
   */
  setSocketService(socketService: SocketService): void {
    // Update ProxyHandler's socketService reference
    this.proxyHandler.setSocketService(socketService);
  }

  /**
   * Register unified management routes
   */
  registerRoutes(app: any): void {
    // Unified management interface - distinguish operation types by action field in request body
    // Note: Admin permission middleware needs to be applied first here
    app.post('/admin', this.handleAdminRequest.bind(this));
  }

  /**
   * Unified handling of admin requests
   */
  private async handleAdminRequest(req: Request, res: Response): Promise<void> {
    try {
      const adminRequest: AdminRequest<any> = req.body;
      
      // Validate request format
      if (!this.validateAdminRequest(adminRequest)) {
        const errorResponse: AdminResponse = {
          success: false,
          error: {
            code: AdminErrorCode.INVALID_REQUEST,
            message: 'Invalid admin request format'
          }
        };
        res.status(400).json(errorResponse);
        return;
      }

      const token = req.headers['authorization']?.substring(7);

      if (![AdminActionType.GET_PROXY,
        AdminActionType.CREATE_PROXY,
        AdminActionType.CREATE_USER,
        AdminActionType.GET_OWNER,
        AdminActionType.RESTORE_DATABASE,
        AdminActionType.COUNT_USERS,
        AdminActionType.COUNT_SERVERS].includes(adminRequest.action)) {
        if (!token) {
          throw new AdminError('Token is required', AdminErrorCode.FORBIDDEN);
        }

        if (req.authContext?.role !== UserRole.Owner && req.authContext?.role !== UserRole.Admin) {
          throw new AdminError('Only Owner and Admin role can perform admin operations.', AdminErrorCode.FORBIDDEN);
        }

        // Cache Owner token for lazy start
        if (req.authContext?.role === UserRole.Owner && token) {
          ServerManager.instance.setOwnerToken(token);
        }
      }

      // Route to corresponding handler method based on operation type
      let result: any;
      switch (adminRequest.action) {
        // ==================== User Operations (1000-1999) ====================
        case AdminActionType.DISABLE_USER:
          this.validateTargetIdentifier(adminRequest.data);
          result = await this.userHandler.handleDisableUser(adminRequest);
          break;
        case AdminActionType.UPDATE_USER_PERMISSIONS:
          this.validateTargetIdentifier(adminRequest.data);
          result = await this.userHandler.handleUpdateUserPermissions(adminRequest);
          break;
        case AdminActionType.CREATE_USER:
          result = await this.userHandler.handleCreateUser(adminRequest, token);
          break;
        case AdminActionType.GET_USERS:
          result = await this.userHandler.handleGetUsers(adminRequest);
          break;
        case AdminActionType.UPDATE_USER:
          result = await this.userHandler.handleUpdateUser(adminRequest);
          break;
        case AdminActionType.DELETE_USER:
          result = await this.userHandler.handleDeleteUser(adminRequest);
          break;
        case AdminActionType.DELETE_USERS_BY_PROXY:
          result = await this.userHandler.handleDeleteUsersByProxy(adminRequest);
          break;
        case AdminActionType.COUNT_USERS:
          result = await this.userHandler.handleCountUsers(adminRequest);
          break;
        case AdminActionType.GET_OWNER:
          result = await this.userHandler.handleGetOwner(adminRequest);
          break;

        // ==================== Server Operations (2000-2999) ====================
        case AdminActionType.START_SERVER:
          // Only Owner role can start server
          if (req.authContext?.role !== UserRole.Owner) {
            throw new AdminError('Only Owner role can start server.', AdminErrorCode.FORBIDDEN);
          }
          this.validateTargetIdentifier(adminRequest.data);
          result = await this.serverHandler.handleStartServer(adminRequest, token!);
          break;
        case AdminActionType.STOP_SERVER:
          this.validateTargetIdentifier(adminRequest.data);
          result = await this.serverHandler.handleStopServer(adminRequest);
          break;
        case AdminActionType.UPDATE_SERVER_CAPABILITIES:
          this.validateTargetIdentifier(adminRequest.data);
          result = await this.serverHandler.handleUpdateServerCapabilities(adminRequest);
          break;
        case AdminActionType.UPDATE_SERVER_LAUNCH_CMD:
          if (req.authContext?.role !== UserRole.Owner) {
            throw new AdminError('Only Owner role can update server launch cmd.', AdminErrorCode.FORBIDDEN);
          }
          this.validateTargetIdentifier(adminRequest.data);
          result = await this.serverHandler.handleUpdateServerLaunchCmd(adminRequest, token!);
          break;
        case AdminActionType.CONNECT_ALL_SERVERS:
          if (req.authContext?.role !== UserRole.Owner) {
            throw new AdminError('Only Owner role can connect all servers.', AdminErrorCode.FORBIDDEN);
          }
          result = await this.serverHandler.handleConnectAllServers(adminRequest, token!);
          break;
        case AdminActionType.CREATE_SERVER:
          if (req.authContext?.role !== UserRole.Owner) {
            throw new AdminError('Only Owner role can create server.', AdminErrorCode.FORBIDDEN);
          }
          result = await this.serverHandler.handleCreateServer(adminRequest, token!);
          break;
        case AdminActionType.GET_SERVERS:
          result = await this.serverHandler.handleGetServers(adminRequest);
          break;
        case AdminActionType.UPDATE_SERVER:
          if (req.authContext?.role !== UserRole.Owner) {
            throw new AdminError('Only Owner role can update server.', AdminErrorCode.FORBIDDEN);
          }
          result = await this.serverHandler.handleUpdateServer(adminRequest, token!);
          break;
        case AdminActionType.DELETE_SERVER:
          result = await this.serverHandler.handleDeleteServer(adminRequest);
          break;
        case AdminActionType.DELETE_SERVERS_BY_PROXY:
          result = await this.serverHandler.handleDeleteServersByProxy(adminRequest);
          break;
        case AdminActionType.COUNT_SERVERS:
          result = await this.serverHandler.handleCountServers(adminRequest);
          break;

        // ==================== Query Operations (3000-3999) ====================
        case AdminActionType.GET_AVAILABLE_SERVERS_CAPABILITIES:
          result = await this.queryHandler.handleGetAvailableServersCapabilities(adminRequest);
          break;
        case AdminActionType.GET_USER_AVAILABLE_SERVERS_CAPABILITIES:
          this.validateTargetIdentifier(adminRequest.data);
          result = await this.queryHandler.handleGetUserAvailableServersCapabilities(adminRequest);
          break;
        case AdminActionType.GET_SERVERS_STATUS:
          result = await this.queryHandler.handleGetServersStatus(adminRequest);
          break;
        case AdminActionType.GET_SERVERS_CAPABILITIES:
          this.validateTargetIdentifier(adminRequest.data);
          result = await this.queryHandler.handleGetServersCapabilities(adminRequest);
          break;

        // ==================== IP Whitelist Operations (4000-4999) ====================
        case AdminActionType.UPDATE_IP_WHITELIST:
          result = await this.ipWhitelistHandler.handleUpdateIpWhitelist(adminRequest);
          break;
        case AdminActionType.GET_IP_WHITELIST:
          result = await this.ipWhitelistHandler.handleGetIpWhitelist(adminRequest);
          break;
        case AdminActionType.DELETE_IP_WHITELIST:
          result = await this.ipWhitelistHandler.handleDeleteIpWhitelist(adminRequest);
          break;
        case AdminActionType.ADD_IP_WHITELIST:
          result = await this.ipWhitelistHandler.handleAddIpWhitelist(adminRequest);
          break;
        case AdminActionType.SPECIAL_IP_WHITELIST_OPERATION:
          result = await this.ipWhitelistHandler.handleSpecialIpWhitelistOperation(adminRequest);
          break;

        // ==================== Proxy Operations (5000-5099) ====================
        case AdminActionType.GET_PROXY:
          result = await this.proxyHandler.handleGetProxy(adminRequest);
          break;
        case AdminActionType.CREATE_PROXY:
          result = await this.proxyHandler.handleCreateProxy(adminRequest);
          break;
        case AdminActionType.UPDATE_PROXY:
          result = await this.proxyHandler.handleUpdateProxy(adminRequest);
          break;
        case AdminActionType.DELETE_PROXY:
          if (req.authContext?.role !== UserRole.Owner) {
            throw new AdminError('Only Owner role can delete proxy.', AdminErrorCode.FORBIDDEN);
          }
          result = await this.proxyHandler.handleDeleteProxy(adminRequest);
          break;
        case AdminActionType.STOP_PROXY:
          if (req.authContext?.role !== UserRole.Owner) {
            throw new AdminError('Only Owner role can stop proxy.', AdminErrorCode.FORBIDDEN);
          }
          result = await this.proxyHandler.handleStopProxy(adminRequest);
          break;

        // ==================== Backup and Restore Operations (6000-6099) ====================
        case AdminActionType.BACKUP_DATABASE:
          result = await this.backupHandler.handleBackupDatabase(adminRequest);
          break;
        case AdminActionType.RESTORE_DATABASE:
          result = await this.backupHandler.handleRestoreDatabase(adminRequest, token!);
          break;

        // ==================== Log Operations (7000-7099) ====================
        case AdminActionType.SET_LOG_WEBHOOK_URL:
          // Only Owner role can set webhook URL
          if (req.authContext?.role !== UserRole.Owner) {
            throw new AdminError('Only Owner role can set log webhook URL.', AdminErrorCode.FORBIDDEN);
          }
          result = await this.logHandler.handleSetLogWebhookUrl(adminRequest);
          break;
        case AdminActionType.GET_LOGS:
          // Only Owner role can get logs
          if (req.authContext?.role !== UserRole.Owner) {
            throw new AdminError('Only Owner role can get logs.', AdminErrorCode.FORBIDDEN);
          }
          result = await this.logHandler.handleGetLogs(adminRequest);
          break;

        // ==================== Cloudflared Operations (8000-8099) ====================
        case AdminActionType.UPDATE_CLOUDFLARED_CONFIG:
          result = await this.cloudflaredHandler.handleUpdateCloudflaredConfig(adminRequest);
          break;
        case AdminActionType.GET_CLOUDFLARED_CONFIGS:
          result = await this.cloudflaredHandler.handleGetCloudflaredConfigs(adminRequest);
          break;
        case AdminActionType.DELETE_CLOUDFLARED_CONFIG:
          result = await this.cloudflaredHandler.handleDeleteCloudflaredConfig(adminRequest);
          break;
        case AdminActionType.RESTART_CLOUDFLARED:
          result = await this.cloudflaredHandler.handleRestartCloudflared(adminRequest);
          break;
        case AdminActionType.STOP_CLOUDFLARED:
          result = await this.cloudflaredHandler.handleStopCloudflared(adminRequest);
          break;

        // ==================== Skills Operations (10040-10043) ====================
        case AdminActionType.LIST_SKILLS:
          result = await this.skillsHandler.handleListSkills(adminRequest);
          break;
        case AdminActionType.UPLOAD_SKILL:
          // Only Owner role can upload skills
          if (req.authContext?.role !== UserRole.Owner) {
            throw new AdminError('Only Owner role can upload skills.', AdminErrorCode.FORBIDDEN);
          }
          result = await this.skillsHandler.handleUploadSkill(adminRequest);
          break;
        case AdminActionType.DELETE_SKILL:
          // Only Owner role can delete skills
          if (req.authContext?.role !== UserRole.Owner) {
            throw new AdminError('Only Owner role can delete skills.', AdminErrorCode.FORBIDDEN);
          }
          result = await this.skillsHandler.handleDeleteSkill(adminRequest);
          break;
        case AdminActionType.DELETE_SERVER_SKILLS:
          // Only Owner role can delete server skills
          if (req.authContext?.role !== UserRole.Owner) {
            throw new AdminError('Only Owner role can delete server skills.', AdminErrorCode.FORBIDDEN);
          }
          result = await this.skillsHandler.handleDeleteServerSkills(adminRequest);
          break;

        default:
          const errorResponse: AdminResponse = {
            success: false,
            error: {
              code: AdminErrorCode.INVALID_REQUEST,
              message: `Unknown action type: ${adminRequest.action}`
            }
          };
          res.status(400).json(errorResponse);
          return;
      }

      // Return success response
      const successResponse: AdminResponse = {
        success: true,
        data: result ?? {}
      };
      res.json(successResponse);

    } catch (error) {
      const action = req.body.action;
      this.logger.error({ action, error }, 'Admin request error');
      let code = AdminErrorCode.INVALID_REQUEST;
      if (error instanceof AdminError) {
        code = error.code;
      }
      const errorResponse: AdminResponse = {
        success: false,
        error: {
          code: code,
          message: error instanceof Error ? error.message : 'Internal server error'
        }
      };
      res.status(500).json(errorResponse);
    }
  }

  /**
   * Validate admin request format
   */
  private validateAdminRequest(request: AdminRequest<any>): boolean {
    // 1. Check required fields
    if (!request.action) {
      return false;
    }

    // 2. Validate operation type
    if (!Object.values(AdminActionType).includes(request.action)) {
      return false;
    }
  
    return true;
  }

  /**
   * Validate if data is TargetIdentifier type
   */
  private validateTargetIdentifier(data: any): void {
    if (data === null || data === undefined) {
      throw new AdminError('Invalid target identifier: data is null or undefined', AdminErrorCode.INVALID_REQUEST);
    }
    if (typeof data !== 'object') {
      throw new AdminError('Invalid target identifier: data is not an object', AdminErrorCode.INVALID_REQUEST);
    }
    if (!('targetId' in data)) {
      throw new AdminError('Invalid target identifier: missing targetId field', AdminErrorCode.INVALID_REQUEST);
    }
    if (typeof data.targetId !== 'string') {
      throw new AdminError('Invalid target identifier: targetId is not a string', AdminErrorCode.INVALID_REQUEST);
    }
  }
}