import { resultCacheConfig, type ResultCacheConfig } from '../../../config/resultCacheConfig.js';
import { createLogger, type Logger } from '../../../logger/index.js';
import type { DangerLevel } from '../../../types/enums.js';
import type { ServerConfigCapabilities } from '../../types/mcp.js';
import { CacheKeyBuilder } from './CacheKeyBuilder.js';
import { CachePolicyResolver } from './CachePolicyResolver.js';
import { ResultCacheManager } from './ResultCacheManager.js';
import { SingleflightRegistry } from './SingleflightRegistry.js';
import { NoopResultCacheStore } from './stores/NoopResultCacheStore.js';
import type { ResultCacheStore } from './stores/ResultCacheStore.js';
import {
  AdmissionPolicy,
  CacheScope,
  type CacheBypassReason,
  type CacheLookupResult,
  type CacheNamespaceVersions,
  type CacheOperationType,
  type CacheScopeContext,
  type ResolvedCachePolicy,
} from './types.js';

export class ResultCacheService {
  private static _instance: ResultCacheService | null = null;

  private readonly manager: ResultCacheManager;
  private readonly policyResolver: CachePolicyResolver;
  private readonly singleflight: SingleflightRegistry;
  private readonly keyBuilder: CacheKeyBuilder;
  private readonly config: ResultCacheConfig;
  private readonly logger: Logger;
  private readonly store: ResultCacheStore;

  private constructor(
    config: ResultCacheConfig,
    store: ResultCacheStore,
    manager?: ResultCacheManager,
  ) {
    this.config = config;
    this.logger = createLogger('ResultCacheService');
    this.store = store;
    this.manager = manager ?? new ResultCacheManager(this.store, config, this.logger);
    this.policyResolver = new CachePolicyResolver();
    this.singleflight = new SingleflightRegistry();
    this.keyBuilder = new CacheKeyBuilder();

    this.logger.info(
      { enabled: config.enabled, backend: config.backend },
      'ResultCacheService initialized',
    );
  }

  static initialize(
    config: ResultCacheConfig,
    store: ResultCacheStore,
    manager?: ResultCacheManager,
  ): ResultCacheService {
    ResultCacheService._instance = new ResultCacheService(config, store, manager);
    return ResultCacheService._instance;
  }

  static get instance(): ResultCacheService {
    if (!ResultCacheService._instance) {
      const store = new NoopResultCacheStore();
      ResultCacheService._instance = new ResultCacheService(resultCacheConfig, store);
    }
    return ResultCacheService._instance;
  }

  static resetForTesting(): void {
    ResultCacheService._instance = null;
  }

  resolveToolPolicy(
    capabilitiesConfig: ServerConfigCapabilities,
    toolName: string,
  ): ResolvedCachePolicy | null {
    return this.policyResolver.resolveToolPolicy(capabilitiesConfig, toolName, this.config);
  }

  resolveResourcePolicy(
    capabilitiesConfig: ServerConfigCapabilities,
    uri: string,
  ): ResolvedCachePolicy | null {
    return this.policyResolver.resolveResourcePolicy(capabilitiesConfig, uri, this.config);
  }

  resolvePromptPolicy(
    capabilitiesConfig: ServerConfigCapabilities,
    promptName: string,
  ): ResolvedCachePolicy | null {
    return this.policyResolver.resolvePromptPolicy(capabilitiesConfig, promptName, this.config);
  }

  isToolCacheSafe(dangerLevel?: DangerLevel): boolean {
    return this.policyResolver.isToolCacheSafe(dangerLevel);
  }

  async lookup(
    operation: CacheOperationType,
    serverId: string,
    entityId: string,
    scopeContext: CacheScopeContext,
    policy: ResolvedCachePolicy,
    requestParams: unknown,
  ): Promise<CacheLookupResult> {
    return this.manager.lookup(operation, serverId, entityId, scopeContext, policy, requestParams);
  }

  async storeResult(
    operation: CacheOperationType,
    serverId: string,
    entityId: string,
    scopeContext: CacheScopeContext,
    policy: ResolvedCachePolicy,
    requestParams: unknown,
    result: unknown,
    options?: { observationIncrement?: number; capturedVersions?: CacheNamespaceVersions },
  ): Promise<boolean> {
    if (operation === 'tool' && !this.isToolResultCacheable(result)) {
      this.recordStoreBypass('errors_not_cacheable');
      return false;
    }

    if (policy.admissionPolicy === AdmissionPolicy.Immediate) {
      return this.manager.store(
        operation,
        serverId,
        entityId,
        scopeContext,
        policy,
        requestParams,
        result,
        0,
        options?.capturedVersions,
        false,
      );
    }

    const observationIncrement = Math.max(1, options?.observationIncrement ?? 1);
    let admissionCount = 0;
    for (let i = 0; i < observationIncrement; i += 1) {
      admissionCount = await this.manager.recordAdmission(
        operation,
        serverId,
        entityId,
        scopeContext,
        policy,
        requestParams,
        options?.capturedVersions,
      );
    }

    if (!this.manager.shouldPromote(admissionCount, policy)) {
      return false;
    }

    const stored = await this.manager.store(
      operation,
      serverId,
      entityId,
      scopeContext,
      policy,
      requestParams,
      result,
      admissionCount,
      options?.capturedVersions,
      true,
    );

    if (stored) {
      this.manager
        .clearAdmission(operation, serverId, entityId, scopeContext, policy, requestParams)
        .catch((error) => {
          this.logger.debug(
            { error, operation, serverId, entityId },
            'Background admission clear failed',
          );
        });
    }

    return stored;
  }

  async executeWithCache<T>(
    operation: CacheOperationType,
    serverId: string,
    entityId: string,
    scopeContext: CacheScopeContext,
    policy: ResolvedCachePolicy,
    requestParams: unknown,
    factory: () => Promise<T>,
  ): Promise<{ result: T; cacheHit: boolean }> {
    const lookupResult = await this.lookup(
      operation,
      serverId,
      entityId,
      scopeContext,
      policy,
      requestParams,
    );

    if (lookupResult.hit && lookupResult.entry) {
      this.logger.debug({ operation, serverId, entityId }, 'Cache hit');
      return { result: lookupResult.entry.payload as T, cacheHit: true };
    }

    // When the required scope identity is missing, skip singleflight entirely.
    // Using a 'none' fallback key would coalesce requests from different users into
    // the same in-flight call and return the wrong result (data leak). Since
    // ResultCacheManager will bypass storage for missing identities anyway, there is
    // no value in deduplication here.
    const identityMissing =
      (policy.scope === CacheScope.Tenant && !scopeContext.tenantId) ||
      (policy.scope === CacheScope.User && !scopeContext.userId);

    if (identityMissing) {
      const result = await factory();
      return { result, cacheHit: false };
    }

    const scopeIdentity =
      policy.scope === CacheScope.Global
        ? 'global'
        : policy.scope === CacheScope.Tenant
          ? scopeContext.tenantId!
          : scopeContext.userId!;
    const requestHash = this.keyBuilder.canonicalizeParams(
      requestParams,
      policy.denyFields,
      policy.allowFields,
    );
    const versionSuffix = lookupResult.lookupVersions
      ? `:${lookupResult.lookupVersions.globalVersion}:${lookupResult.lookupVersions.serverVersion}:${lookupResult.lookupVersions.entityVersion}`
      : '';
    const cacheKeyForSingleflight = `sf:${operation}:${serverId}:${entityId}:${scopeIdentity}:${requestHash}${versionSuffix}`;
    const { result, isLeader, requestCount } = await this.singleflight.execute(
      cacheKeyForSingleflight,
      factory,
    );

    if (isLeader) {
      const observationIncrement =
        policy.admissionPolicy === AdmissionPolicy.SecondHit ? Math.max(1, requestCount) : 1;
      this.storeResult(
        operation,
        serverId,
        entityId,
        scopeContext,
        policy,
        requestParams,
        result,
        {
          observationIncrement,
          capturedVersions: lookupResult.lookupVersions,
        },
      ).catch((error) => {
        this.logger.warn({ error, operation, serverId, entityId }, 'Background cache store failed');
      });
    }

    return { result, cacheHit: false };
  }

  private isToolResultCacheable(result: unknown): boolean {
    if (!result || typeof result !== 'object') {
      return true;
    }

    if (!('isError' in result)) {
      return true;
    }

    return (result as { isError?: unknown }).isError !== true;
  }

  private recordStoreBypass(reason: CacheBypassReason): void {
    this.manager.recordBypass(reason);
    this.logger.debug({ reason }, 'Result cache store bypassed');
  }

  async invalidateResource(serverId: string, uri: string): Promise<void> {
    return this.manager.invalidateResource(serverId, uri);
  }

  async purgeGlobal(): Promise<void> {
    return this.manager.purgeGlobal();
  }

  async purgeServer(serverId: string): Promise<void> {
    return this.manager.purgeServer(serverId);
  }

  async purgeTool(serverId: string, toolName: string): Promise<void> {
    return this.manager.purgeTool(serverId, toolName);
  }

  async purgePrompt(serverId: string, promptName: string): Promise<void> {
    return this.manager.purgePrompt(serverId, promptName);
  }

  async purgeResource(serverId: string, uri: string): Promise<void> {
    return this.manager.purgeResource(serverId, uri);
  }

  async purgeExact(
    operation: CacheOperationType,
    serverId: string,
    entityId: string,
    scopeContext: CacheScopeContext,
    policy: ResolvedCachePolicy,
    requestParams: unknown,
  ): Promise<void> {
    return this.manager.purgeExact(
      operation,
      serverId,
      entityId,
      scopeContext,
      policy,
      requestParams,
    );
  }

  async getHealth(): Promise<{ ok: boolean; details?: string; backend: string }> {
    return this.manager.getHealth();
  }

  getMetrics(): Record<string, number> {
    return this.manager.getMetrics();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  getConfigSnapshot(): ResultCacheConfig {
    return { ...this.config };
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }
}
