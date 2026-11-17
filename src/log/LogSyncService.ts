/**
 * Log Sync Service
 * Responsible for batch syncing logs from database to configured webhook URL
 */

import { Log } from '@prisma/client';
import { LogRepository } from '../repositories/LogRepository.js';
import { ProxyRepository } from '../repositories/ProxyRepository.js';
import { LogSyncConfig } from './LogSyncConfig.js';
import { LogService } from './LogService.js';
import { MCPEventLogType } from '../types/enums.js';
import { createLogger } from '../logger/index.js';
import { ClientMetadataNetwork } from '../oauth/services/ClientMetadataNetwork.js';
import { sanitizeUrlForLog } from '../utils/urlUtils.js';

export class LogSyncService {
  private static instance: LogSyncService = new LogSyncService();
  private syncTimer: NodeJS.Timeout | null = null;
  private lastSyncedLogId: number = 0;
  private proxyId: number | null = null;
  private webhookUrl: string | null = null;
  private isShuttingDown: boolean = false;
  private isSyncing: boolean = false;
  private readonly network = new ClientMetadataNetwork(LogSyncConfig.HTTP_TIMEOUT, 1024 * 1024);
  
  // Logger for LogSyncService
  private logger = createLogger('LogSyncService');

  private constructor() {
    // Private constructor for singleton pattern
  }

  static getInstance(): LogSyncService {
    return LogSyncService.instance;
  }

  /**
   * Initialize service
   * Read proxy configuration and last synced log ID
   */
  async initialize(): Promise<void> {
    try {
      // Get first proxy record (system has only one proxy)
      const proxy = await ProxyRepository.findFirst();
      if (!proxy) {
        this.logger.info('No proxy found, log sync disabled');
        return;
      }

      this.proxyId = proxy.id;
      this.webhookUrl = proxy.logWebhookUrl;
      this.lastSyncedLogId = proxy.lastSyncedLogId;

      this.logger.info({
        proxyId: this.proxyId,
        lastSyncedLogId: this.lastSyncedLogId,
        webhookUrl: this.webhookUrl ? 'configured' : 'not configured'
      }, 'Initialized');

      // Start scheduled sync
      this.startSyncTimer();
    } catch (error) {
      this.logger.error({ error }, 'Initialization error');
    }
  }

  /**
   * Start scheduled sync timer
   * Only start when webhookUrl is configured to avoid unnecessary timer runs
   */
  private startSyncTimer(): void {
    // Don't start timer if webhookUrl is not configured
    if (!this.webhookUrl) {
      this.logger.debug('Webhook URL not configured, skipping timer start');
      return;
    }

    // Don't restart if timer is already running
    if (this.syncTimer) {
      return;
    }

    this.syncTimer = setInterval(async () => {
      await this.syncLogs();
    }, LogSyncConfig.SYNC_INTERVAL);

    this.logger.info({ interval: LogSyncConfig.SYNC_INTERVAL }, 'Sync timer started');
  }

  /**
   * Stop scheduled sync timer
   */
  private stopSyncTimer(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      this.logger.info('Sync timer stopped');
    }
  }

  /**
   * Sync logs to webhook URL
   */
  private async syncLogs(): Promise<void> {
    // Check if shutting down
    if (this.isShuttingDown) {
      return;
    }

    // Check if sync is in progress
    if (this.isSyncing) {
      this.logger.debug('Sync already in progress, skipping...');
      return;
    }

    // Check if webhook URL is configured
    if (!this.webhookUrl || !this.proxyId) {
      // Webhook URL not configured, silently skip
      return;
    }

    this.isSyncing = true;

    try {
      // Get logs to sync
      const logs = await LogRepository.findLogsFromId(
        this.lastSyncedLogId + 1,
        LogSyncConfig.SYNC_BATCH_SIZE
      );

      if (logs.length === 0) {
        // No new logs, skip
        this.isSyncing = false;
        return;
      }

      this.logger.info({
        logCount: logs.length,
        startingFromId: this.lastSyncedLogId + 1
      }, 'Syncing logs');

      // Send logs to webhook URL
      const success = await this.sendLogsToWebhook(logs);

      if (success) {
        // Update last synced log ID
        const lastLogId = logs[logs.length - 1].id;
        await ProxyRepository.updateLastSyncedLogId(this.proxyId, lastLogId);
        this.lastSyncedLogId = lastLogId;

        this.logger.info({
          logCount: logs.length,
          lastSyncedLogId: lastLogId
        }, 'Successfully synced logs');
      } else {
        this.logger.error('Failed to sync logs');
      }
    } catch (error) {
      this.logger.error({ error }, 'Sync error');
      LogService.getInstance().enqueueLog({
        action: MCPEventLogType.ErrorInternal,
        error: "Failed to sync logs, error: " + error,
      });
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Send logs to webhook URL
   * @param logs Array of log records
   * @returns Whether the send was successful
   */
  private async sendLogsToWebhook(logs: Log[]): Promise<boolean> {
    if (!this.webhookUrl) {
      return false;
    }

    let lastError: Error | null = null;

    // Try to send, retry once on failure
    for (let attempt = 0; attempt <= LogSyncConfig.RETRY_COUNT; attempt++) {
      try {
        const networkValidation = await this.network.validatePublicNetworkTarget(this.webhookUrl, { allowFakeIp: false });
        if (!networkValidation.valid) {
          this.logger.error({ url: sanitizeUrlForLog(this.webhookUrl), reason: networkValidation.error }, 'Refusing unsafe log webhook URL');
          return false;
        }
        const response = await this.network.postPinnedJson(
          this.webhookUrl,
          networkValidation.addresses ?? [],
          JSON.stringify({
            logs,
            count: logs.length,
            timestamp: Date.now(),
          }),
          {
            'Content-Type': 'application/json',
            'User-Agent': 'PETA-MCP-Console-LogSync/1.0',
          },
        );

        if (response.status >= 300 && response.status < 400) {
          lastError = new Error('Webhook redirects are not allowed');
        } else if (response.ok) {
          if (attempt > 0) {
            this.logger.info({ attempt }, 'Successfully sent logs on retry attempt');
          }
          return true;
        } else {
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
          this.logger.error({
            error: lastError.message,
            attempt: attempt + 1
          }, 'Webhook returned error');
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.error({
          error: lastError.message,
          attempt: attempt + 1
        }, 'Failed to send logs to webhook');
      }

      // If not the last attempt, wait a bit before retrying
      if (attempt < LogSyncConfig.RETRY_COUNT) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    this.logger.error({ error: lastError?.message }, 'All retry attempts failed');
    return false;
  }

  /**
   * Reload webhook URL configuration
   * Called when admin updates webhook URL
   * Dynamically manage timer based on webhookUrl changes:
   * - From none to configured: Start timer
   * - From configured to none: Stop timer
   * - From configured to configured (update): Keep timer running
   */
  async reloadWebhookUrl(): Promise<void> {
    try {
      if (!this.proxyId) {
        const proxy = await ProxyRepository.findFirst();
        if (!proxy) {
          return;
        }
        this.proxyId = proxy.id;
      }

      const proxy = await ProxyRepository.findById(this.proxyId);
      if (!proxy) {
        return;
      }

      const oldWebhookUrl = this.webhookUrl;
      const newWebhookUrl = proxy.logWebhookUrl;
      this.webhookUrl = newWebhookUrl;

      // Dynamically manage timer based on webhookUrl changes
      const hadWebhook = !!oldWebhookUrl;
      const hasWebhook = !!newWebhookUrl;

      if (!hadWebhook && hasWebhook) {
        // From none to configured: Start timer
        this.logger.info({
          webhookUrl: 'configured'
        }, 'Webhook URL set, starting sync timer');
        this.startSyncTimer();
      } else if (hadWebhook && !hasWebhook) {
        // From configured to none: Stop timer
        this.logger.info({
          webhookUrl: 'not configured'
        }, 'Webhook URL cleared, stopping sync timer');
        this.stopSyncTimer();
      } else if (hasWebhook) {
        // From configured to configured (update): Keep timer running
        this.logger.info({
          webhookUrl: 'updated'
        }, 'Webhook URL updated, timer continues running');
      } else {
        // From none to none: No action needed
        this.logger.info({
          webhookUrl: 'not configured'
        }, 'Webhook URL reloaded (still not configured)');
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to reload webhook URL');
    }
  }

  /**
   * Shutdown service
   * Try to flush remaining logs (with timeout protection)
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.info('Shutting down...');

    // Stop timer
    this.stopSyncTimer();

    // Try to flush remaining logs (with timeout protection)
    try {
      const shutdownPromise = this.syncLogs();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown timeout')), LogSyncConfig.SHUTDOWN_TIMEOUT)
      );

      await Promise.race([shutdownPromise, timeoutPromise]);
      this.logger.info('Final sync completed');
    } catch (error) {
      if (error instanceof Error && error.message === 'Shutdown timeout') {
        this.logger.warn('Shutdown timeout reached, skipping final sync');
      } else {
        this.logger.error({ error }, 'Error during final sync');
      }
    }

    this.logger.info('Shutdown complete');
  }
}
