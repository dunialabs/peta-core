import type { ResultCacheConfig } from '../../../config/resultCacheConfig.js';
import type { Logger } from '../../../logger/index.js';
import { CacheKeyBuilder } from './CacheKeyBuilder.js';
import { CacheSerializer } from './CacheSerializer.js';
import type { ResultCacheStore } from './stores/ResultCacheStore.js';
import {
  AdmissionPolicy,
  CacheScope,
  type CacheBypassReason,
  type CacheLookupResult,
  type CacheOperationType,
  type CacheScopeContext,
  type ResolvedCachePolicy,
} from './types.js';

type VersionSet = {
  globalVersion: number;
  serverVersion: number;
  entityVersion: number;
};

type ResolvedRuntimeContext = {
  scopeIdentity: string;
  scopeHash: string;
  requestHash: string;
  entityHash: string;
  versions: VersionSet;
  namespaceKeys: {
    global: string;
    server: string;
    entity: string;
  };
};

export class ResultCacheManager {
  private readonly keyBuilder = new CacheKeyBuilder();

  private readonly serializer = new CacheSerializer();

  private readonly metrics: Record<string, number> = {
    hits: 0,
    misses: 0,
    bypasses: 0,
    sets: 0,
    errors: 0,
    purges: 0,
    invalidations: 0,
    admission_observations: 0,
    admission_deferred: 0,
    admission_promoted: 0,
  };

  constructor(
    private readonly cacheStore: ResultCacheStore,
    private readonly config: ResultCacheConfig,
    private readonly logger: Logger,
  ) {}

  async lookup(
    operation: CacheOperationType,
    serverId: string,
    entityId: string,
    scopeContext: CacheScopeContext,
    policy: ResolvedCachePolicy,
    requestParams: unknown,
  ): Promise<CacheLookupResult> {
    if (!this.config.enabled) {
      return this.bypass('disabled_globally');
    }
    if (!policy.enabled) {
      return this.bypass('disabled_by_policy');
    }

    const runtimeResult = await this.resolveRuntimeContext(
      operation,
      serverId,
      entityId,
      scopeContext,
      policy,
      requestParams,
    );

    if (runtimeResult.bypassReason) {
      return this.bypass(runtimeResult.bypassReason);
    }

    const runtime = runtimeResult.context;

    const entryKey = this.keyBuilder.buildResultEntryKey(
      this.config.keyPrefix,
      operation,
      serverId,
      runtime.entityHash,
      policy.scope,
      runtime.scopeHash,
      runtime.versions.globalVersion,
      runtime.versions.serverVersion,
      runtime.versions.entityVersion,
      runtime.requestHash,
    );

    let buffer: Buffer | null;
    try {
      buffer = await this.cacheStore.get(entryKey);
    } catch (error) {
      this.metrics.errors += 1;
      this.logger.warn({ error, entryKey }, 'Result cache get failed');
      return this.bypass('backend_unavailable');
    }

    if (!buffer) {
      return this.miss();
    }

    const entry = this.serializer.deserialize(buffer);
    if (!entry) {
      this.metrics.errors += 1;
      this.metrics.bypasses += 1;
      this.logger.warn({ entryKey }, 'Result cache deserialize failed');

      // Best-effort delete the corrupt entry to prevent repeated bad reads
      this.cacheStore.delete(entryKey).catch((deleteError) => {
        this.logger.debug({ error: deleteError, entryKey }, 'Failed to delete corrupt cache entry');
      });

      return { hit: false, bypassReason: 'deserialization_failed' };
    }

    this.metrics.hits += 1;
    return { hit: true, entry };
  }

  async store(
    operation: CacheOperationType,
    serverId: string,
    entityId: string,
    scopeContext: CacheScopeContext,
    policy: ResolvedCachePolicy,
    requestParams: unknown,
    result: unknown,
    admissionObservations: number,
  ): Promise<boolean> {
    if (!this.config.enabled || !policy.enabled) {
      this.metrics.bypasses += 1;
      return false;
    }

    const runtimeResult = await this.resolveRuntimeContext(
      operation,
      serverId,
      entityId,
      scopeContext,
      policy,
      requestParams,
    );
    if (runtimeResult.bypassReason) {
      this.metrics.bypasses += 1;
      return false;
    }

    const runtime = runtimeResult.context;

    const payloadBytes = this.estimatePayloadBytes(result);
    if (payloadBytes === null) {
      this.metrics.bypasses += 1;
      this.metrics.errors += 1;
      this.logger.warn(
        { operation, serverId, entityId },
        'Result cache payload serialization failed',
      );
      return false;
    }

    if (payloadBytes > policy.maxEntryBytes) {
      this.metrics.bypasses += 1;
      return false;
    }

    const entryKey = this.keyBuilder.buildResultEntryKey(
      this.config.keyPrefix,
      operation,
      serverId,
      runtime.entityHash,
      policy.scope,
      runtime.scopeHash,
      runtime.versions.globalVersion,
      runtime.versions.serverVersion,
      runtime.versions.entityVersion,
      runtime.requestHash,
    );

    const envelope = this.serializer.createEnvelope({
      operation,
      serverId,
      entityId,
      scopeType: policy.scope,
      scopeHash: runtime.scopeHash,
      ttlSeconds: policy.ttlSeconds,
      admissionPolicy: policy.admissionPolicy,
      admittedAfterObservations: admissionObservations,
      requestHash: runtime.requestHash,
      payload: result,
      payloadBytes,
    });

    const shouldCompress =
      this.config.compress === 'true' ||
      (this.config.compress === 'auto' && this.config.backend === 'redis');
    const serialized = this.serializer.serialize(
      envelope,
      shouldCompress,
      this.config.compressionMinBytes,
    );

    if (serialized.length > policy.maxEntryBytes) {
      this.metrics.bypasses += 1;
      return false;
    }

    try {
      await this.cacheStore.set(entryKey, serialized, policy.ttlSeconds);
      this.metrics.sets += 1;
      this.metrics.admission_promoted += 1;
      return true;
    } catch (error) {
      this.metrics.errors += 1;
      this.metrics.bypasses += 1;
      this.logger.warn({ error, entryKey }, 'Result cache set failed');
      return false;
    }
  }

  async recordAdmission(
    operation: CacheOperationType,
    serverId: string,
    entityId: string,
    scopeContext: CacheScopeContext,
    policy: ResolvedCachePolicy,
    requestParams: unknown,
  ): Promise<number> {
    if (!this.config.enabled || !policy.enabled) {
      return 0;
    }

    const runtimeResult = await this.resolveRuntimeContext(
      operation,
      serverId,
      entityId,
      scopeContext,
      policy,
      requestParams,
    );
    if (runtimeResult.bypassReason) {
      return 0;
    }

    const runtime = runtimeResult.context;

    const admissionKey = this.keyBuilder.buildAdmissionKey(
      this.config.keyPrefix,
      operation,
      serverId,
      runtime.entityHash,
      policy.scope,
      runtime.scopeHash,
      runtime.versions.globalVersion,
      runtime.versions.serverVersion,
      runtime.versions.entityVersion,
      runtime.requestHash,
    );

    try {
      const count = await this.cacheStore.recordAdmissionAttempt(
        admissionKey,
        policy.admissionWindowSeconds,
      );
      this.metrics.admission_observations += 1;
      return count;
    } catch (error) {
      this.metrics.errors += 1;
      this.metrics.bypasses += 1;
      this.logger.warn({ error, admissionKey }, 'Result cache admission record failed');
      return 0;
    }
  }

  async clearAdmission(
    operation: CacheOperationType,
    serverId: string,
    entityId: string,
    scopeContext: CacheScopeContext,
    policy: ResolvedCachePolicy,
    requestParams: unknown,
  ): Promise<void> {
    if (!this.config.enabled || !policy.enabled) {
      return;
    }

    const runtimeResult = await this.resolveRuntimeContext(
      operation,
      serverId,
      entityId,
      scopeContext,
      policy,
      requestParams,
    );
    if (runtimeResult.bypassReason) {
      return;
    }

    const runtime = runtimeResult.context;

    const admissionKey = this.keyBuilder.buildAdmissionKey(
      this.config.keyPrefix,
      operation,
      serverId,
      runtime.entityHash,
      policy.scope,
      runtime.scopeHash,
      runtime.versions.globalVersion,
      runtime.versions.serverVersion,
      runtime.versions.entityVersion,
      runtime.requestHash,
    );

    try {
      await this.cacheStore.clearAdmission(admissionKey);
    } catch (error) {
      this.metrics.errors += 1;
      this.logger.warn({ error, admissionKey }, 'Result cache admission clear failed');
    }
  }

  shouldPromote(admissionCount: number, policy: ResolvedCachePolicy): boolean {
    if (policy.admissionPolicy === AdmissionPolicy.Immediate) {
      return true;
    }

    const shouldPromote = admissionCount >= 2;
    if (!shouldPromote) {
      this.metrics.admission_deferred += 1;
    }
    return shouldPromote;
  }

  async invalidateResource(serverId: string, uri: string): Promise<void> {
    await this.purgeResource(serverId, uri);
    this.metrics.invalidations += 1;
  }

  async purgeGlobal(): Promise<void> {
    const key = this.keyBuilder.buildNamespaceKey(this.config.keyPrefix, 'global');
    await this.bumpNamespace(key);
  }

  async purgeServer(serverId: string): Promise<void> {
    const key = this.keyBuilder.buildNamespaceKey(this.config.keyPrefix, 'server', serverId);
    await this.bumpNamespace(key);
  }

  async purgeTool(serverId: string, toolName: string): Promise<void> {
    const key = this.keyBuilder.buildNamespaceKey(
      this.config.keyPrefix,
      'tool',
      serverId,
      toolName,
    );
    await this.bumpNamespace(key);
  }

  async purgePrompt(serverId: string, promptName: string): Promise<void> {
    const key = this.keyBuilder.buildNamespaceKey(
      this.config.keyPrefix,
      'prompt',
      serverId,
      promptName,
    );
    await this.bumpNamespace(key);
  }

  async purgeResource(serverId: string, uri: string): Promise<void> {
    const uriHash = this.keyBuilder.buildEntityHash(uri);
    const key = this.keyBuilder.buildNamespaceKey(
      this.config.keyPrefix,
      'resource',
      serverId,
      uriHash,
    );
    await this.bumpNamespace(key);
  }

  async purgeExact(
    operation: CacheOperationType,
    serverId: string,
    entityId: string,
    scopeContext: CacheScopeContext,
    policy: ResolvedCachePolicy,
    requestParams: unknown,
  ): Promise<void> {
    const runtimeResult = await this.resolveRuntimeContext(
      operation,
      serverId,
      entityId,
      scopeContext,
      policy,
      requestParams,
    );
    if (runtimeResult.bypassReason) {
      return;
    }

    const runtime = runtimeResult.context;

    const entryKey = this.keyBuilder.buildResultEntryKey(
      this.config.keyPrefix,
      operation,
      serverId,
      runtime.entityHash,
      policy.scope,
      runtime.scopeHash,
      runtime.versions.globalVersion,
      runtime.versions.serverVersion,
      runtime.versions.entityVersion,
      runtime.requestHash,
    );

    const admissionKey = this.keyBuilder.buildAdmissionKey(
      this.config.keyPrefix,
      operation,
      serverId,
      runtime.entityHash,
      policy.scope,
      runtime.scopeHash,
      runtime.versions.globalVersion,
      runtime.versions.serverVersion,
      runtime.versions.entityVersion,
      runtime.requestHash,
    );

    await Promise.all([
      this.cacheStore.delete(entryKey),
      this.cacheStore.clearAdmission(admissionKey),
    ]);
    this.metrics.purges += 1;
  }

  async getHealth(): Promise<{ ok: boolean; details?: string; backend: string }> {
    try {
      const health = await this.cacheStore.healthcheck();
      return {
        ok: health.ok,
        details: health.details,
        backend: this.config.backend,
      };
    } catch (error) {
      this.metrics.errors += 1;
      this.logger.warn({ error }, 'Result cache healthcheck failed');
      return { ok: false, details: 'healthcheck_failed', backend: this.config.backend };
    }
  }

  getMetrics(): Record<string, number> {
    return { ...this.metrics };
  }

  private async resolveRuntimeContext(
    operation: CacheOperationType,
    serverId: string,
    entityId: string,
    scopeContext: CacheScopeContext,
    policy: ResolvedCachePolicy,
    requestParams: unknown,
  ): Promise<
    | { context: ResolvedRuntimeContext; bypassReason?: never }
    | { context: null; bypassReason: CacheBypassReason }
  > {
    const scopeIdentity = this.resolveScopeIdentity(scopeContext, policy.scope);
    if (!scopeIdentity) {
      if (policy.scope === CacheScope.User) {
        return { context: null, bypassReason: 'missing_user_scope_identity' };
      }
      if (policy.scope === CacheScope.Tenant) {
        return { context: null, bypassReason: 'missing_tenant_scope_identity' };
      }
      return { context: null, bypassReason: 'missing_scope_identity' };
    }

    const scopeHash = this.keyBuilder.buildScopeHash(scopeIdentity);
    const entityHash = this.keyBuilder.buildEntityHash(entityId);
    const requestHash = this.keyBuilder.canonicalizeParams(
      requestParams,
      policy.denyFields,
      policy.allowFields,
    );
    const namespaceKeys = this.getNamespaceKeys(operation, serverId, entityId);

    let versions: VersionSet;
    try {
      const [globalVersion, serverVersion, entityVersion] = await Promise.all([
        this.cacheStore.getNamespaceVersion(namespaceKeys.global),
        this.cacheStore.getNamespaceVersion(namespaceKeys.server),
        this.cacheStore.getNamespaceVersion(namespaceKeys.entity),
      ]);
      versions = { globalVersion, serverVersion, entityVersion };
    } catch (error) {
      this.metrics.errors += 1;
      this.logger.warn(
        { error, operation, serverId, entityId },
        'Result cache namespace resolution failed',
      );
      return { context: null, bypassReason: 'backend_unavailable' };
    }

    return {
      context: {
        scopeIdentity,
        scopeHash,
        requestHash,
        entityHash,
        versions,
        namespaceKeys,
      },
    };
  }

  private resolveScopeIdentity(
    scopeContext: CacheScopeContext,
    scopeType: CacheScope,
  ): string | null {
    if (scopeType === CacheScope.Global) {
      return 'global';
    }

    if (scopeType === CacheScope.User) {
      return scopeContext.userId ?? null;
    }

    if (scopeType === CacheScope.Tenant) {
      return scopeContext.tenantId ?? null;
    }

    return null;
  }

  private getNamespaceKeys(
    operation: CacheOperationType,
    serverId: string,
    entityId: string,
  ): {
    global: string;
    server: string;
    entity: string;
  } {
    const global = this.keyBuilder.buildNamespaceKey(this.config.keyPrefix, 'global');
    const server = this.keyBuilder.buildNamespaceKey(this.config.keyPrefix, 'server', serverId);

    if (operation === 'tool') {
      return {
        global,
        server,
        entity: this.keyBuilder.buildNamespaceKey(
          this.config.keyPrefix,
          'tool',
          serverId,
          entityId,
        ),
      };
    }

    if (operation === 'prompt') {
      return {
        global,
        server,
        entity: this.keyBuilder.buildNamespaceKey(
          this.config.keyPrefix,
          'prompt',
          serverId,
          entityId,
        ),
      };
    }

    const entityHash = this.keyBuilder.buildEntityHash(entityId);
    return {
      global,
      server,
      entity: this.keyBuilder.buildNamespaceKey(
        this.config.keyPrefix,
        'resource',
        serverId,
        entityHash,
      ),
    };
  }

  private async bumpNamespace(namespaceKey: string): Promise<void> {
    try {
      await this.cacheStore.bumpNamespaceVersion(namespaceKey);
      this.metrics.purges += 1;
    } catch (error) {
      this.metrics.errors += 1;
      this.logger.warn({ error, namespaceKey }, 'Result cache namespace purge failed');
    }
  }

  private bypass(reason: CacheBypassReason): CacheLookupResult {
    this.metrics.bypasses += 1;
    return { hit: false, bypassReason: reason };
  }

  private miss(): CacheLookupResult {
    this.metrics.misses += 1;
    return { hit: false };
  }

  private estimatePayloadBytes(value: unknown): number | null {
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        return null;
      }
      return Buffer.byteLength(serialized, 'utf8');
    } catch {
      return null;
    }
  }
}
