import { createHash } from 'crypto';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../../logger/index.js';
import { ServerManager } from '../core/ServerManager.js';
import { CatalogActionRepository } from '../../repositories/CatalogActionRepository.js';

type ToolLike = Tool & {
  outputSchema?: Record<string, unknown>;
};

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
      .getAvailableServers()
      .filter((context) => context.serverEntity.enabled === true);

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
    const serverContext = ServerManager.instance
      .getAvailableServers()
      .find((context) => context.serverID === serverId);

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
    const isPublic = Boolean(
      serverContext.serverEntity?.publicAccess || serverContext.serverEntity?.anonymousAccess,
    );
    const actions = tools.map((tool) => this.mapToolToCatalogAction(serverId, tool, isPublic));

    await CatalogActionRepository.bulkUpsert(actions);
    const newActionIds = actions.map((a) => a.actionId);
    await CatalogActionRepository.deleteByServerIdExcept(serverId, newActionIds);

    this.logger.info(
      { serverId, indexedActions: actions.length },
      'Discovery catalog server index rebuilt',
    );
    return { indexedActions: actions.length };
  }

  private mapToolToCatalogAction(serverId: string, tool: ToolLike, isPublic = false) {
    const originalToolName = tool.name;
    const actionId = `ppd_${createHash('sha256').update(`${serverId}::${originalToolName}`).digest('hex').slice(0, 16)}`;
    const wireName = `${originalToolName}_-_${serverId}`;
    const displayName = `${serverId}.${originalToolName}`;
    const title = tool.title ?? originalToolName;
    const summary = tool.description?.trim() ? tool.description : originalToolName;
    const description = tool.description ?? null;
    const inputSchema = (tool.inputSchema ?? {}) as Record<string, unknown>;
    const outputSchema = (tool.outputSchema ?? null) as Record<string, unknown> | null;
    const annotations = (tool.annotations ?? null) as Record<string, unknown> | null;
    const tags = this.extractTags(annotations);
    const searchText = [displayName, title, summary, description ?? '', ...tags]
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
      category: this.extractCategory(annotations),
      tags,
      riskLevel: this.extractRiskLevel(annotations),
      requiredScopes: this.extractRequiredScopes(annotations),
      approvalRequired: false,
      publicVisible: isPublic,
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

  private extractCategory(annotations: Record<string, unknown> | null): string | null {
    const value = annotations?.category;
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private extractTags(annotations: Record<string, unknown> | null): string[] {
    const value = annotations?.tags;
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0);
  }

  private extractRiskLevel(annotations: Record<string, unknown> | null): string | null {
    const value = annotations?.riskLevel;
    if (typeof value === 'string' && value.trim() !== '') {
      return value.toLowerCase();
    }

    if (annotations?.destructiveHint === true) {
      return 'high';
    }

    if (annotations?.readOnlyHint === true) {
      return 'low';
    }

    return null;
  }

  private extractRequiredScopes(annotations: Record<string, unknown> | null): string[] | null {
    const value = annotations?.requiredScopes;
    if (!Array.isArray(value)) {
      return null;
    }

    const scopes = value.filter(
      (scope): scope is string => typeof scope === 'string' && scope.trim().length > 0,
    );
    return scopes.length > 0 ? scopes : null;
  }
}

export const discoveryIndexBuilder = DiscoveryIndexBuilder.getInstance();
