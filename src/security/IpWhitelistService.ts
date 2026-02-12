import { LogService } from '../log/LogService.js';
import { IpWhitelistRepository } from '../repositories/IpWhitelistRepository.js';
import { createLogger } from '../logger/index.js';

/**
 * IP whitelist service
 * Manages and validates IP access whitelist
 */
export class IpWhitelistService {
  // In-memory whitelist configuration, default allows all access
  private whitelist: string[] = ["0.0.0.0/0"];
  // Cache expiry time (15 minutes)
  private cacheExpiry: number = 15 * 60 * 1000;
  private lastCacheUpdate: number = 0;
  // Whether initialized
  private initialized: boolean = false;
  
  // Logger for IpWhitelistService
  private logger = createLogger('IpWhitelistService');

  constructor() {
    // Automatically initialize when service starts
    this.initialize().catch(error => {
      this.logger.error({ error }, 'Failed to initialize IP whitelist service');
    });
  }

  /**
   * Initialize service, load whitelist from database
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await this.loadFromDatabase();
      this.initialized = true;
      this.logger.info({ entryCount: this.whitelist.length }, 'Initialized');
    } catch (error) {
      this.logger.error({ error }, 'Failed to initialize');
      // On initialization failure, keep default value (allow all)
      this.whitelist = ["0.0.0.0/0"];
    }
  }

  /**
   * Load IP whitelist from database
   */
  private async loadFromDatabase(): Promise<void> {
    try {
      const records = await IpWhitelistRepository.findAll();
      
      if (records.length === 0) {
        // If database is empty, use default value (allow all)
        this.whitelist = ["0.0.0.0/0"];
      } else {
        // Extract IP addresses from database records
        this.whitelist = records.map(record => record.ip);
      }
      
      this.lastCacheUpdate = Date.now();
      
      if (LogService.getInstance()) {
        this.logger.debug({ entryCount: this.whitelist.length }, 'Loaded entries from database');
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to load from database');
      throw error;
    }
  }

  /**
   * Get IP whitelist configuration
   * Returns from memory cache, periodically refreshes from database
   */
  async getIpWhitelist(): Promise<string[]> {
    // If cache expired, reload from database
    const now = Date.now();
    if (now - this.lastCacheUpdate > this.cacheExpiry) {
      try {
        await this.loadFromDatabase();
      } catch (error) {
        this.logger.error({ error }, 'Failed to refresh cache');
        // On refresh failure, continue using cached data
      }
    }
    
    return this.whitelist;
  }

  /**
   * Update IP whitelist configuration
   * Updates both database and memory
   */
  // async updateIpWhitelist(whitelist: string[]): Promise<void> {
  //   // Validate whitelist format
  //   for (const entry of whitelist) {
  //     if (!this.isValidIpOrCidr(entry)) {
  //       throw new Error(`Invalid IP/CIDR format: ${entry}`);
  //     }
  //   }

  //   try {
  //     // Update database
  //     await IpWhitelistRepository.replaceAll(whitelist);
      
  //     // Update in-memory configuration
  //     this.whitelist = whitelist;
  //     this.lastCacheUpdate = Date.now();

  //     // Log
  //     const isEnabled = !whitelist.includes("0.0.0.0/0");
  //     console.log(`[IpWhitelistService] Whitelist updated. Enabled: ${isEnabled}, Count: ${whitelist.length}`);
      
  //   } catch (error) {
  //     console.error('[IpWhitelistService] Failed to update whitelist:', error);
  //     throw new Error(`Failed to update IP whitelist: ${error instanceof Error ? error.message : String(error)}`);
  //   }
  // }

  /**
   * Reload IP whitelist from database
   * Used to respond to UPDATE_IP_WHITELIST requests
   */
  async reloadFromDatabase(): Promise<string[]> {
    await this.loadFromDatabase();
    return this.whitelist;
  }

  /**
   * Check if IP is allowed to access
   */
  async isIpAllowed(clientIp: string): Promise<boolean> {
    const whitelist = await this.getIpWhitelist();
    
    // If whitelist contains "0.0.0.0/0", allow all access
    if (whitelist.includes("0.0.0.0/0")) {
      return true;
    }
    
    // Check if IP is in whitelist
    for (const entry of whitelist) {
      if (this.isIpMatch(clientIp, entry)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Validate if IP or CIDR format is valid
   */
  private isValidIpOrCidr(entry: string): boolean {
    // Special handling for 0.0.0.0/0
    if (entry === "0.0.0.0/0") {
      return true;
    }

    // Check if contains CIDR notation
    if (entry.includes('/')) {
      const [ip, bits] = entry.split('/');
      const bitsNum = parseInt(bits);
      
      // Validate CIDR bits
      if (isNaN(bitsNum) || bitsNum < 0 || bitsNum > 32) {
        return false;
      }
      
      // Validate IP part
      return this.isValidIp(ip);
    } else {
      // Single IP address
      return this.isValidIp(entry);
    }
  }

  /**
   * Validate IP address format
   */
  private isValidIp(ip: string): boolean {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      return false;
    }
    
    for (const part of parts) {
      const num = parseInt(part);
      if (isNaN(num) || num < 0 || num > 255 || part !== num.toString()) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Check if IP matches pattern (supports single IP and CIDR)
   */
  private isIpMatch(ip: string, pattern: string): boolean {
    // Handle IPv6-mapped IPv4 addresses
    const normalizedIp = this.normalizeIp(ip);
    
    // If exact IP match
    if (!pattern.includes('/')) {
      return normalizedIp === pattern;
    }
    
    // CIDR matching
    try {
      const [network, bits] = pattern.split('/');
      const bitsNum = parseInt(bits);
      
      // Special handling for /0 (matches all)
      if (bitsNum === 0) {
        return true;
      }
      
      // Create subnet mask
      const mask = (0xffffffff << (32 - bitsNum)) >>> 0;
      
      // Convert IP to number
      const ipNum = this.ipToNumber(normalizedIp);
      const networkNum = this.ipToNumber(network);
      
      // Check if IP is within network segment
      return (ipNum & mask) === (networkNum & mask);
    } catch (error) {
      this.logger.error({ error, ip, pattern }, 'Error matching IP with pattern');
      return false;
    }
  }

  /**
   * Normalize IP address (handle IPv6-mapped IPv4)
   */
  private normalizeIp(ip: string): string {
    // Handle ::ffff:192.168.1.1 format
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    
    // Handle ::1 (IPv6 localhost)
    if (ip === '::1') {
      return '127.0.0.1';
    }
    
    return ip;
  }

  /**
   * Convert IP address to number
   */
  private ipToNumber(ip: string): number {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      throw new Error(`Invalid IP address: ${ip}`);
    }
    
    let result = 0;
    for (let i = 0; i < 4; i++) {
      const num = parseInt(parts[i]);
      if (isNaN(num) || num < 0 || num > 255) {
        throw new Error(`Invalid IP address: ${ip}`);
      }
      result = (result << 8) + num;
    }
    
    return result >>> 0; // Convert to unsigned 32-bit integer
  }

  /**
   * Clear cache (for testing or forced refresh)
   */
  clearCache(): void {
    this.lastCacheUpdate = 0;
  }

  /**
   * Get current whitelist status (for debugging)
   */
  getStatus(): { whitelist: string[], isEnabled: boolean } {
    const isEnabled = !this.whitelist.includes("0.0.0.0/0");
    return {
      whitelist: this.whitelist,
      isEnabled
    };
  }
}