import {
  McpError,
  ErrorCode,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { UserRepository } from '../../repositories/UserRepository.js';
import { CatalogActionRepository } from '../../repositories/CatalogActionRepository.js';
import { ServerManager } from '../core/ServerManager.js';
import {
  CATALOG_TOOL_NAMES,
  CatalogDescribeInput,
  CatalogDescribeResult,
  CatalogExecuteInput,
  CatalogSearchInput,
} from '../../types/discovery.types.js';
import { discoverySearchService } from './DiscoverySearchService.js';

interface ProxySessionLike {
  executeToolCallInternal(
    aliasedToolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<CallToolResult>;
}

export function getCatalogToolDefinitions(): Tool[] {
  return [
    {
      name: CATALOG_TOOL_NAMES.SEARCH,
      title: 'Search Catalog Actions',
      description: 'Search the progressive-disclosure catalog for tools you can access.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          profileId: { type: 'string' },
          serverIds: { type: 'array', items: { type: 'string' } },
          categories: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          riskMax: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          approvalAllowed: { type: 'boolean' },
          directCallableOnly: { type: 'boolean' },
          detail: { type: 'string', enum: ['summary'] },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          cursor: { type: ['string', 'null'] },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Catalog Search',
        readOnlyHint: true,
      },
    },
    {
      name: CATALOG_TOOL_NAMES.DESCRIBE,
      title: 'Describe Catalog Actions',
      description: 'Get full action metadata for specific catalog action IDs.',
      inputSchema: {
        type: 'object',
        properties: {
          actionIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
          },
          detail: { type: 'string', enum: ['full'] },
        },
        required: ['actionIds'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Catalog Describe',
        readOnlyHint: true,
      },
    },
    {
      name: CATALOG_TOOL_NAMES.EXECUTE,
      title: 'Execute Catalog Action',
      description: 'Execute a catalog action by action ID through normal governance checks.',
      inputSchema: {
        type: 'object',
        properties: {
          actionId: { type: 'string' },
          arguments: { type: 'object', additionalProperties: true },
          expectedSchemaHash: { type: ['string', 'null'] },
        },
        required: ['actionId', 'arguments'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Catalog Execute',
      },
    },
  ];
}

export async function handleCatalogSearch(
  args: unknown,
  userId: string,
  clientSession: unknown,
): Promise<CallToolResult> {
  void clientSession;
  const input = parseCatalogSearchInput(args);
  const result = await discoverySearchService.search(input, userId);

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

export async function handleCatalogDescribe(
  args: unknown,
  userId: string,
): Promise<CallToolResult> {
  const input = parseCatalogDescribeInput(args);
  const authorizedServerIds = await getAuthorizedServerIds(userId);
  const items = await Promise.all(
    input.actionIds.map(async (actionId) => await CatalogActionRepository.findByActionId(actionId)),
  );

  const filtered = items
    .filter((item): item is NonNullable<(typeof items)[number]> => item !== null)
    .filter((item) => authorizedServerIds.includes(item.serverId))
    .map((item) => ({
      actionId: item.actionId,
      displayName: item.displayName,
      title: item.title,
      summary: item.summary,
      description: item.description,
      serverId: item.serverId,
      category: item.category,
      inputSchema: isRecord(item.inputSchema)
        ? item.inputSchema
        : ({ type: 'object' } as Record<string, unknown>),
      outputSchema: isRecord(item.outputSchema) ? item.outputSchema : null,
      annotations: isRecord(item.annotations) ? item.annotations : null,
      examples: Array.isArray(item.examples) ? item.examples : null,
      riskLevel: item.riskLevel,
      requiredScopes: Array.isArray(item.requiredScopes)
        ? item.requiredScopes.filter((scope): scope is string => typeof scope === 'string')
        : null,
      approvalRequired: item.approvalRequired,
      directCallable: true,
      wireName: item.wireName,
      schemaHash: item.schemaHash,
    }));

  const result: CatalogDescribeResult = {
    results: filtered,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

export async function handleCatalogExecute(
  args: unknown,
  userId: string,
  proxySession: ProxySessionLike,
): Promise<CallToolResult> {
  const input = parseCatalogExecuteInput(args);
  const action = await CatalogActionRepository.findByActionId(input.actionId);
  if (!action) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown catalog actionId: ${input.actionId}`);
  }

  const authorizedServerIds = await getAuthorizedServerIds(userId);
  if (!authorizedServerIds.includes(action.serverId)) {
    throw new McpError(ErrorCode.InvalidParams, 'Permission denied for catalog action');
  }

  if (input.expectedSchemaHash && input.expectedSchemaHash !== action.schemaHash) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Schema hash mismatch for action ${action.actionId}: expected ${input.expectedSchemaHash}, got ${action.schemaHash}`,
    );
  }

  const aliasedName = `${action.originalName}_-_${action.serverId}`;
  return await proxySession.executeToolCallInternal(aliasedName, input.arguments);
}

function parseCatalogSearchInput(value: unknown): CatalogSearchInput {
  if (!isRecord(value) || typeof value.query !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Catalog search requires string field: query');
  }

  return {
    query: value.query,
    profileId: asOptionalString(value.profileId),
    serverIds: asOptionalStringArray(value.serverIds),
    categories: asOptionalStringArray(value.categories),
    tags: asOptionalStringArray(value.tags),
    riskMax: asOptionalRiskLevel(value.riskMax),
    approvalAllowed: asOptionalBoolean(value.approvalAllowed),
    directCallableOnly: asOptionalBoolean(value.directCallableOnly),
    detail: value.detail === 'summary' ? 'summary' : undefined,
    limit: asOptionalNumber(value.limit),
    cursor: asOptionalNullableString(value.cursor),
  };
}

function parseCatalogDescribeInput(value: unknown): CatalogDescribeInput {
  if (!isRecord(value) || !Array.isArray(value.actionIds)) {
    throw new McpError(ErrorCode.InvalidParams, 'Catalog describe requires array field: actionIds');
  }

  const actionIds = value.actionIds.filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  );

  if (actionIds.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'Catalog describe requires at least one actionId');
  }

  return {
    actionIds,
    detail: value.detail === 'full' ? 'full' : undefined,
  };
}

function parseCatalogExecuteInput(value: unknown): CatalogExecuteInput {
  if (!isRecord(value) || typeof value.actionId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Catalog execute requires string field: actionId');
  }

  if (!isRecord(value.arguments)) {
    throw new McpError(ErrorCode.InvalidParams, 'Catalog execute requires object field: arguments');
  }

  return {
    actionId: value.actionId,
    arguments: value.arguments,
    expectedSchemaHash: asOptionalNullableString(value.expectedSchemaHash),
  };
}

async function getAuthorizedServerIds(userId: string): Promise<string[]> {
  const user = await UserRepository.findByUserId(userId);
  if (user) {
    return ServerManager.instance.getUserAvailableServers(user).map((context) => context.serverID);
  }

  return ServerManager.instance
    .getAvailableServers()
    .filter((context) => context.serverEntity.publicAccess || context.serverEntity.anonymousAccess)
    .map((context) => context.serverID);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asOptionalNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asOptionalRiskLevel(value: unknown): 'low' | 'medium' | 'high' | 'critical' | undefined {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
