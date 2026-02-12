import { ProxyRepository } from '../../repositories/ProxyRepository.js';
import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { ServerRepository } from '../../repositories/ServerRepository.js';
import { UserRepository } from '../../repositories/UserRepository.js';
import { IpWhitelistRepository } from '../../repositories/IpWhitelistRepository.js';
import { LogRepository } from '../../repositories/LogRepository.js';
import { ServerManager } from '../../mcp/core/ServerManager.js';
import { SessionStore } from '../../mcp/core/SessionStore.js';
import { LogService } from '../../log/LogService.js';
import { MCPEventLogType } from '../../types/enums.js';
import { getShutdownFunction } from '../../index.js';
import { prisma } from '../../config/prisma.js';
import { EventRepository } from '../../repositories/EventRepository.js';
import { CloudflaredService } from '../../services/CloudflaredService.js';
import { createLogger } from '../../logger/index.js';
import { SocketService } from '../../socket/SocketService.js';

/**
 * Proxy operation handler (5000-5099)
 */
export class ProxyHandler {
  // Logger for ProxyHandler
  private logger = createLogger('ProxyHandler');

  constructor(
    private socketService?: SocketService
  ) {}

  /**
   * Set SocketService instance
   * @param socketService SocketService instance
   */
  setSocketService(socketService: SocketService): void {
    this.socketService = socketService;
  }

  /**
   * Query proxy list (5001)
   */
  async handleGetProxy(request: AdminRequest<any>): Promise<any> {

    // Query all proxies
    const proxy = await ProxyRepository.findFirst();
    return { proxy: proxy ?? null };
  }

  /**
   * Create proxy (5002)
   */
  async handleCreateProxy(request: AdminRequest<any>): Promise<any> {
    const {
      name,
      proxyKey
    } = request.data;

    // Only one proxy allowed
    const proxies = await ProxyRepository.findAll();
    if (proxies.length > 0) {
      throw new AdminError('Only one proxy is allowed', AdminErrorCode.PROXY_ALREADY_EXISTS);
    }

    // Validate required fields
    if (!name) {
      throw new AdminError('Missing required field: name', AdminErrorCode.INVALID_REQUEST);
    }
    if (!proxyKey) {
      throw new AdminError('Missing required field: proxyKey', AdminErrorCode.INVALID_REQUEST);
    }

    const startPort = parseInt(process.env.BACKEND_PORT ?? '3002');

    // Create proxy
    const proxy = await ProxyRepository.create({
      name,
      proxyKey,
      startPort,
      addtime: Math.floor(Date.now() / 1000)
    });

    // Update server information
    if (this.socketService) {
      this.socketService.updateServerInfo();
    }

    return { proxy : proxy };
  }

  /**
   * Update proxy (5003)
   */
  async handleUpdateProxy(request: AdminRequest<any>): Promise<any> {
    const {
      name,
      proxyId,
    } = request.data;

    // Validate required fields
    if (proxyId === undefined) {
      throw new AdminError('Missing required field: proxyId', AdminErrorCode.INVALID_REQUEST);
    }

    if (name === undefined) {
      throw new AdminError('Missing required field: name', AdminErrorCode.INVALID_REQUEST);
    }

    // Check if proxy exists
    const existingProxy = await ProxyRepository.findById(proxyId);
    if (!existingProxy) {
      throw new AdminError('Proxy not found', AdminErrorCode.PROXY_NOT_FOUND);
    }

    // Prepare update data
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;

    const proxy = await ProxyRepository.update(existingProxy.id, updateData);
    
    // Update server information
    if (this.socketService) {
      this.socketService.updateServerInfo();
    }

    return { proxy : proxy };
  }

  /**
   * Delete proxy (5004)
   */
  async handleDeleteProxy(request: AdminRequest<any>): Promise<any> {
    const { proxyId } = request.data;
    if (proxyId === undefined) {
      throw new AdminError('Missing required field: proxyId', AdminErrorCode.INVALID_REQUEST);
    }
    // First check if it's the current proxy
    const proxy = await ProxyRepository.findById(proxyId);
    if (!proxy) {
      throw new AdminError('Proxy not found', AdminErrorCode.PROXY_NOT_FOUND);
    }
    // Delete proxy
    await ProxyRepository.delete(proxy.id);

    // Before clearing dnsConf, first delete cloudflared configurations (stop containers, delete files)
    const cloudflaredService = CloudflaredService.getInstance();
    try {
      // Query all cloudflared configurations under this proxy
      const dnsConfs = await prisma.dnsConf.findMany({
        where: { proxyId: proxy.id, type: 1 }
      });

      // Delete cloudflared configurations one by one (stop containers, delete files)
      for (const conf of dnsConfs) {
        try {
          await cloudflaredService.deleteConfig(conf.id, conf.tunnelId);
          this.logger.info({ tunnelId: conf.tunnelId }, 'Deleted cloudflared config for tunnel');
        } catch (error: any) {
          this.logger.warn({ error: error.message, tunnelId: conf.tunnelId }, 'Failed to delete cloudflared config');
          // Continue processing other configurations
        }
      }
    } catch (error: any) {
      this.logger.warn({ error }, 'Failed to cleanup cloudflared during proxy deletion');
      // Continue execution, don't block deletion process
    }

    // Clear all users, servers, IP whitelist, logs
    await UserRepository.deleteByProxyId(proxy.id);
    await ServerRepository.deleteByProxyId(proxy.id);
    await EventRepository.deleteAll();
    await IpWhitelistRepository.deleteAll();
    await LogRepository.deleteAll();
    await prisma.dnsConf.deleteMany({});
    await prisma.license.deleteMany({});
    await prisma.oAuthAuthorizationCode.deleteMany({});
    await prisma.oAuthClient.deleteMany({});
    await prisma.oAuthToken.deleteMany({});

    // Clear all sessions
    await SessionStore.instance.removeAllSessions();
    // Stop all servers
    await ServerManager.instance.shutdown();

    // Log admin operation
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminProxyReset,
      requestParams: JSON.stringify({ proxyId: proxyId })
    });

    return { message: 'Proxy deleted successfully' };
  }

  /**
   * Stop proxy server (5005)
   * Triggers complete application shutdown process, equivalent to SIGTERM/SIGINT signal
   */
  async handleStopProxy(request: AdminRequest<any>): Promise<any> {
    const shutdown = getShutdownFunction();

    if (!shutdown) {
      throw new AdminError('Shutdown function not available', AdminErrorCode.INVALID_REQUEST);
    }

    // Return success response before executing shutdown to ensure client can receive response
    // Use setImmediate to delay execution, giving response a chance to be sent
    setImmediate(() => {
      shutdown('ADMIN_STOP_PROXY').catch((error) => {
        this.logger.error({ error }, 'Error during shutdown');
        process.exit(1);
      });
    });

    return { message: 'Proxy shutdown initiated successfully' };
  }
}
