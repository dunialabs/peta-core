import {
  McpError,
  ErrorCode,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { UserRepository } from '../../repositories/UserRepository.js';
import { CatalogActionRepository } from '../../repositories/CatalogActionRepository.js';
import { DiscoveryProfileRepository } from '../../repositories/DiscoveryProfileRepository.js';
import { ServerManager } from '../core/ServerManager.js';
import { discoveryConfigService } from './DiscoveryConfigService.js';
import {
  CATALOG_TOOL_NAMES,
  CatalogDescribeInput,
  CatalogDescribeResult,
  CatalogExecuteInput,
  CatalogSearchInput,
  DiscoveryProfileConfig,
  evaluateExposureRules,
} from '../../types/discovery.types.js';
import {
  discoverySearchService,
  isToolEnabledForUser,
  type ToolPermissionChecker,
} from './DiscoverySearchService.js';

interface ProxySessionLike {
  executeToolCallInternal(
    aliasedToolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<CallToolResult>;
}

interface ClientSessionLike {
  userId: string;
  canUseTool(serverID: string, toolName: string): boolean;
  generateNewName(serverID: string, name: string): string;
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
          riskMax: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          directCallableOnly: { type: 'boolean' },
          detail: { type: 'string', enum: ['summary'] },
          limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
          cursor: { type: ['string', 'null'] },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Catalog Search',
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
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
          profileId: { type: 'string', description: 'Profile ID for directCallable evaluation' },
        },
        required: ['actionIds'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Catalog Describe',
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
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
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
      },
    },
  ];
}

export async function handleCatalogSearch(
  args: unknown,
  userId: string,
  clientSession: ClientSessionLike,
): Promise<CallToolResult> {
  const input = parseCatalogSearchInput(args);

  // Build per-tool permission checker from clientSession
  const canUseTool: ToolPermissionChecker = (serverId, originalToolName) =>
    clientSession.canUseTool(serverId, originalToolName);

  const result = await discoverySearchService.search(input, userId, canUseTool);

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: toStructuredContent(result),
  };
}

export async function handleCatalogDescribe(
  args: unknown,
  userId: string,
  clientSession: ClientSessionLike,
): Promise<CallToolResult> {
  const input = parseCatalogDescribeInput(args);
  const user = await UserRepository.findByUserId(userId);
  const authorizedServerIds = await getAuthorizedServerIds(userId, user);
  const activeProfile = input.profileId
    ? await DiscoveryProfileRepository.findById(input.profileId)
    : await discoveryConfigService.getActiveProfile();
  if (input.profileId && !activeProfile) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
      structuredContent: toStructuredContent({ results: [] }),
    };
  }
  const profileConfig = activeProfile?.config as DiscoveryProfileConfig | null;
  const exposureRules = profileConfig?.directExposureRules;

  const items = await CatalogActionRepository.findByActionIds(input.actionIds);

  const filtered = items
    .filter((item) => authorizedServerIds.includes(item.serverId))
    .filter((item) => clientSession.canUseTool(item.serverId, item.originalName))
    .map((item) => ({
      actionId: item.actionId,
      displayName: item.displayName,
      title: item.title,
      summary: item.summary,
      description: item.description,
      serverId: item.serverId,
      inputSchema: isRecord(item.inputSchema)
        ? item.inputSchema
        : ({ type: 'object' } as Record<string, unknown>),
      outputSchema: isRecord(item.outputSchema) ? item.outputSchema : null,
      annotations: isRecord(item.annotations) ? item.annotations : null,
      examples: Array.isArray(item.examples) ? item.examples : null,
      riskLevel: item.riskLevel,
      directCallable: evaluateExposureRules(
        exposureRules,
        {
          serverId: item.serverId,
          riskLevel: item.riskLevel,
        },
        false,
      ),
      catalogRefName: item.wireName,
      schemaHash: item.schemaHash,
    }));

  const result: CatalogDescribeResult = {
    results: filtered,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: toStructuredContent(result),
  };
}

export async function handleCatalogExecute(
  args: unknown,
  userId: string,
  proxySession: ProxySessionLike,
  clientSession: ClientSessionLike,
): Promise<CallToolResult> {
  const input = parseCatalogExecuteInput(args);
  const action = await CatalogActionRepository.findByActionId(input.actionId);
  if (!action) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown catalog actionId: ${input.actionId}`);
  }

  const user = await UserRepository.findByUserId(userId);
  const authorizedServerIds = await getAuthorizedServerIds(userId, user);
  if (!authorizedServerIds.includes(action.serverId)) {
    throw new McpError(ErrorCode.InvalidParams, 'Permission denied for catalog action');
  }

  if (user && !isToolEnabledForUser(user.permissions, action.serverId, action.originalName)) {
    throw new McpError(ErrorCode.InvalidParams, 'Permission denied for catalog action');
  }

  if (!clientSession.canUseTool(action.serverId, action.originalName)) {
    throw new McpError(ErrorCode.InvalidParams, 'Permission denied for catalog action');
  }

  if (input.expectedSchemaHash && input.expectedSchemaHash !== action.schemaHash) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Schema hash mismatch for action ${action.actionId}: expected ${input.expectedSchemaHash}, got ${action.schemaHash}`,
    );
  }

  const serverContext = ServerManager.instance.getServerContext(action.serverId, userId);
  if (!serverContext) {
    throw new McpError(ErrorCode.InvalidParams, 'Server not available for catalog action');
  }
  const aliasedName = clientSession.generateNewName(serverContext.id, action.originalName);
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
    riskMax: asOptionalRiskLevel(value.riskMax),
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
    profileId: asOptionalString(value.profileId),
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

async function getAuthorizedServerIds(
  userId: string,
  user?: Awaited<ReturnType<typeof UserRepository.findByUserId>>,
): Promise<string[]> {
  const resolvedUser = user ?? (await UserRepository.findByUserId(userId));
  if (resolvedUser) {
    return ServerManager.instance
      .getUserAvailableServers(resolvedUser)
      .map((context) => context.serverID);
  }

  return ServerManager.instance
    .getAvailableServers()
    .filter((context) => context.serverEntity.anonymousAccess)
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

function toStructuredContent(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  return { value };
}
