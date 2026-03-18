import { prisma } from '../config/prisma.js';
import { Prisma } from '@prisma/client';

export interface CatalogActionRecord {
  id: string;
  actionId: string;
  serverId: string;
  originalName: string;
  wireName: string | null;
  displayName: string;
  title: string;
  summary: string;
  description: string | null;
  category: string | null;
  tags: Prisma.JsonValue | null;
  riskLevel: string | null;
  requiredScopes: Prisma.JsonValue | null;
  approvalRequired: boolean;
  publicVisible: boolean;
  enabled: boolean;
  inputSchema: Prisma.JsonValue;
  outputSchema: Prisma.JsonValue | null;
  annotations: Prisma.JsonValue | null;
  examples: Prisma.JsonValue | null;
  schemaHash: string;
  searchText: string | null;
  lastIndexedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

type CatalogActionDelegate = {
  findUnique(args: { where: { actionId: string } }): Promise<CatalogActionRecord | null>;
  findMany(args: {
    where?: Record<string, unknown>;
    orderBy?: { lastIndexedAt: 'asc' | 'desc' };
    skip?: number;
    take?: number;
  }): Promise<CatalogActionRecord[]>;
  upsert(args: {
    where: { actionId: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<CatalogActionRecord>;
  deleteMany(args: { where?: Record<string, unknown> }): Promise<{ count: number }>;
  count(args?: { where?: Record<string, unknown> }): Promise<number>;
  aggregate(args: {
    _max: { lastIndexedAt: true };
  }): Promise<{ _max: { lastIndexedAt: Date | null } }>;
};

const catalogActionModel = prisma as unknown as {
  catalogAction: CatalogActionDelegate;
};

export interface CatalogSearchParams {
  query: string;
  serverIds?: string[];
  categories?: string[];
  tags?: string[];
  riskMax?: 'low' | 'medium' | 'high' | 'critical';
  limit: number;
  offset: number;
}

type CatalogActionUpsertInput = {
  actionId: string;
  serverId: string;
  originalName: string;
  wireName?: string | null;
  displayName: string;
  title: string;
  summary: string;
  description?: string | null;
  category?: string | null;
  tags?: unknown[];
  riskLevel?: string | null;
  requiredScopes?: string[] | null;
  approvalRequired?: boolean;
  publicVisible?: boolean;
  enabled?: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
  annotations?: Record<string, unknown> | null;
  examples?: unknown[] | null;
  schemaHash: string;
  searchText?: string | null;
  lastIndexedAt?: Date;
};

const RISK_ORDER: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export class CatalogActionRepository {
  static async findByActionId(actionId: string): Promise<CatalogActionRecord | null> {
    return await catalogActionModel.catalogAction.findUnique({
      where: { actionId },
    });
  }

  static async findByServerId(serverId: string): Promise<CatalogActionRecord[]> {
    return await catalogActionModel.catalogAction.findMany({
      where: { serverId },
      orderBy: { lastIndexedAt: 'desc' },
    });
  }

  static async search(params: CatalogSearchParams): Promise<CatalogActionRecord[]> {
    const where: Record<string, unknown> = {
      enabled: true,
      searchText: {
        contains: params.query,
        mode: 'insensitive',
      },
    };

    if (params.serverIds && params.serverIds.length > 0) {
      where.serverId = { in: params.serverIds };
    }

    if (params.categories && params.categories.length > 0) {
      where.category = { in: params.categories };
    }

    if (params.tags && params.tags.length > 0) {
      where.OR = params.tags.map((tag) => ({
        tags: {
          array_contains: tag,
        },
      }));
    }

    if (params.riskMax) {
      const max = RISK_ORDER[params.riskMax] ?? RISK_ORDER.critical;
      const allowedRisks = Object.entries(RISK_ORDER)
        .filter(([, level]) => level <= max)
        .map(([key]) => key);
      where.AND = [
        {
          OR: [{ riskLevel: null }, { riskLevel: { in: allowedRisks } }],
        },
      ];
    }

    return await catalogActionModel.catalogAction.findMany({
      where,
      skip: params.offset,
      take: params.limit,
      orderBy: { lastIndexedAt: 'desc' },
    });
  }

  static async bulkUpsert(actions: CatalogActionUpsertInput[]): Promise<void> {
    if (actions.length === 0) {
      return;
    }

    await prisma.$transaction(async (tx) => {
      const txModel = tx as unknown as {
        catalogAction: CatalogActionDelegate;
      };

      for (const action of actions) {
        const lastIndexedAt = action.lastIndexedAt ?? new Date();
        const createData = {
          actionId: action.actionId,
          serverId: action.serverId,
          originalName: action.originalName,
          wireName: action.wireName ?? null,
          displayName: action.displayName,
          title: action.title,
          summary: action.summary,
          description: action.description ?? null,
          category: action.category ?? null,
          tags: action.tags === undefined ? undefined : (action.tags as Prisma.InputJsonValue),
          riskLevel: action.riskLevel ?? null,
          requiredScopes:
            action.requiredScopes === undefined
              ? undefined
              : action.requiredScopes === null
                ? Prisma.JsonNull
                : (action.requiredScopes as Prisma.InputJsonValue),
          approvalRequired: action.approvalRequired ?? false,
          publicVisible: action.publicVisible ?? false,
          enabled: action.enabled ?? true,
          inputSchema: action.inputSchema as Prisma.InputJsonValue,
          outputSchema:
            action.outputSchema === undefined
              ? undefined
              : action.outputSchema === null
                ? Prisma.JsonNull
                : (action.outputSchema as Prisma.InputJsonValue),
          annotations:
            action.annotations === undefined
              ? undefined
              : action.annotations === null
                ? Prisma.JsonNull
                : (action.annotations as Prisma.InputJsonValue),
          examples:
            action.examples === undefined
              ? undefined
              : action.examples === null
                ? Prisma.JsonNull
                : (action.examples as Prisma.InputJsonValue),
          schemaHash: action.schemaHash,
          searchText: action.searchText ?? null,
          lastIndexedAt,
        };

        await txModel.catalogAction.upsert({
          where: { actionId: action.actionId },
          create: createData,
          update: createData,
        });
      }
    });
  }

  static async deleteByServerId(serverId: string): Promise<number> {
    const result = await catalogActionModel.catalogAction.deleteMany({
      where: { serverId },
    });
    return result.count;
  }

  static async deleteAll(): Promise<number> {
    const result = await catalogActionModel.catalogAction.deleteMany({
      where: {},
    });
    return result.count;
  }

  static async count(): Promise<number> {
    return await catalogActionModel.catalogAction.count();
  }

  static async getStats(): Promise<{
    total: number;
    serverCount: number;
    lastIndexedAt: Date | null;
  }> {
    const [total, aggregate, serverRows] = await Promise.all([
      this.count(),
      catalogActionModel.catalogAction.aggregate({ _max: { lastIndexedAt: true } }),
      prisma.$queryRaw<
        Array<{ cnt: bigint }>
      >`SELECT COUNT(DISTINCT server_id) as cnt FROM catalog_action WHERE enabled = true`,
    ]);

    return {
      total,
      serverCount: Number(serverRows[0]?.cnt ?? 0),
      lastIndexedAt: aggregate._max.lastIndexedAt,
    };
  }
}

export default CatalogActionRepository;
