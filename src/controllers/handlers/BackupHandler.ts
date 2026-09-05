import { SessionStore } from '../../mcp/core/SessionStore.js';
import { ServerManager } from '../../mcp/core/ServerManager.js';
import { IpWhitelistService } from '../../security/IpWhitelistService.js';
import { UserRepository } from '../../repositories/UserRepository.js';
import { ServerRepository } from '../../repositories/ServerRepository.js';
import { ProxyRepository } from '../../repositories/ProxyRepository.js';
import { IpWhitelistRepository } from '../../repositories/IpWhitelistRepository.js';
import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { prisma } from '../../config/prisma.js';
import { User, Server, Proxy as ProxyModel, IpWhitelist } from '@prisma/client';
import { LogService } from '../../log/LogService.js';
import { MCPEventLogType } from '../../types/enums.js';
import { createLogger } from '../../logger/index.js';

interface BackupData {
  version: string;
  timestamp: number;
  tables: {
    users: User[];
    servers: Server[];
    proxies: ProxyModel[];
    ipWhitelist: IpWhitelist[];
  };
}

/**
 * Backup and restore operation handler (6000-6099)
 */
export class BackupHandler {
  // Logger for BackupHandler
  private logger = createLogger('BackupHandler');

  constructor(
    private ipWhitelistService: IpWhitelistService
  ) {}

  /**
   * Backup database (6001)
   */
  async handleBackupDatabase(request: AdminRequest<any>): Promise<any> {
    try {
      // Read all table data
      const users = await UserRepository.findAll();
      const servers = await ServerRepository.findAll();
      const proxies = await ProxyRepository.findAll();
      const ipWhitelist = await IpWhitelistRepository.findAll();

      const backupData: BackupData = {
        version: '1.0',
        timestamp: Math.floor(Date.now() / 1000),
        tables: {
          users,
          servers,
          proxies,
          ipWhitelist
        }
      };

      // Log admin operation
      LogService.getInstance().enqueueLog({
        action: MCPEventLogType.AdminBackupDatabase,
        requestParams: JSON.stringify({ proxyId : proxies.length > 0 ? proxies[0].id : 0 })
      });

      return {
        backup: backupData,
        stats: {
          usersCount: users.length,
          serversCount: servers.length,
          proxiesCount: proxies.length,
          ipWhitelistCount: ipWhitelist.length
        }
      };
    } catch (error: any) {
      this.logger.error({ error }, 'Backup failed');
      throw new AdminError(`Backup failed: ${error.message}`, AdminErrorCode.BACKUP_FAILED);
    }
  }

  /**
   * Restore database (6002)
   */
  async handleRestoreDatabase(request: AdminRequest<any>, token: string): Promise<any> {
    const { backup } = request.data;

    if (!backup || !backup.tables) {
      throw new AdminError('Invalid backup data', AdminErrorCode.INVALID_REQUEST);
    }

    const { users = [], servers = [], proxies = [], ipWhitelist = [] } = backup.tables;

    let shutdownCompleted = false;

    try {
      const existingProxy = await ProxyRepository.findFirst();
      if (existingProxy) {
        throw new AdminError('Proxy is not empty', AdminErrorCode.INVALID_REQUEST);
      }

      const existingUsers = await UserRepository.findAll();
      if (existingUsers.length > 0) {
        throw new AdminError('Users are not empty', AdminErrorCode.INVALID_REQUEST);
      }

      const existingServers = await ServerRepository.findAll();
      if (existingServers.length > 0) {
        throw new AdminError('Servers are not empty', AdminErrorCode.INVALID_REQUEST);
      }

      this.logger.info('Disconnecting all sessions...');
      await SessionStore.instance.removeAllSessions();

      this.logger.info('Stopping all MCP servers...');
      await ServerManager.instance.shutdown();
      shutdownCompleted = true;

      // 3. Restore all table data in transaction
      this.logger.info('Restoring database tables...');
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`LOCK TABLE "user", "proxy", "server" IN SHARE ROW EXCLUSIVE MODE`;
        if (await tx.proxy.count() > 0) {
          throw new AdminError('Proxy is not empty', AdminErrorCode.INVALID_REQUEST);
        }
        if (await tx.user.count() > 0) {
          throw new AdminError('Users are not empty', AdminErrorCode.INVALID_REQUEST);
        }
        if (await tx.server.count() > 0) {
          throw new AdminError('Servers are not empty', AdminErrorCode.INVALID_REQUEST);
        }

        // Delete all existing data (in dependency order)
        await tx.user.deleteMany({});
        await tx.server.deleteMany({});
        await tx.proxy.deleteMany({});
        await tx.ipWhitelist.deleteMany({});

        // Insert backup data
        if (proxies.length > 0) {
          await tx.proxy.createMany({ data: proxies });
          this.logger.info({ count: proxies.length }, 'Restored proxies');
        }

        if (users.length > 0) {
          await tx.user.createMany({ data: users });
          this.logger.info({ count: users.length }, 'Restored users');
        }

        if (servers.length > 0) {
          await tx.server.createMany({ data: servers });
          this.logger.info({ count: servers.length }, 'Restored servers');
        }

        if (ipWhitelist.length > 0) {
          await tx.ipWhitelist.createMany({ data: ipWhitelist });
          this.logger.info({ count: ipWhitelist.length }, 'Restored IP whitelist entries');
        }
      });

      // 4. Reload IP whitelist to memory
      this.logger.info('Reloading IP whitelist...');
      try {
        await this.ipWhitelistService.reloadFromDatabase();
      } catch (reloadError) {
        this.logger.warn(
          { error: reloadError },
          'IP whitelist reload failed after restore, will retry on next request'
        );
      }

      // 5. Reinitialize enabled MCP servers
      this.logger.info('Reinitializing enabled MCP servers...');
      const { successServers, failedServers } = await ServerManager.instance.connectAllServers(token);

      // Log admin operation
      LogService.getInstance().enqueueLog({
        action: MCPEventLogType.AdminRestoreDatabase,
        requestParams: JSON.stringify({ proxyId : proxies.length > 0 ? proxies[0].id : 0 })
      });

      return {
        message: 'Database restored successfully',
        stats: {
          usersRestored: users.length,
          serversRestored: servers.length,
          proxiesRestored: proxies.length,
          ipWhitelistRestored: ipWhitelist.length,
          serversStarted: successServers.length,
          serversFailed: failedServers.length
        }
      };
    } catch (error: any) {
      if (shutdownCompleted) {
        try {
          await ServerManager.instance.connectAllServers(token);
        } catch (recoveryError) {
          this.logger.error({ error: recoveryError }, 'Recovery reconnection failed');
        }
      }

      this.logger.error({ error }, 'Restore failed');
      throw new AdminError(`Restore failed: ${error.message}`, AdminErrorCode.RESTORE_FAILED);
    }
  }
}
