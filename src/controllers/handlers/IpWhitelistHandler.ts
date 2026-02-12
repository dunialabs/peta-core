import { IpWhitelistRepository } from '../../repositories/IpWhitelistRepository.js';
import { IpWhitelistService } from '../../security/IpWhitelistService.js';
import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { AuthUtils } from '../../utils/AuthUtils.js';
import { prisma } from '../../config/prisma.js';

/**
 * IP whitelist operation handler (4000-4999)
 */
export class IpWhitelistHandler {

  constructor(
    private ipWhitelistService: IpWhitelistService
  ) {}

  /**
   * Update IP whitelist (4001)
   * Save to database, then reload into memory
   */
  async handleUpdateIpWhitelist(request: AdminRequest<any>): Promise<any> {
    const { whitelist } = request.data;

    if (!Array.isArray(whitelist)) {
      throw new AdminError('Invalid whitelist format', AdminErrorCode.INVALID_REQUEST);
    }

    const timestamp = Math.floor(Date.now() / 1000);

    // 1. Save to database (using transaction)
    await prisma.$transaction(async (tx) => {
      // Delete all existing records
      await tx.ipWhitelist.deleteMany({});

      // Insert new records
      if (whitelist.length > 0) {
        const data = whitelist.map((ip: string) => ({
          ip,
          addtime: timestamp
        }));
        await tx.ipWhitelist.createMany({ data });
      }
    });

    // 2. Reload from database into memory
    const loadedWhitelist = await this.ipWhitelistService.reloadFromDatabase();

    // Log audit event
    AuthUtils.logAuthEvent('whitelist_updated', undefined, undefined, true,
      `Updated whitelist with ${whitelist.length} IPs, loaded ${loadedWhitelist.length} IPs into memory`
    );

    return {
      whitelist: loadedWhitelist,
      message: `IP whitelist updated successfully. ${loadedWhitelist.length} IPs loaded.`
    };
  }

  /**
   * Get IP whitelist (4002)
   */
  async handleGetIpWhitelist(request: AdminRequest<any>): Promise<any> {
    const records = await IpWhitelistRepository.findAll();
    const whitelist = records.map(record => record.ip);
    
    let list: string[];
    if (whitelist.length === 0) {
      list = ["0.0.0.0/0"];
    } else {
      const nonWildcardRecords = records.filter(r => r.ip !== '0.0.0.0/0');
      if (nonWildcardRecords.length > 0) {
        list = ["0.0.0.0/0"];
      } else {
        list = whitelist;
      }
    }

    return {
      whitelist: list,
      count: list.length
    };
  }

  /**
   * Delete IP whitelist records (4003)
   */
  async handleDeleteIpWhitelist(request: AdminRequest<any>): Promise<any> {
    const { ips } = request.data;

    if (!Array.isArray(ips) || ips.length === 0) {
      throw new AdminError('Invalid ips array', AdminErrorCode.INVALID_REQUEST);
    }

    // Find IDs of records to delete
    const records = await prisma.ipWhitelist.findMany({
      where: { ip: { in: ips } }
    });

    if (records.length === 0) {
      return {
        deletedCount: 0,
        message: 'No matching IPs found'
      };
    }

    const ids = records.map(r => r.id);

    // Delete from database
    await IpWhitelistRepository.deleteByIds(ids);

    // Reload from database into memory
    await this.ipWhitelistService.reloadFromDatabase();

    // Log audit event
    AuthUtils.logAuthEvent('whitelist_ips_deleted', undefined, undefined, true,
      `Deleted ${records.length} IPs from whitelist: ${ips.join(', ')}`
    );

    return {
      deletedCount: records.length,
      message: `${records.length} IP(s) deleted from whitelist`
    };
  }

  /**
   * Add IPs to whitelist (4004)
   * Append mode: does not delete existing IPs, only adds new IPs
   */
  async handleAddIpWhitelist(request: AdminRequest<any>): Promise<any> {
    const { ips } = request.data;

    // Validate parameters
    if (!Array.isArray(ips) || ips.length === 0) {
      throw new AdminError('Invalid ips array', AdminErrorCode.INVALID_REQUEST);
    }

    // Validate IP format
    for (const ip of ips) {
      if (!this.isValidIpOrCidr(ip)) {
        throw new AdminError(`Invalid IP/CIDR format: ${ip}`, AdminErrorCode.INVALID_IP_FORMAT);
      }
    }

    // Query existing IPs
    const existingRecords = await prisma.ipWhitelist.findMany({
      where: { ip: { in: ips } }
    });
    const existingIps = new Set(existingRecords.map(r => r.ip));

    // Filter out new IPs that need to be added
    const newIps = ips.filter(ip => !existingIps.has(ip));

    let addedIds: number[] = [];

    if (newIps.length > 0) {
      // Bulk create new records
      const timestamp = Math.floor(Date.now() / 1000);
      const data = newIps.map(ip => ({
        ip,
        addtime: timestamp
      }));

      await prisma.ipWhitelist.createMany({ data });

      // Query IDs of just added records
      const addedRecords = await prisma.ipWhitelist.findMany({
        where: { ip: { in: newIps } }
      });
      addedIds = addedRecords.map(r => r.id);
    }

    // Reload from database into memory
    await this.ipWhitelistService.reloadFromDatabase();

    // Log audit event
    AuthUtils.logAuthEvent('whitelist_ips_added', undefined, undefined, true,
      `Added ${newIps.length} new IPs (skipped ${ips.length - newIps.length} duplicates): ${newIps.join(', ')}`
    );

    return {
      addedIds: addedIds,
      addedCount: newIps.length,
      skippedCount: ips.length - newIps.length,
      message: `${newIps.length} IP(s) added to whitelist, ${ips.length - newIps.length} skipped (duplicates)`
    };
  }

  /**
   * Special IP whitelist operation (4005)
   * Controls IP filtering function switch:
   * - allow-all: Add 0.0.0.0/0, disable IP filtering, allow all IPs to access
   * - deny-all: Delete 0.0.0.0/0, enable IP filtering, only allow IPs in whitelist to access
   */
  async handleSpecialIpWhitelistOperation(request: AdminRequest<any>): Promise<any> {
    const { operation } = request.data;

    // Validate operation parameter
    if (!operation || !['allow-all', 'deny-all'].includes(operation)) {
      throw new AdminError('Invalid operation. Must be "allow-all" or "deny-all"', AdminErrorCode.INVALID_REQUEST);
    }

    if (operation === 'allow-all') {
      // Check if 0.0.0.0/0 already exists
      const existing = await prisma.ipWhitelist.findFirst({
        where: { ip: '0.0.0.0/0' }
      });

      if (!existing) {
        // If not exists, add it
        const timestamp = Math.floor(Date.now() / 1000);
        await prisma.ipWhitelist.create({
          data: {
            ip: '0.0.0.0/0',
            addtime: timestamp
          }
        });

        // Log audit event
        AuthUtils.logAuthEvent('whitelist_allow_all', undefined, undefined, true,
          'Added 0.0.0.0/0 to whitelist - IP filtering disabled (allow all IPs)'
        );
      } else {
        // Already exists, log
        AuthUtils.logAuthEvent('whitelist_allow_all', undefined, undefined, true,
          '0.0.0.0/0 already exists in whitelist - IP filtering already disabled'
        );
      }
    } else if (operation === 'deny-all') {
      // Check if there are other IP configurations
      const allRecords = await prisma.ipWhitelist.findMany();
      const nonWildcardRecords = allRecords.filter(r => r.ip !== '0.0.0.0/0');

      if (nonWildcardRecords.length > 0) {
        // Delete all 0.0.0.0/0 records
        const result = await prisma.ipWhitelist.deleteMany({
          where: { ip: '0.0.0.0/0' }
        });
        // Log audit event
        AuthUtils.logAuthEvent('whitelist_deny_all', undefined, undefined, true,
          `Removed ${result.count} 0.0.0.0/0 records - IP filtering enabled (${nonWildcardRecords.length} IPs in whitelist)`
        );
      }
    }

    // Reload from database into memory
    await this.ipWhitelistService.reloadFromDatabase();

    return null;
  }

  // ==================== Helper Methods ====================

  /**
   * Validate IP or CIDR format
   */
  private isValidIpOrCidr(entry: string): boolean {
    if (entry === "0.0.0.0/0") {
      return true;
    }

    if (entry.includes('/')) {
      const [ip, bits] = entry.split('/');
      const bitsNum = parseInt(bits);

      if (isNaN(bitsNum) || bitsNum < 0 || bitsNum > 32) {
        return false;
      }

      return this.isValidIp(ip);
    } else {
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
}
