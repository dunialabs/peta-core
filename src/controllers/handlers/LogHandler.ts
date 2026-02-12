import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { ProxyRepository } from '../../repositories/ProxyRepository.js';
import { LogRepository } from '../../repositories/LogRepository.js';
import { LogSyncService } from '../../log/LogSyncService.js';
import { createLogger } from '../../logger/index.js';

/**
 * Log operation handler (7000-7099)
 */
export class LogHandler {
  // Logger for LogHandler
  private logger = createLogger('LogHandler');
  
  constructor() {}

  /**
   * Set log sync webhook URL (7001)
   * @param request Request containing proxyKey and webhookUrl
   */
  async handleSetLogWebhookUrl(request: AdminRequest<any>): Promise<any> {
    const { proxyKey, webhookUrl } = request.data;

    // Validate parameters
    if (!proxyKey || typeof proxyKey !== 'string') {
      throw new AdminError('proxyKey is required', AdminErrorCode.INVALID_REQUEST);
    }

    if (webhookUrl !== null && webhookUrl !== undefined && typeof webhookUrl !== 'string') {
      throw new AdminError('webhookUrl must be a string or null', AdminErrorCode.INVALID_REQUEST);
    }

    // Validate URL format (if URL is provided)
    if (webhookUrl) {
      try {
        const url = new URL(webhookUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new AdminError('webhookUrl must use http or https protocol', AdminErrorCode.INVALID_REQUEST);
        }
      } catch (error) {
        throw new AdminError('Invalid webhookUrl format', AdminErrorCode.INVALID_REQUEST);
      }
    }

    // Find proxy by proxyKey
    const proxy = await ProxyRepository.findByProxyKey(proxyKey);
    if (!proxy) {
      throw new AdminError(`Proxy not found with proxyKey: ${proxyKey}`, AdminErrorCode.PROXY_NOT_FOUND);
    }

    // Update webhook URL
    await ProxyRepository.updateWebhookUrl(proxy.id, webhookUrl || null);

    // Reload LogSyncService configuration
    await LogSyncService.getInstance().reloadWebhookUrl();

    this.logger.info({
      proxyId: proxy.id,
      proxyName: proxy.name,
      webhookUrl: webhookUrl || 'disabled'
    }, 'Webhook URL updated for proxy');

    return {
      proxyId: proxy.id,
      proxyName: proxy.name,
      webhookUrl: webhookUrl || null,
      message: webhookUrl
        ? 'Log webhook URL set successfully'
        : 'Log webhook URL cleared (sync disabled)'
    };
  }

  /**
   * Get log records (7002)
   * @param request Request containing id and limit
   */
  async handleGetLogs(request: AdminRequest<any>): Promise<any> {
    const { id, limit } = request.data || {};

    // Parse and validate parameters
    const startId = this.parsePositiveInt(id, 0);
    let requestedLimit = this.parsePositiveInt(limit, 1000);

    // Limit maximum count to 5000
    const MAX_LIMIT = 5000;
    if (requestedLimit > MAX_LIMIT) {
      requestedLimit = MAX_LIMIT;
    }

    // If startId is 0, start from first record
    const effectiveStartId = startId === 0 ? 1 : startId;

    // Get logs
    const logs = await LogRepository.findLogsFromId(effectiveStartId, requestedLimit);

    return {
      logs: logs,
      count: logs.length,
      startId: effectiveStartId,
      limit: requestedLimit
    };
  }

  // ==================== Helper Methods ====================

  /**
   * Parse positive integer parameter
   * @param value Parameter value
   * @param defaultValue Default value
   * @returns Parsed integer
   */
  private parsePositiveInt(value: any, defaultValue: number): number {
    if (value === null || value === undefined) {
      return defaultValue;
    }

    const parsed = typeof value === 'number' ? value : parseInt(value, 10);

    if (isNaN(parsed) || parsed < 0) {
      return defaultValue;
    }

    return parsed;
  }
}
