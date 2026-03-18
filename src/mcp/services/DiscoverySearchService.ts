import { createLogger } from '../../logger/index.js';
import { CatalogActionRepository } from '../../repositories/CatalogActionRepository.js';
import { UserRepository } from '../../repositories/UserRepository.js';
import { ServerManager } from '../core/ServerManager.js';
import {
  CatalogSearchInput,
  CatalogSearchResult,
  CatalogSearchResultItem,
} from '../../types/discovery.types.js';

const MAX_SCAN_SIZE = 1000;

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

  async search(input: CatalogSearchInput, userId: string): Promise<CatalogSearchResult> {
    const query = input.query.trim();
    if (!query) {
      return {
        results: [],
        nextCursor: null,
        totalCount: 0,
      };
    }

    const authorizedServerIds = await this.getAuthorizedServerIds(userId);
    if (authorizedServerIds.length === 0) {
      return {
        results: [],
        nextCursor: null,
        totalCount: 0,
      };
    }

    const requestedServerIds = (input.serverIds ?? []).filter((id) => id.trim() !== '');
    const serverIds =
      requestedServerIds.length > 0
        ? requestedServerIds.filter((id) => authorizedServerIds.includes(id))
        : authorizedServerIds;

    if (serverIds.length === 0) {
      return {
        results: [],
        nextCursor: null,
        totalCount: 0,
      };
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

    const ranked = scanned
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
      directCallable: true,
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

  private async getAuthorizedServerIds(userId: string): Promise<string[]> {
    const user = await UserRepository.findByUserId(userId);
    if (user) {
      return ServerManager.instance
        .getUserAvailableServers(user)
        .map((context) => context.serverID);
    }

    return ServerManager.instance
      .getAvailableServers()
      .filter(
        (context) => context.serverEntity.publicAccess || context.serverEntity.anonymousAccess,
      )
      .map((context) => context.serverID);
  }
}

export const discoverySearchService = DiscoverySearchService.getInstance();
