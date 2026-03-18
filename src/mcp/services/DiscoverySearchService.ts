import { createLogger } from '../../logger/index.js';
import { CatalogActionRepository } from '../../repositories/CatalogActionRepository.js';
import { UserRepository } from '../../repositories/UserRepository.js';
import { ServerManager } from '../core/ServerManager.js';
import { discoveryConfigService } from './DiscoveryConfigService.js';
import {
  CatalogSearchInput,
  CatalogSearchResult,
  CatalogSearchResultItem,
  DiscoveryProfileConfig,
} from '../../types/discovery.types.js';

const MAX_SCAN_SIZE = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isToolEnabledForUser(
  permissions: unknown,
  serverId: string,
  toolName: string,
): boolean {
  if (!isRecord(permissions)) return true;
  const serverPerms = permissions[serverId];
  if (!isRecord(serverPerms)) return true;
  const tools = serverPerms.tools;
  if (!isRecord(tools)) return true;
  const toolPerm = tools[toolName];
  if (!isRecord(toolPerm)) return true;
  return typeof toolPerm.enabled === 'boolean' ? toolPerm.enabled : true;
}

/**
 * Callback for per-tool permission checks.
 * Returns true if the user can use the specified tool on the specified server.
 */
export type ToolPermissionChecker = (serverId: string, originalToolName: string) => boolean;

export class DiscoverySearchService {
  private static instance: DiscoverySearchService;
  private readonly logger = createLogger('DiscoverySearchService');

  private constructor() {}

  static getInstance(): DiscoverySearchService {
    if (!DiscoverySearchService.instance) {
      DiscoverySearchService.instance = new DiscoverySearchService();
    }
    return DiscoverySearchService.instance;
  }

  async search(
    input: CatalogSearchInput,
    userId: string,
    canUseTool?: ToolPermissionChecker,
  ): Promise<CatalogSearchResult> {
    const query = input.query.trim();
    if (!query) {
      return { results: [], nextCursor: null, totalCount: 0 };
    }

    const user = await UserRepository.findByUserId(userId);
    const authCtx = this.getAuthContextFromUser(user);
    if (authCtx.serverIds.length === 0) {
      return { results: [], nextCursor: null, totalCount: 0 };
    }

    const requestedServerIds = (input.serverIds ?? []).filter((id) => id.trim() !== '');
    const serverIds =
      requestedServerIds.length > 0
        ? requestedServerIds.filter((id) => authCtx.serverIds.includes(id))
        : authCtx.serverIds;

    if (serverIds.length === 0) {
      return { results: [], nextCursor: null, totalCount: 0 };
    }

    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const offset = this.parseCursor(input.cursor);

    const scanned = await CatalogActionRepository.search({
      query,
      serverIds,
      categories: input.categories,
      tags: input.tags,
      riskMax: input.riskMax,
      limit: MAX_SCAN_SIZE,
      offset: 0,
    });

    const profile = await discoveryConfigService.getActiveProfile();
    const config = profile?.config as DiscoveryProfileConfig | null;
    const exposureRules = config?.directExposureRules;

    const visibilityFiltered = authCtx.isAnonymous
      ? scanned.filter((action) => action.publicVisible)
      : scanned;

    const toolPermissionFiltered = user
      ? visibilityFiltered.filter((action) =>
          isToolEnabledForUser(user.permissions, action.serverId, action.originalName),
        )
      : visibilityFiltered;

    const callbackFiltered = canUseTool
      ? toolPermissionFiltered.filter((action) => canUseTool(action.serverId, action.originalName))
      : toolPermissionFiltered;

    let filtered = callbackFiltered;

    if (input.approvalAllowed === false) {
      filtered = filtered.filter((action) => !action.approvalRequired);
    }

    if (input.directCallableOnly) {
      filtered = filtered.filter((action) =>
        this.isActionDirectCallable(action.serverId, exposureRules),
      );
    }

    const ranked = filtered
      .map((action) => ({
        action,
        rank: this.calculateRank(action, query, input.categories ?? []),
      }))
      .sort((a, b) => b.rank - a.rank)
      .map((entry) => entry.action);

    const page = ranked.slice(offset, offset + limit);
    const items: CatalogSearchResultItem[] = page.map((action) => ({
      actionId: action.actionId,
      displayName: action.displayName,
      title: action.title,
      summary: action.summary,
      serverId: action.serverId,
      category: action.category,
      tags: Array.isArray(action.tags)
        ? action.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
      riskLevel: action.riskLevel,
      approvalRequired: action.approvalRequired,
      directCallable: this.isActionDirectCallable(action.serverId, exposureRules),
      schemaHash: action.schemaHash,
    }));

    const nextCursor = offset + limit < ranked.length ? String(offset + limit) : null;

    this.logger.debug(
      {
        userId,
        query,
        requestedLimit: input.limit,
        limit,
        offset,
        totalCount: ranked.length,
      },
      'Discovery catalog search completed',
    );

    return {
      results: items,
      nextCursor,
      totalCount: ranked.length,
    };
  }

  private calculateRank(
    action: {
      displayName: string;
      title: string;
      summary: string;
      category: string | null;
      searchText: string | null;
    },
    query: string,
    requestedCategories: string[],
  ): number {
    const q = query.toLowerCase();
    const displayName = action.displayName.toLowerCase();
    const title = action.title.toLowerCase();
    const summary = action.summary.toLowerCase();
    const category = action.category?.toLowerCase() ?? '';
    const searchText = action.searchText?.toLowerCase() ?? '';

    let rank = 0;
    if (displayName === q) {
      rank += 1000;
    } else if (displayName.includes(q)) {
      rank += 400;
    }

    if (title === q) {
      rank += 350;
    } else if (title.includes(q)) {
      rank += 200;
    }

    if (category === q || requestedCategories.some((c) => c.toLowerCase() === category)) {
      rank += 250;
    }

    if (summary.includes(q)) {
      rank += 80;
    }

    if (searchText.includes(q)) {
      rank += 40;
    }

    return rank;
  }

  private parseCursor(cursor: string | null | undefined): number {
    if (!cursor) {
      return 0;
    }

    const value = Number.parseInt(cursor, 10);
    if (Number.isNaN(value) || value < 0) {
      return 0;
    }

    return value;
  }

  private isActionDirectCallable(
    serverId: string,
    rules?: Array<{ match: { serverIds?: string[] }; directCallable: boolean }> | null,
  ): boolean {
    if (!rules || rules.length === 0) {
      return true;
    }

    for (const rule of rules) {
      if (rule.match.serverIds?.length && rule.match.serverIds.includes(serverId)) {
        return rule.directCallable;
      }
    }

    return false;
  }

  private getAuthContextFromUser(user: Awaited<ReturnType<typeof UserRepository.findByUserId>>): {
    serverIds: string[];
    isAnonymous: boolean;
  } {
    if (user) {
      return {
        serverIds: ServerManager.instance
          .getUserAvailableServers(user)
          .map((context) => context.serverID),
        isAnonymous: false,
      };
    }

    return {
      serverIds: ServerManager.instance
        .getAvailableServers()
        .filter(
          (context) => context.serverEntity.publicAccess || context.serverEntity.anonymousAccess,
        )
        .map((context) => context.serverID),
      isAnonymous: true,
    };
  }
}

export const discoverySearchService = DiscoverySearchService.getInstance();
