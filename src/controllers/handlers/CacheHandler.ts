import { LogService } from '../../log/LogService.js';
import { createLogger } from '../../logger/index.js';
import { ResultCacheService } from '../../mcp/core/cache/ResultCacheService.js';
import {
  AdmissionPolicy,
  CacheScope,
  type CachePolicyConfig,
  type CacheOperationType,
  type CacheScopeContext,
  type ResolvedCachePolicy,
} from '../../mcp/core/cache/types.js';
import type { ServerConfigCapabilities } from '../../mcp/types/mcp.js';
import { ServerRepository } from '../../repositories/ServerRepository.js';
import { MCPEventLogType } from '../../types/enums.js';
import { AdminError, AdminErrorCode, type AdminRequest } from '../../types/admin.types.js';

export class CacheHandler {
  private logger = createLogger('CacheHandler');
  private resultCacheService: ResultCacheService | null = null;

  setResultCacheService(service: ResultCacheService): void {
    this.resultCacheService = service;
  }

  async handleGetHealth(_request: AdminRequest): Promise<unknown> {
    const cacheService = this.requireService();
    const health = await cacheService.getHealth();
    return {
      enabled: cacheService.enabled,
      health,
      metrics: cacheService.getMetrics(),
    };
  }

  async handleGetPolicy(request: AdminRequest): Promise<unknown> {
    const cacheService = this.requireService();
    const data = request.data as Record<string, unknown> | undefined;
    const serverId = typeof data?.serverId === 'string' ? data.serverId : undefined;

    const config = cacheService.getConfigSnapshot();
    const globalConfig = {
      enabled: config.enabled,
      backend: config.backend,
      defaultTtlSeconds: config.defaultTtlSeconds,
      defaultAdmissionPolicy: config.defaultAdmissionPolicy,
      defaultAdmissionWindowSeconds: config.defaultAdmissionWindowSeconds,
      maxEntryBytes: config.maxEntryBytes,
    };

    if (!serverId) {
      return { globalConfig };
    }

    const result: Record<string, unknown> = { serverId, globalConfig };

    try {
      const server = await ServerRepository.findByServerId(serverId);
      if (server?.capabilities) {
        const caps: ServerConfigCapabilities = JSON.parse(server.capabilities);
        const tools: Record<string, CachePolicyConfig> = {};
        const prompts: Record<string, CachePolicyConfig> = {};
        const resources: { exact: Record<string, CachePolicyConfig>; patterns: unknown[] } = {
          exact: {},
          patterns: [],
        };

        for (const [name, toolCfg] of Object.entries(caps.tools ?? {})) {
          if (toolCfg.cache) {
            tools[name] = toolCfg.cache;
          }
        }
        for (const [name, promptCfg] of Object.entries(caps.prompts ?? {})) {
          if (promptCfg.cache) {
            prompts[name] = promptCfg.cache;
          }
        }
        for (const [uri, resCfg] of Object.entries(caps.resources ?? {})) {
          if (resCfg.cache) {
            resources.exact[uri] = resCfg.cache;
          }
        }
        if (caps.resourceCachePolicies?.patterns) {
          resources.patterns = caps.resourceCachePolicies.patterns;
        }

        result.tools = tools;
        result.prompts = prompts;
        result.resources = resources;
      }
    } catch (error) {
      this.logger.warn({ error, serverId }, 'Failed to extract per-entity cache policies');
    }

    return result;
  }

  async handlePurgeGlobal(_request: AdminRequest): Promise<unknown> {
    const cacheService = this.requireService();
    await cacheService.purgeGlobal();
    await this.logPurgeAction('global', {});
    this.logger.info('Result cache global purge requested');
    return { purged: true, scope: 'global' };
  }

  async handlePurgeServer(request: AdminRequest): Promise<unknown> {
    const cacheService = this.requireService();
    const { serverId } = this.requireObject(request.data);
    if (typeof serverId !== 'string' || serverId.trim() === '') {
      throw new AdminError('Missing required field: serverId', AdminErrorCode.INVALID_REQUEST);
    }

    await cacheService.purgeServer(serverId);
    await this.logPurgeAction('server', { serverId });
    return { purged: true, scope: 'server', serverId };
  }

  async handlePurgeTool(request: AdminRequest): Promise<unknown> {
    const cacheService = this.requireService();
    const data = this.requireObject(request.data);
    const serverId = this.requireNonEmptyString(data.serverId, 'serverId');
    const toolName = this.requireNonEmptyString(data.toolName, 'toolName');

    await cacheService.purgeTool(serverId, toolName);
    await this.logPurgeAction('tool', { serverId, toolName });
    return { purged: true, scope: 'tool', serverId, toolName };
  }

  async handlePurgePrompt(request: AdminRequest): Promise<unknown> {
    const cacheService = this.requireService();
    const data = this.requireObject(request.data);
    const serverId = this.requireNonEmptyString(data.serverId, 'serverId');
    const promptName = this.requireNonEmptyString(data.promptName, 'promptName');

    await cacheService.purgePrompt(serverId, promptName);
    await this.logPurgeAction('prompt', { serverId, promptName });
    return { purged: true, scope: 'prompt', serverId, promptName };
  }

  async handlePurgeResource(request: AdminRequest): Promise<unknown> {
    const cacheService = this.requireService();
    const data = this.requireObject(request.data);
    const serverId = this.requireNonEmptyString(data.serverId, 'serverId');
    const uri = this.requireNonEmptyString(data.uri, 'uri');

    await cacheService.purgeResource(serverId, uri);
    await this.logPurgeAction('resource', { serverId, uri });
    return { purged: true, scope: 'resource', serverId, uri };
  }

  async handlePurgeExact(request: AdminRequest): Promise<unknown> {
    const cacheService = this.requireService();
    const data = this.requireObject(request.data);

    const operation = this.parseOperation(data.operation);
    const serverId = this.requireNonEmptyString(data.serverId, 'serverId');
    const entityId = this.requireNonEmptyString(data.entityId, 'entityId');
    const policy = this.parseResolvedPolicy(data.policy);
    const scopeContext = this.parseScopeContext(data.scopeContext);

    await cacheService.purgeExact(
      operation,
      serverId,
      entityId,
      scopeContext,
      policy,
      data.requestParams,
    );

    await this.logPurgeAction('exact', { operation, serverId, entityId });
    return { purged: true, scope: 'exact', operation, serverId, entityId };
  }

  private requireService(): ResultCacheService {
    if (!this.resultCacheService) {
      throw new AdminError(
        'Result cache service is not initialized',
        AdminErrorCode.INVALID_REQUEST,
      );
    }
    return this.resultCacheService;
  }

  private requireObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AdminError('Invalid request data', AdminErrorCode.INVALID_REQUEST);
    }
    return value as Record<string, unknown>;
  }

  private requireNonEmptyString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AdminError(`Missing required field: ${fieldName}`, AdminErrorCode.INVALID_REQUEST);
    }
    return value;
  }

  private parseOperation(value: unknown): CacheOperationType {
    if (value === 'tool' || value === 'resource' || value === 'prompt') {
      return value;
    }
    throw new AdminError('Invalid field: operation', AdminErrorCode.INVALID_REQUEST);
  }

  private parseScopeContext(value: unknown): CacheScopeContext {
    if (value === undefined) {
      return {};
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AdminError('Invalid field: scopeContext', AdminErrorCode.INVALID_REQUEST);
    }

    const source = value as Record<string, unknown>;
    const context: CacheScopeContext = {};
    if (source.userId !== undefined) {
      context.userId = this.requireNonEmptyString(source.userId, 'scopeContext.userId');
    }
    if (source.tenantId !== undefined) {
      context.tenantId = this.requireNonEmptyString(source.tenantId, 'scopeContext.tenantId');
    }

    return context;
  }

  private parseResolvedPolicy(value: unknown): ResolvedCachePolicy {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AdminError('Missing required field: policy', AdminErrorCode.INVALID_REQUEST);
    }

    const policy = value as Record<string, unknown>;
    const scope = this.parseScope(policy.scope);
    const admissionPolicy = this.parseAdmissionPolicy(policy.admissionPolicy);

    const ttlSeconds = this.parsePositiveNumber(policy.ttlSeconds, 'policy.ttlSeconds');
    const admissionWindowSeconds = this.parsePositiveNumber(
      policy.admissionWindowSeconds,
      'policy.admissionWindowSeconds',
    );
    const maxEntryBytes = this.parsePositiveNumber(policy.maxEntryBytes, 'policy.maxEntryBytes');
    const denyFields = this.parseStringArray(policy.denyFields, 'policy.denyFields');
    const allowFields =
      policy.allowFields === undefined
        ? undefined
        : this.parseStringArray(policy.allowFields, 'policy.allowFields');

    return {
      enabled: policy.enabled === true,
      ttlSeconds,
      scope,
      admissionPolicy,
      admissionWindowSeconds,
      denyFields,
      allowFields,
      maxEntryBytes,
    };
  }

  private parseScope(value: unknown): CacheScope {
    if (value === CacheScope.Global || value === CacheScope.User || value === CacheScope.Tenant) {
      return value;
    }
    throw new AdminError('Invalid field: policy.scope', AdminErrorCode.INVALID_REQUEST);
  }

  private parseAdmissionPolicy(value: unknown): AdmissionPolicy {
    if (value === AdmissionPolicy.Immediate || value === AdmissionPolicy.SecondHit) {
      return value;
    }
    throw new AdminError('Invalid field: policy.admissionPolicy', AdminErrorCode.INVALID_REQUEST);
  }

  private parsePositiveNumber(value: unknown, fieldName: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
      throw new AdminError(`Invalid field: ${fieldName}`, AdminErrorCode.INVALID_REQUEST);
    }
    return value;
  }

  private parseStringArray(value: unknown, fieldName: string): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new AdminError(`Invalid field: ${fieldName}`, AdminErrorCode.INVALID_REQUEST);
    }
    return value;
  }

  private async logPurgeAction(scope: string, payload: Record<string, unknown>): Promise<void> {
    await LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AdminServerEdit,
      requestParams: JSON.stringify({ cachePurgeScope: scope, ...payload }),
    });
  }
}
