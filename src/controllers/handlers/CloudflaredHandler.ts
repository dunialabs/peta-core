import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { ProxyRepository } from '../../repositories/ProxyRepository.js';
import { LogService } from '../../log/LogService.js';
import { MCPEventLogType } from '../../types/enums.js';
import { CloudflaredService } from '../../services/CloudflaredService.js';

/**
 * Cloudflared operation handler (8000-8099)
 * Controller layer: Responsible for request validation, logging, calls CloudflaredService to handle business logic
 */
export class CloudflaredHandler {

  constructor() {}

  /**
   * Update cloudflared configuration (8001)
   */
  async handleUpdateCloudflaredConfig(request: AdminRequest<any>): Promise<any> {
    const { proxyKey, tunnelId, subdomain, credentials, publicIp = '' } = request.data;

    // Validate required fields
    if (!proxyKey) {
      throw new AdminError('Missing required field: proxyKey', AdminErrorCode.INVALID_REQUEST);
    }
    if (!tunnelId) {
      throw new AdminError('Missing required field: tunnelId', AdminErrorCode.INVALID_REQUEST);
    }
    if (!subdomain) {
      throw new AdminError('Missing required field: subdomain', AdminErrorCode.INVALID_REQUEST);
    }
    if (!credentials) {
      throw new AdminError('Missing required field: credentials', AdminErrorCode.INVALID_REQUEST);
    }

    // Find proxy
    const proxy = await ProxyRepository.findByProxyKey(proxyKey);
    if (!proxy) {
      throw new AdminError('Proxy not found', AdminErrorCode.PROXY_NOT_FOUND);
    }

    // Parse credentials (supports object or JSON string)
    let credentialsObj: any;
    if (typeof credentials === 'string') {
      try {
        credentialsObj = JSON.parse(credentials);
      } catch (error) {
        throw new AdminError('Invalid credentials JSON format', AdminErrorCode.INVALID_CREDENTIALS_FORMAT);
      }
    } else if (typeof credentials === 'object') {
      credentialsObj = credentials;
    } else {
      throw new AdminError('credentials must be an object or JSON string', AdminErrorCode.INVALID_CREDENTIALS_FORMAT);
    }

    // Validate that credentials contains required TunnelSecret
    if (!credentialsObj.TunnelSecret) {
      throw new AdminError('credentials must contain TunnelSecret field', AdminErrorCode.INVALID_CREDENTIALS_FORMAT);
    }

    // Call service layer to update configuration
    const result = await CloudflaredService.getInstance().updateConfig(
      proxy.id,
      tunnelId,
      subdomain,
      credentialsObj,
      publicIp
    );

    // Log
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminDNSCreate,
      requestParams: JSON.stringify({ proxyKey: proxyKey, subdomain: subdomain })
    });

    return result;
  }

  /**
   * Query cloudflared configuration list (8002)
   */
  async handleGetCloudflaredConfigs(request: AdminRequest<any>): Promise<any> {
    const { proxyKey, tunnelId, subdomain, type } = request.data || {};

    // Build query filter conditions
    const filters: any = {};

    // If proxyKey is provided, find corresponding proxyId
    if (proxyKey !== undefined) {
      const proxy = await ProxyRepository.findByProxyKey(proxyKey);
      if (!proxy) {
        throw new AdminError('Proxy not found', AdminErrorCode.PROXY_NOT_FOUND);
      }
      filters.proxyId = proxy.id;
    }

    if (tunnelId !== undefined) {
      filters.tunnelId = tunnelId;
    }

    if (subdomain !== undefined) {
      filters.subdomain = subdomain;
    }

    if (type !== undefined) {
      filters.type = type;
    }

    // Call service layer to query configuration
    const dnsConfs = await CloudflaredService.getInstance().getConfigs(filters);

    return { dnsConfs: dnsConfs };
  }

  /**
   * Delete cloudflared configuration (8003)
   */
  async handleDeleteCloudflaredConfig(request: AdminRequest<any>): Promise<any> {
    const { id, tunnelId } = request.data;

    // At least one of id or tunnelId must be provided
    if (!id && !tunnelId) {
      throw new AdminError('Either id or tunnelId must be provided', AdminErrorCode.INVALID_REQUEST);
    }

    // Call service layer to delete configuration
    const result = await CloudflaredService.getInstance().deleteConfig(id, tunnelId);

    // Log
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminDNSDelete,
      requestParams: JSON.stringify({ id: result.deletedConfig.id, tunnelId: result.deletedConfig.tunnelId })
    });

    return result;
  }

  /**
   * Restart cloudflared (8004)
   */
  async handleRestartCloudflared(request: AdminRequest<any>): Promise<any> {
    // Call service layer to restart
    const result = await CloudflaredService.getInstance().restartCloudflared();

    // Log
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminDNSCreate,
      requestParams: JSON.stringify({
        action: 'restart',
        tunnelId: result.config?.tunnelId
      })
    });

    return result;
  }

  /**
   * Stop cloudflared (8005)
   */
  async handleStopCloudflared(request: AdminRequest<any>): Promise<any> {
    // Call service layer to stop
    const result = await CloudflaredService.getInstance().stopCloudflared();

    // Log
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminDNSCreate,
      requestParams: JSON.stringify({ action: 'stop' })
    });

    return result;
  }
}
