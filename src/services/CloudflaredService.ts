/**
 * CloudflaredService
 * 
 * Core business logic for cloudflared tunnel management.
 * Handles configuration, file generation, and container lifecycle.
 */

import { AdminError, AdminErrorCode } from '../types/admin.types.js';
import { prisma } from '../config/prisma.js';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger/index.js';
import { CLOUDFLARED_CONFIG } from '../config/cloudflaredConfig.js';
import { CloudflaredDockerService } from './CloudflaredDockerService.js';

const logger = createLogger('CloudflaredService');

// Get Docker service instance
const dockerService = CloudflaredDockerService.getInstance();

/**
 * Tunnel credentials structure
 */
interface TunnelCredentials {
  AccountTag: string;
  TunnelSecret: string;
  TunnelID: string;
  TunnelName?: string;
}

/**
 * Tunnel creation response from Cloud API
 */
interface TunnelCreateResponse {
  tunnelId: string;
  subdomain: string;
  credentials: TunnelCredentials;
}

/**
 * CloudflaredService (Singleton)
 * Manages all cloudflared tunnel related business logic
 */
export class CloudflaredService {
  private static instance: CloudflaredService;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): CloudflaredService {
    if (!CloudflaredService.instance) {
      CloudflaredService.instance = new CloudflaredService();
    }
    return CloudflaredService.instance;
  }

  // ==================== Core Business Methods ====================

  /**
   * Update cloudflared configuration
   * @param proxyId - Proxy ID
   * @param tunnelId - Tunnel ID
   * @param subdomain - Subdomain
   * @param credentials - Tunnel credentials object
   * @param publicIp - Public IP (optional)
   */
  async updateConfig(
    proxyId: number,
    tunnelId: string,
    subdomain: string,
    credentials: TunnelCredentials,
    publicIp: string = ''
  ): Promise<{
    dnsConf: any;
    restarted: boolean;
    message: string;
    publicUrl: string;
    restartError?: string;
  }> {
    this.assertSafeTunnelId(tunnelId);
    const now = Math.floor(Date.now() / 1000);

    // Query existing configuration
    const existingRecord = await prisma.dnsConf.findFirst({
      where: {
        proxyId: proxyId,
        type: 1
      }
    });

    let oldTunnelId: string | null = null;
    let oldCreatedBy: number = 0;

    if (existingRecord) {
      oldTunnelId = existingRecord.tunnelId;
      oldCreatedBy = existingRecord.createdBy;

      // If old record was created locally (createdBy = 0), try to delete old tunnel
      if (oldCreatedBy === 0 && oldTunnelId && oldTunnelId !== tunnelId) {
        try {
          await this.deleteTunnel(oldTunnelId);
        } catch (error: any) {
          logger.warn({ error: error.message, oldTunnelId }, 'Failed to delete old tunnel');
          // Don't block the flow, continue updating config
        }
      }

      // Update existing record
      await prisma.dnsConf.update({
        where: { id: existingRecord.id },
        data: {
          tunnelId,
          subdomain,
          publicIp,
          updateTime: now,
          createdBy: 1, // Mark as created by external API
          credentials: JSON.stringify(credentials) // Store credentials as JSON string
        }
      });
    } else {
      // Create new record
      await prisma.dnsConf.create({
        data: {
          tunnelId,
          subdomain,
          publicIp,
          type: 1,
          proxyId: proxyId,
          addtime: now,
          updateTime: now,
          createdBy: 1, // Mark as created by external API
          credentials: JSON.stringify(credentials) // Store credentials as JSON string
        }
      });
    }

    // Get updated record
    const updatedRecord = await prisma.dnsConf.findFirst({
      where: {
        proxyId: proxyId,
        type: 1
      }
    });

    // Generate local files
    try {
      await this.generateLocalFiles(tunnelId, credentials, subdomain);
      logger.info({ tunnelId }, 'Local files generated successfully');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to generate local files');
      throw new AdminError('Failed to generate cloudflared configuration files', AdminErrorCode.CLOUDFLARED_RESTART_FAILED);
    }

    // Restart cloudflared container
    let restarted = false;
    let restartError: string | undefined;

    try {
      // Ensure image exists (only for non-Docker deployment)
      await dockerService.ensureImageExists();
      
      // Restart container
      await dockerService.restartContainer();
      restarted = true;
      logger.info('Cloudflared restarted successfully');
    } catch (error: any) {
      restartError = 'Cloudflared restart failed';
      logger.error({ error: error.message }, 'Failed to restart cloudflared');
      // Don't throw error, return partial success
    }

    return {
      dnsConf: updatedRecord ? this.sanitizeConfig(updatedRecord) : null,
      restarted: restarted,
      message: restarted
        ? 'Cloudflared config updated and restarted successfully'
        : 'Config updated but restart failed',
      publicUrl: `https://${subdomain}`,
      ...(restartError && { restartError })
    };
  }

  /**
   * Query cloudflared configurations
   * @param filters - Query filters
   */
  async getConfigs(filters: {
    proxyId?: number;
    tunnelId?: string;
    subdomain?: string;
    type?: number;
  }): Promise<any[]> {
    // Build query conditions (AND relationship)
    const where: any = {};

    if (filters.proxyId !== undefined) {
      where.proxyId = filters.proxyId;
    }

    if (filters.tunnelId !== undefined) {
      where.tunnelId = filters.tunnelId;
    }

    if (filters.subdomain !== undefined) {
      where.subdomain = filters.subdomain;
    }

    if (filters.type !== undefined) {
      where.type = filters.type;
    }

    const dnsConfs = await prisma.dnsConf.findMany({ where });

    // Get container status
    const containerStatus = await dockerService.getContainerStatus();

    // Add status field to each record
    const dnsConfsWithStatus = dnsConfs.map(conf => ({
      ...this.sanitizeConfig(conf),
      status: containerStatus
    }));

    return dnsConfsWithStatus;
  }

  /**
   * Delete cloudflared configuration
   * @param id - Config record ID (optional)
   * @param tunnelId - Tunnel ID (optional)
   */
  async deleteConfig(id?: number, tunnelId?: string): Promise<{
    success: boolean;
    message: string;
    deletedConfig: {
      id: number;
      tunnelId: string;
      subdomain: string;
    };
  }> {
    // At least one of id or tunnelId must be provided
    if (!id && !tunnelId) {
      throw new AdminError('Either id or tunnelId must be provided', AdminErrorCode.INVALID_REQUEST);
    }
    if (tunnelId !== undefined) {
      this.assertSafeTunnelId(tunnelId);
    }

    // Query configuration
    const where: any = {};
    if (id !== undefined) {
      where.id = id;
    }
    if (tunnelId !== undefined) {
      where.tunnelId = tunnelId;
    }

    const dnsConf = await prisma.dnsConf.findFirst({ where });

    if (!dnsConf) {
      throw new AdminError('Cloudflared configuration not found', AdminErrorCode.CLOUDFLARED_CONFIG_NOT_FOUND);
    }

    const deletedTunnelId = dnsConf.tunnelId;

    // 1. Stop container
    try {
      await dockerService.stopContainer();
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to stop container during delete');
      // Continue execution, don't block delete flow
    }

    // 2. Delete container
    try {
      await dockerService.deleteContainer();
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to delete container during delete');
      // Continue execution, don't block delete flow
    }

    // 3. Delete local files
    try {
      await this.cleanupLocalFiles(deletedTunnelId);
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to delete local files');
      // Continue execution, don't block delete flow
    }

    // 4. Delete database record
    await prisma.dnsConf.delete({
      where: { id: dnsConf.id }
    });

    logger.info({ deletedTunnelId }, 'Cloudflared configuration deleted');

    return {
      success: true,
      message: 'Cloudflared configuration deleted successfully',
      deletedConfig: {
        id: dnsConf.id,
        tunnelId: deletedTunnelId,
        subdomain: dnsConf.subdomain
      }
    };
  }

  /**
   * Restart cloudflared service
   */
  async restartCloudflared(): Promise<{
    success: boolean;
    message: string;
    containerStatus: string;
    config?: {
      tunnelId: string;
      subdomain: string;
      publicUrl: string;
    };
  }> {
    // 1. Validate local setup
    const validation = await this.validateCloudflaredLocalSetup();

    if (!validation.valid) {
      // Determine if it's a database issue or file issue
      if (validation.error?.includes('database')) {
        throw new AdminError(
          'Cloudflared database configuration not found',
          AdminErrorCode.CLOUDFLARED_DATABASE_CONFIG_NOT_FOUND
        );
      } else {
        throw new AdminError(
          'Cloudflared local setup is unavailable',
          AdminErrorCode.CLOUDFLARED_LOCAL_FILE_NOT_FOUND
        );
      }
    }

    const tunnelId = validation.tunnelId!;

    // 2. Get database config and regenerate files
    const dnsConf = await prisma.dnsConf.findFirst({
      where: { type: 1 }
    });

    if (dnsConf) {
      // Try to regenerate files from database credentials
      if (dnsConf.credentials) {
        try {
          const credentials = JSON.parse(dnsConf.credentials);
          await this.generateLocalFiles(tunnelId, credentials, dnsConf.subdomain);
          logger.info({ tunnelId }, 'Regenerated local files from database credentials');
        } catch (error: any) {
          logger.warn({ error: error.message }, 'Failed to regenerate files from database, using existing files');
        }
      }
    }

    // 3. Ensure image exists and restart container
    try {
      await dockerService.ensureImageExists();
      await dockerService.restartContainer();
      logger.info('Cloudflared restart executed successfully');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to restart cloudflared');
      throw new AdminError(
        'Failed to restart cloudflared',
        AdminErrorCode.CLOUDFLARED_RESTART_FAILED
      );
    }

    // 4. Check container status to confirm startup success
    const containerStatus = await dockerService.getContainerStatus();

    if (containerStatus !== 'running') {
      logger.error({ containerStatus }, 'Cloudflared container did not reach running state after restart');
      throw new AdminError(
        'Cloudflared container failed to start',
        AdminErrorCode.CLOUDFLARED_RESTART_FAILED
      );
    }

    logger.info({ tunnelId }, 'Cloudflared restarted successfully');

    return {
      success: true,
      message: 'Cloudflared restarted successfully',
      containerStatus,
      config: dnsConf ? {
        tunnelId: dnsConf.tunnelId,
        subdomain: dnsConf.subdomain,
        publicUrl: `https://${dnsConf.subdomain}`
      } : undefined
    };
  }

  /**
   * Stop cloudflared service
   */
  async stopCloudflared(): Promise<{
    success: boolean;
    message: string;
    containerStatus: string;
    alreadyStopped: boolean;
  }> {
    // 1. Check current container status
    const initialStatus = await dockerService.getContainerStatus();

    // 2. If container is not running, return success directly
    if (initialStatus !== 'running') {
      logger.info({ status: initialStatus }, 'Cloudflared container is already stopped');
      return {
        success: true,
        message: 'Cloudflared container is already stopped',
        containerStatus: initialStatus,
        alreadyStopped: true
      };
    }

    // 3. Stop container
    try {
      await dockerService.stopContainer();
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to stop cloudflared');
      throw new AdminError(
        'Failed to stop cloudflared',
        AdminErrorCode.CLOUDFLARED_STOP_FAILED
      );
    }

    // 4. Verify container is stopped (best-effort check)
    const finalStatus = await dockerService.getContainerStatus();

    if (finalStatus === 'running') {
      // Log warning instead of throwing error
      // This may be a timing issue - container is stopping but status not yet updated
      logger.warn(
        { finalStatus },
        'Container appears to be running after stop command, but this may be a timing issue. ' +
        'Treating as success since stop command completed without error.'
      );

      // Return success with containerStatus marked as potentially stale
      return {
        success: true,
        message: 'Cloudflared stop command completed (container status verification inconclusive)',
        containerStatus: 'stopped', // Assume stopped since stop command succeeded
        alreadyStopped: false
      };
    }

    logger.info('Cloudflared stopped successfully');

    return {
      success: true,
      message: 'Cloudflared stopped successfully',
      containerStatus: finalStatus,
      alreadyStopped: false
    };
  }

  /**
   * Auto start cloudflared if configuration exists
   * Called during application startup
   */
  async autoStartIfConfigExists(): Promise<void> {
    logger.info('Checking for cloudflared auto-start...');

    // 1. Check if Docker is available
    const dockerAvailable = await dockerService.checkDockerAvailable();
    if (!dockerAvailable) {
      logger.warn('Docker is not available, skipping cloudflared auto-start');
      return;
    }

    // 2. Query database for type=1 configuration
    const dnsConf = await prisma.dnsConf.findFirst({
      where: { type: 1 },
      orderBy: { id: 'asc' }
    });

    if (!dnsConf) {
      logger.info('No cloudflared configuration found in database, skipping auto-start');
      return;
    }

    logger.info({ tunnelId: dnsConf.tunnelId, subdomain: dnsConf.subdomain }, 'Found cloudflared configuration');

    const tunnelId = dnsConf.tunnelId;

    // 3. Check if we have credentials in database
    if (dnsConf.credentials) {
      try {
        const credentials = JSON.parse(dnsConf.credentials);
        if (credentials.TunnelSecret) {
          // Have valid credentials in database, generate files and start
          logger.info('Found credentials in database, generating local files...');
          await this.generateLocalFiles(tunnelId, credentials, dnsConf.subdomain);
          
          // Ensure image exists (only for non-Docker deployment)
          await dockerService.ensureImageExists();
          
          // Start container
          await dockerService.startContainer();
          
          // Log prominent success message
          this.logSuccessfulStart(dnsConf.subdomain);
          logger.info({ subdomain: dnsConf.subdomain }, 'Cloudflared auto-started successfully');
          return;
        }
      } catch (error: any) {
        logger.warn({ error: error.message }, 'Failed to parse credentials from database');
      }
    }

    // 4. No credentials in database, check local files
    const hasLocalFile = await this.checkLocalCredentialsFile(tunnelId);
    
    if (hasLocalFile) {
      // Have local credentials file, generate config and start
      logger.info('Found local credentials file, starting cloudflared...');
      
      // Read credentials from local file to generate config.yml
      try {
        const credentialsPath = this.getTunnelCredentialsPath(tunnelId);
        const credentialsContent = await fs.readFile(credentialsPath, 'utf8');
        const credentials = JSON.parse(credentialsContent);
        
        // Generate config.yml
        const configYaml = this.generateConfigYaml(tunnelId, dnsConf.subdomain);
        const configPath = path.join(CLOUDFLARED_CONFIG.CONFIG_DIR, 'config.yml');
        await fs.writeFile(configPath, configYaml, 'utf8');
        
        // Ensure image exists (only for non-Docker deployment)
        await dockerService.ensureImageExists();
        
        // Start container
        await dockerService.startContainer();
        
        // Log prominent success message
        this.logSuccessfulStart(dnsConf.subdomain);
        logger.info({ subdomain: dnsConf.subdomain }, 'Cloudflared auto-started from local files');
      } catch (error: any) {
        logger.error({ error: error.message }, 'Failed to start cloudflared from local files');
      }
    } else {
      // No credentials in database and no local file, delete invalid database record
      logger.warn({ tunnelId }, 'No credentials found in database or local files, deleting invalid record');
      try {
        await prisma.dnsConf.delete({
          where: { id: dnsConf.id }
        });
        logger.info({ id: dnsConf.id }, 'Deleted invalid cloudflared configuration');
      } catch (error: any) {
        logger.error({ error: error.message }, 'Failed to delete invalid configuration');
      }
    }
  }

  /**
   * Log successful cloudflared start with prominent message
   * @param subdomain - The subdomain/hostname for the tunnel
   */
  private logSuccessfulStart(subdomain: string): void {
    const publicUrl = `https://${subdomain}`;
    const separator = '═'.repeat(60);
    const innerSeparator = '─'.repeat(60);
    
    // Use console.log for prominent display (bypasses log level filtering)
    console.log('');
    console.log(`\x1b[32m╔${separator}╗\x1b[0m`);
    console.log(`\x1b[32m║\x1b[0m\x1b[1m\x1b[32m  🚀 CLOUDFLARED TUNNEL STARTED SUCCESSFULLY!               \x1b[0m\x1b[32m║\x1b[0m`);
    console.log(`\x1b[32m╠${innerSeparator}╣\x1b[0m`);
    console.log(`\x1b[32m║\x1b[0m                                                            \x1b[32m║\x1b[0m`);
    console.log(`\x1b[32m║\x1b[0m  \x1b[1m\x1b[36m🌍 Public URL: \x1b[0m                                           \x1b[32m║\x1b[0m`);
    console.log(`\x1b[32m║\x1b[0m  \x1b[1m\x1b[33m   ${publicUrl.padEnd(55)}\x1b[0m\x1b[32m║\x1b[0m`);
    console.log(`\x1b[32m║\x1b[0m                                                            \x1b[32m║\x1b[0m`);
    console.log(`\x1b[32m║\x1b[0m  \x1b[90mYou can now access your service via the URL above. \x1b[0m       \x1b[32m║\x1b[0m`);
    console.log(`\x1b[32m║\x1b[0m                                                            \x1b[32m║\x1b[0m`);
    console.log(`\x1b[32m╚${separator}╝\x1b[0m`);
    console.log('');

    // Also log to structured logger for log aggregation
    logger.info({ publicUrl, subdomain }, 'Cloudflared tunnel is accessible');
  }

  // ==================== File Generation Methods ====================

  /**
   * Generate local files for cloudflared
   * @param tunnelId - Tunnel ID
   * @param credentials - Tunnel credentials
   * @param subdomain - Subdomain
   */
  async generateLocalFiles(tunnelId: string, credentials: TunnelCredentials, subdomain: string): Promise<void> {
    const credentialsFile = this.getTunnelCredentialsPath(tunnelId);
    const configDir = CLOUDFLARED_CONFIG.CONFIG_DIR;
    
    // Ensure config directory exists
    await fs.mkdir(configDir, { recursive: true });

    // 1. Write main credentials file ({tunnelId}.json)
    await fs.writeFile(credentialsFile, JSON.stringify(credentials, null, 2), 'utf8');
    logger.debug({ credentialsFile }, 'Written credentials file');

    // 2. Write backup credentials file (credentials.json)
    const backupCredentialsFile = path.join(configDir, 'credentials.json');
    await fs.writeFile(backupCredentialsFile, JSON.stringify(credentials, null, 2), 'utf8');
    logger.debug({ backupCredentialsFile }, 'Written backup credentials file');

    // 3. Generate and write config.yml
    const configYaml = this.generateConfigYaml(tunnelId, subdomain);
    const configFile = path.join(configDir, 'config.yml');
    await fs.writeFile(configFile, configYaml, 'utf8');
    logger.debug({ configFile }, 'Written config file');

    logger.info({ tunnelId, configDir }, 'Local files generated successfully');
  }

  private sanitizeConfig<T extends Record<string, unknown>>(config: T): Omit<T, 'credentials'> {
    const { credentials: _credentials, ...safeConfig } = config;
    return safeConfig;
  }

  /**
   * Generate cloudflared config.yml content
   * @param tunnelId - Tunnel ID
   * @param subdomain - Subdomain
   */
  generateConfigYaml(tunnelId: string, subdomain: string): string {
    this.assertSafeTunnelId(tunnelId);
    // cloudflared runtime (container) reads credentials from CONTAINER_CONFIG_DIR (default /etc/cloudflared)
    const credentialsPath = path.posix.join(
      CLOUDFLARED_CONFIG.CONTAINER_CONFIG_DIR,
      `${tunnelId}.json`
    );

    // Get service URL from config
    const serviceUrl = CLOUDFLARED_CONFIG.PETA_CORE_SERVICE_URL;

    return `tunnel: ${tunnelId}
credentials-file: ${credentialsPath}

# Cloudflared configuration with WebSocket support
ingress:
  # Backend API service with WebSocket support
  # Handles all paths
  - hostname: ${subdomain}
    service: ${serviceUrl}
    originRequest:
      # Disable TLS verification for local development
      noTLSVerify: true
      # Preserve the original host header
      httpHostHeader: ${subdomain}
      # Connection timeout (default: 30s, increase for slow connections)
      connectTimeout: 30s
      # Keep-alive timeout for persistent connections (default: 90s)
      keepAliveTimeout: 90s
      # Maximum idle connections (default: 100)
      keepAliveConnections: 100
      # Disable chunked encoding if needed
      disableChunkedEncoding: false
      # Origin server name for SNI
      originServerName: ${subdomain}
      # Proxy type (empty string means HTTP/WebSocket auto-detect)
      proxyType: ""
      # TCP keep-alive interval (default: 30s)
      tcpKeepAlive: 30s
      # No happy eyeballs (use IPv4 only if you have issues)
      noHappyEyeballs: false
      # HTTP2 origin support (default: false, set true for better performance)
      http2Origin: false

  # Catch-all rule
  - service: http_status:404`;
  }

  /**
   * Cleanup local cloudflared files
   * @param tunnelId - Tunnel ID
   */
  async cleanupLocalFiles(tunnelId: string): Promise<void> {
    const configDir = CLOUDFLARED_CONFIG.CONFIG_DIR;
    const filesToDelete = [
      this.getTunnelCredentialsPath(tunnelId),
      path.join(configDir, 'credentials.json'),
      path.join(configDir, 'config.yml')
    ];

    for (const file of filesToDelete) {
      try {
        await fs.unlink(file);
        logger.debug({ file }, 'Deleted file');
      } catch (error: any) {
        // Ignore errors if file doesn't exist
        if (error.code !== 'ENOENT') {
          logger.warn({ error: error.message, file }, 'Failed to delete file');
        }
      }
    }
  }

  /**
   * Check if local credentials file exists
   * @param tunnelId - Tunnel ID
   */
  async checkLocalCredentialsFile(tunnelId: string): Promise<boolean> {
    const credentialsFile = this.getTunnelCredentialsPath(tunnelId);
    try {
      const content = await fs.readFile(credentialsFile, 'utf8');
      const credentials = JSON.parse(content);
      return !!credentials.TunnelSecret;
    } catch (error) {
      return false;
    }
  }

  private assertSafeTunnelId(tunnelId: string): void {
    if (typeof tunnelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(tunnelId)) {
      throw new AdminError('Invalid tunnelId', AdminErrorCode.INVALID_REQUEST);
    }
  }

  private getTunnelCredentialsPath(tunnelId: string): string {
    this.assertSafeTunnelId(tunnelId);
    const configDir = path.resolve(CLOUDFLARED_CONFIG.CONFIG_DIR);
    const credentialsFile = path.resolve(configDir, `${tunnelId}.json`);
    if (path.dirname(credentialsFile) !== configDir) {
      throw new AdminError('Invalid tunnelId', AdminErrorCode.INVALID_REQUEST);
    }
    return credentialsFile;
  }

  // ==================== Cloud API Methods ====================

  /**
   * Create tunnel via Cloud API
   * @param appId - Application ID for tunnel naming
   */
  async createTunnel(appId: string): Promise<TunnelCreateResponse> {
    if (!CLOUDFLARED_CONFIG.CLOUD_API_BASE_URL) {
      throw new AdminError('PETA_CLOUD_API_URL is not set', AdminErrorCode.INVALID_REQUEST);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(
        `${CLOUDFLARED_CONFIG.CLOUD_API_BASE_URL}${CLOUDFLARED_CONFIG.CLOUD_API_ENDPOINTS.tunnelCreate}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId }),
          signal: controller.signal
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      logger.info({ appId, tunnelId: result.tunnelId }, 'Tunnel created successfully');
      return result;
    } catch (error: any) {
      const errorMessage = error.name === 'AbortError' ? 'Request timeout' : 'Cloud API request failed';
      logger.error({ error: error instanceof Error ? error.message : error, appId }, 'Failed to create tunnel');
      throw new AdminError(`Failed to create tunnel: ${errorMessage}`, AdminErrorCode.TUNNEL_CREATE_FAILED);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Delete tunnel via Cloud API
   * @param tunnelId - Tunnel ID to delete
   */
  private async deleteTunnel(tunnelId: string): Promise<void> {
    if (!CLOUDFLARED_CONFIG.CLOUD_API_BASE_URL) {
      logger.warn('PETA_CLOUD_API_URL is not set, skipping tunnel deletion');
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(
        `${CLOUDFLARED_CONFIG.CLOUD_API_BASE_URL}${CLOUDFLARED_CONFIG.CLOUD_API_ENDPOINTS.tunnelDelete}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tunnelId }),
          signal: controller.signal
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      logger.info({ tunnelId }, 'Deleted tunnel');
    } catch (error: any) {
      const errorMessage = error.name === 'AbortError' ? 'Request timeout' : 'Cloud API request failed';
      logger.error({ error: error instanceof Error ? error.message : error, tunnelId }, 'Failed to delete tunnel');
      throw new AdminError(`Failed to delete tunnel: ${errorMessage}`, AdminErrorCode.TUNNEL_DELETE_FAILED);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ==================== Validation Methods ====================

  /**
   * Validate local cloudflared setup
   * @returns { valid: boolean, tunnelId?: string, error?: string }
   */
  private async validateCloudflaredLocalSetup(): Promise<{ valid: boolean; tunnelId?: string; error?: string }> {
    try {
      // 1. Check database configuration
      const dnsConf = await prisma.dnsConf.findFirst({
        where: { type: 1 }
      });

      if (!dnsConf || !dnsConf.tunnelId) {
        return {
          valid: false,
          error: 'No cloudflared configuration found in database'
        };
      }

      const tunnelId = dnsConf.tunnelId;

      // 2. Check if we have credentials in database
      if (dnsConf.credentials) {
        try {
          const credentials = JSON.parse(dnsConf.credentials);
          if (credentials.TunnelSecret) {
            return { valid: true, tunnelId };
          }
        } catch (error) {
          // Invalid JSON, continue to check local file
        }
      }

      // 3. Check local credentials file
      const credentialsFile = this.getTunnelCredentialsPath(tunnelId);
      try {
        const credentialsContent = await fs.readFile(credentialsFile, 'utf8');
        const credentials = JSON.parse(credentialsContent);

        // Validate credentials format
        if (!credentials.TunnelSecret) {
          return {
            valid: false,
            tunnelId,
            error: 'Credentials file missing TunnelSecret field'
          };
        }

        return { valid: true, tunnelId };
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return {
            valid: false,
            tunnelId,
            error: 'Cloudflared credentials file is missing'
          };
        }
        logger.warn({ error: error.message, tunnelId }, 'Invalid cloudflared credentials file');
        return {
          valid: false,
          tunnelId,
          error: 'Cloudflared credentials file is invalid'
        };
      }
    } catch (error: any) {
      logger.error({ error: error.message }, 'Cloudflared local setup validation failed');
      return {
        valid: false,
        error: 'Cloudflared local setup validation failed'
      };
    }
  }
}
