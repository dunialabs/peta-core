/**
 * Server Repository - Direct database access using Prisma
 */

import { prisma } from '../config/prisma.js';
import { Prisma, Server } from '@prisma/client';

export class ServerRepository {
  /**
   * Find server by server ID
   */
  static async findByServerId(serverId: string): Promise<Server | null> {
    return await prisma.server.findUnique({
      where: { serverId }
    });
  }

  /**
   * Find all servers
   */
  static async findAll(): Promise<Server[]> {
    return await prisma.server.findMany();
  }

  /**
   * Find all enabled servers
   */
  static async findEnabled(): Promise<Server[]> {
    try {
      return await prisma.server.findMany({
        where: { enabled: true }
      });
    } catch (error) {
      // Database errors should be handled by caller, here just return empty array
      return [];
    }
  }

  /**
   * Create new server
   */
  static async create(data: Prisma.ServerCreateInput): Promise<Server> {
    return await prisma.server.create({ data });
  }

  /**
   * Update server
   */
  static async update(serverId: string, data: Prisma.ServerUpdateInput): Promise<Server> {
    return await prisma.server.update({
      where: { serverId },
      data: { ...data, updatedAt: Math.floor(Date.now() / 1000) }
    });
  }

  /**
   * Create or update server
   */
  static async upsert(
    serverId: string,
    create: Prisma.ServerCreateInput,
    update: Prisma.ServerUpdateInput
  ): Promise<Server> {
    return await prisma.server.upsert({
      where: { serverId },
      create,
      update
    });
  }

  /**
   * Delete server
   */
  static async delete(serverId: string): Promise<Server> {
    return await prisma.server.delete({
      where: { serverId }
    });
  }

  /**
   * Enable server
   */
  static async enable(serverId: string): Promise<Server> {
    return await prisma.server.update({
      where: { serverId },
      data: { enabled: true }
    });
  }

  /**
   * Disable server
   */
  static async disable(serverId: string): Promise<Server> {
    return await prisma.server.update({
      where: { serverId },
      data: { enabled: false }
    });
  }

  /**
   * Check if server exists
   */
  static async exists(serverId: string): Promise<boolean> {
    const server = await prisma.server.findUnique({
      where: { serverId },
      select: { serverId: true }
    });
    return server !== null;
  }

  /**
   * Update server capabilities
   */
  static async updateCapabilities(serverId: string, capabilities: string): Promise<Server> {
    return await prisma.server.update({
      where: { serverId },
      data: {
        capabilities: typeof capabilities === 'string' 
          ? capabilities 
          : JSON.stringify(capabilities),
        updatedAt: Math.floor(Date.now() / 1000)
      }
    });
  }

  /**
   * Update launch configuration
   */
  static async updateLaunchConfig(serverId: string, launchConfig: string): Promise<Server> {
    return await prisma.server.update({
      where: { serverId },
      data: {
        launchConfig: launchConfig,
        updatedAt: Math.floor(Date.now() / 1000)
      }
    });
  }

  /**
   * Find servers by proxy ID
   */
  static async findByProxyId(proxyId: number): Promise<Server[]> {
    return await prisma.server.findMany({
      where: { proxyId }
    });
  }

  /**
   * Count all servers
   */
  static async countAll(): Promise<number> {
    return await prisma.server.count();
  }

  /**
   * Batch delete servers by proxyId
   */
  static async deleteByProxyId(proxyId: number): Promise<number> {
    const result = await prisma.server.deleteMany({
      where: { proxyId }
    });
    return result.count;
  }

  /**
   * Bulk create servers (for restore)
   */
  static async bulkCreate(servers: Prisma.ServerCreateManyInput[]): Promise<number> {
    const result = await prisma.server.createMany({
      data: servers,
      skipDuplicates: true
    });
    return result.count;
  }

  /**
   * Count servers by condition
   */
  static async countByCondition(where: Prisma.ServerWhereInput): Promise<number> {
    return await prisma.server.count({ where });
  }

  /**
   * Update server capabilities cache
   */
  static async updateCapabilitiesCache(
    serverId: string,
    data: {
      tools?: any;
      resources?: any;
      resourceTemplates?: any;
      prompts?: any;
    }
  ): Promise<void> {
    const updateData: any = {};

    if (data.tools !== undefined) {
      updateData.cachedTools = JSON.stringify(data.tools);
    }
    if (data.resources !== undefined) {
      updateData.cachedResources = JSON.stringify(data.resources);
    }
    if (data.resourceTemplates !== undefined) {
      updateData.cachedResourceTemplates = JSON.stringify(data.resourceTemplates);
    }
    if (data.prompts !== undefined) {
      updateData.cachedPrompts = JSON.stringify(data.prompts);
    }

    await prisma.server.update({
      where: { serverId },
      data: updateData
    });
  }

  /**
   * Get server capabilities cache
   */
  static async getCapabilitiesCache(serverId: string): Promise<{
    tools?: any;
    resources?: any;
    resourceTemplates?: any;
    prompts?: any;
  } | null> {
    const server = await prisma.server.findUnique({
      where: { serverId },
      select: {
        cachedTools: true,
        cachedResources: true,
        cachedResourceTemplates: true,
        cachedPrompts: true
      }
    });

    if (!server) return null;

    return {
      tools: server.cachedTools ? JSON.parse(server.cachedTools) : undefined,
      resources: server.cachedResources ? JSON.parse(server.cachedResources) : undefined,
      resourceTemplates: server.cachedResourceTemplates ? JSON.parse(server.cachedResourceTemplates) : undefined,
      prompts: server.cachedPrompts ? JSON.parse(server.cachedPrompts) : undefined
    };
  }
}

// Export singleton (backward compatibility)
export default ServerRepository;
