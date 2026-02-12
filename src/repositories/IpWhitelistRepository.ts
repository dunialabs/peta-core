/**
 * IP Whitelist Repository - Direct database access using Prisma
 */

import { prisma } from '../config/prisma.js';
import { IpWhitelist } from '@prisma/client';

export class IpWhitelistRepository {
  /**
   * Get all IP whitelist records
   */
  static async findAll(): Promise<IpWhitelist[]> {
    return await prisma.ipWhitelist.findMany({
      orderBy: { id: 'asc' }
    });
  }

  /**
   * Find record by IP address
   */
  static async findByIp(ip: string): Promise<IpWhitelist | null> {
    return await prisma.ipWhitelist.findFirst({
      where: { ip }
    });
  }

  /**
   * Create new IP whitelist record
   */
  static async create(ip: string): Promise<IpWhitelist> {
    return await prisma.ipWhitelist.create({
      data: {
        ip,
        addtime: Math.floor(Date.now() / 1000) // Unix timestamp
      }
    });
  }

  /**
   * Bulk create IP whitelist records
   */
  static async bulkCreate(ips: string[]): Promise<number> {
    const timestamp = Math.floor(Date.now() / 1000);
    const data = ips.map(ip => ({
      ip,
      addtime: timestamp
    }));

    const result = await prisma.ipWhitelist.createMany({
      data,
      skipDuplicates: true // Skip duplicate IPs
    });

    return result.count;
  }

  /**
   * Delete specified IP whitelist record
   */
  static async deleteByIp(ip: string): Promise<boolean> {
    try {
      await prisma.ipWhitelist.deleteMany({
        where: { ip }
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete record by specified ID
   */
  static async deleteById(id: number): Promise<boolean> {
    try {
      await prisma.ipWhitelist.delete({
        where: { id }
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear all IP whitelist records
   */
  static async deleteAll(): Promise<number> {
    const result = await prisma.ipWhitelist.deleteMany({});
    return result.count;
  }

  /**
   * Replace all IP whitelist records
   * Clear first, then bulk create
   */
  static async replaceAll(ips: string[]): Promise<number> {
    // Use transaction to ensure atomicity
    return await prisma.$transaction(async (tx) => {
      // Clear existing records
      await tx.ipWhitelist.deleteMany({});
      
      // If no new records, return directly
      if (ips.length === 0) {
        return 0;
      }

      // Bulk create new records
      const timestamp = Math.floor(Date.now() / 1000);
      const data = ips.map(ip => ({
        ip,
        addtime: timestamp
      }));

      const result = await tx.ipWhitelist.createMany({
        data
      });

      return result.count;
    });
  }

  /**
   * Get IP whitelist count
   */
  static async count(): Promise<number> {
    return await prisma.ipWhitelist.count();
  }

  /**
   * Check if IP is in whitelist
   * Note: This only checks exact match, does not handle CIDR
   */
  static async exists(ip: string): Promise<boolean> {
    const count = await prisma.ipWhitelist.count({
      where: { ip }
    });
    return count > 0;
  }

  /**
   * Batch delete by ID array
   */
  static async deleteByIds(ids: number[]): Promise<number> {
    const result = await prisma.ipWhitelist.deleteMany({
      where: {
        id: { in: ids }
      }
    });
    return result.count;
  }

  /**
   * Bulk create IP whitelist records (for restore)
   * Note: Unlike bulkCreate, this method does not skip duplicates
   */
  static async bulkCreateForRestore(ips: Array<{ip: string, addtime: number}>): Promise<number> {
    const result = await prisma.ipWhitelist.createMany({
      data: ips
    });
    return result.count;
  }
}