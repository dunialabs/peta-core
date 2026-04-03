import { createHash } from 'crypto';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../../logger/index.js';
import { ServerManager } from '../core/ServerManager.js';
import { CatalogActionRepository } from '../../repositories/CatalogActionRepository.js';
import { inferDiscoveryRiskLevel } from '../../types/discovery.types.js';

type ToolLike = Tool & {
  outputSchema?: Record<string, unknown>;
};

/**
 * Builds and maintains the persistent discovery catalog index.
 *
 * IMPORTANT: The catalog is a searchable index/cache derived from live server state,
 * NOT a runtime source of truth. It is used for catalog.search and catalog.describe
 * to provide keyword-based discovery across all managed server tools.
 *
 * Runtime execution (catalog.execute) always resolves through the live ServerContext
 * and ServerManager, not from catalog rows. Temporary/user-scoped server contexts
 * are intentionally excluded from this global index.
 *
 * The catalog can drift from runtime truth when server configurations, permissions,
 * or policies change between rebuilds. Invalidation is triggered by tools/listChanged
 * events and admin-initiated reindex operations.
 */
export class DiscoveryIndexBuilder {
  private static instance: DiscoveryIndexBuilder;
  private readonly logger = createLogger('DiscoveryIndexBuilder');

  private constructor() {}

  static getInstance(): DiscoveryIndexBuilder {
    if (!DiscoveryIndexBuilder.instance) {
      DiscoveryIndexBuilder.instance = new DiscoveryIndexBuilder();
    }
    return DiscoveryIndexBuilder.instance;
  }

  async buildFullIndex(): Promise<{ indexedActions: number }> {
    const serverContexts = ServerManager.instance
      .getAvailableServersFromServerContexts();

    let totalIndexed = 0;
    for (const serverContext of serverContexts) {
      const result = await this.rebuildForServer(serverContext.serverID);
      totalIndexed += result.indexedActions;
    }

    const allEnabledServers = await ServerManager.instance.getAllServers();
    const enabledServerIds = allEnabledServers.filter((s) => s.enabled).map((s) => s.serverId);
    await CatalogActionRepository.deleteExceptServerIds(enabledServerIds);

    this.logger.info(
      { serverCount: serverContexts.length, indexedActions: totalIndexed },
      'Discovery catalog full index rebuilt',
    );
    return { indexedActions: totalIndexed };
  }

  async invalidateServer(serverId: string): Promise<{ indexedActions: number }> {
    return await this.rebuildForServer(serverId);
  }

  async rebuildForServer(serverId: string): Promise<{ indexedActions: number }> {
    const serverContext = ServerManager.instance.getServerContext(serverId);

    if (!serverContext) {
      this.logger.warn({ serverId }, 'Server context not available for discovery index rebuild');
      await CatalogActionRepository.deleteByServerId(serverId);
      return { indexedActions: 0 };
    }

    const tools = (serverContext.tools?.tools ?? serverContext.cachedTools?.tools ?? null) as
      | ToolLike[]
      | null;
    if (!tools) {
      this.logger.debug({ serverId }, 'Server has no tools loaded yet, skipping catalog rebuild');
      return { indexedActions: 0 };
    }
    const actions = tools.map((tool) => this.mapToolToCatalogAction(serverId, tool));

    await CatalogActionRepository.bulkUpsert(actions);
    const newActionIds = actions.map((a) => a.actionId);
    await CatalogActionRepository.deleteByServerIdExcept(serverId, newActionIds);

    this.logger.info(
      { serverId, indexedActions: actions.length },
      'Discovery catalog server index rebuilt',
    );
    return { indexedActions: actions.length };
  }

  private mapToolToCatalogAction(serverId: string, tool: ToolLike) {
    const originalToolName = tool.name;
    const actionId = `ppd_${createHash('sha256').update(`${serverId}::${originalToolName}`).digest('hex').slice(0, 16)}`;
    // wireName is a stable reference identifier (serverId-based), NOT a runtime callable alias.
    // The actual callable alias uses the runtime serverContext.id which changes across restarts.
    // Use catalog.execute to call tools; do not call wireName directly.
    const wireName = `${originalToolName}_-_${serverId}`;
    const displayName = `${serverId}.${originalToolName}`;
    const title = tool.title ?? originalToolName;
    const summary = tool.description?.trim() ? tool.description : originalToolName;
    const description = tool.description ?? null;
    const inputSchema = (tool.inputSchema ?? {}) as Record<string, unknown>;
    const outputSchema = (tool.outputSchema ?? null) as Record<string, unknown> | null;
    const annotations = (tool.annotations ?? null) as Record<string, unknown> | null;
    const searchText = [displayName, title, summary, description ?? '']
      .join(' ')
      .toLowerCase()
      .trim();

    const schemaHash = createHash('sha256').update(JSON.stringify(inputSchema)).digest('hex');

    return {
      actionId,
      serverId,
      originalName: originalToolName,
      wireName,
      displayName,
      title,
      summary,
      description,
      riskLevel: inferDiscoveryRiskLevel(annotations),
      enabled: true,
      inputSchema,
      outputSchema,
      annotations,
      examples: null,
      schemaHash,
      searchText,
      lastIndexedAt: new Date(),
    };
  }
}

export const discoveryIndexBuilder = DiscoveryIndexBuilder.getInstance();
