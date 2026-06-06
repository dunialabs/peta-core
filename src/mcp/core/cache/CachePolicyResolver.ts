import type { ResultCacheConfig } from '../../../config/resultCacheConfig.js';
import { DangerLevel } from '../../../types/enums.js';
import type { ServerConfigCapabilities } from '../../types/mcp.js';
import { CacheKeyBuilder } from './CacheKeyBuilder.js';
import {
  AdmissionPolicy,
  CacheScope,
  type CachePolicyConfig,
  type ResolvedCachePolicy,
} from './types.js';

const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 86400;
const MIN_ENTRY_BYTES = 1024;
const MAX_ENTRY_BYTES = 5242880;

export class CachePolicyResolver {
  resolveToolPolicy(
    capabilitiesConfig: ServerConfigCapabilities,
    toolName: string,
    globalConfig: ResultCacheConfig,
  ): ResolvedCachePolicy | null {
    if (!globalConfig.enabled) {
      return null;
    }

    const toolConfig = capabilitiesConfig.tools[toolName];
    if (!toolConfig) {
      return null;
    }

    if (!this.isToolCacheSafe(toolConfig.dangerLevel)) {
      return null;
    }

    return this.resolvePolicy(globalConfig, toolConfig.cache);
  }

  resolvePromptPolicy(
    capabilitiesConfig: ServerConfigCapabilities,
    promptName: string,
    globalConfig: ResultCacheConfig,
  ): ResolvedCachePolicy | null {
    if (!globalConfig.enabled) {
      return null;
    }

    const promptConfig = capabilitiesConfig.prompts[promptName];
    if (!promptConfig) {
      return null;
    }

    return this.resolvePolicy(globalConfig, promptConfig.cache);
  }

  resolveResourcePolicy(
    capabilitiesConfig: ServerConfigCapabilities,
    uri: string,
    resourceName: string | undefined,
    globalConfig: ResultCacheConfig,
  ): ResolvedCachePolicy | null {
    if (!globalConfig.enabled) {
      return null;
    }

    const exactOverride = capabilitiesConfig.resourceCachePolicies?.exact?.[uri];
    if (exactOverride) {
      if (exactOverride.enabled === false) {
        return null;
      }
      const policy: CachePolicyConfig = {
        ...(exactOverride.cache ?? {}),
        enabled: exactOverride.cache?.enabled ?? exactOverride.enabled ?? true,
      };
      return this.resolvePolicy(globalConfig, policy);
    }

    const matchedPattern = this.matchResourcePattern(
      capabilitiesConfig.resourceCachePolicies?.patterns ?? [],
      uri,
    );
    if (matchedPattern) {
      if (matchedPattern.enabled === false) {
        return null;
      }
      const policy: CachePolicyConfig = {
        ...(matchedPattern.cache ?? {}),
        enabled: matchedPattern.cache?.enabled ?? matchedPattern.enabled ?? true,
      };
      return this.resolvePolicy(globalConfig, policy);
    }

    const resourceConfig = capabilitiesConfig.resources[uri] ?? (resourceName ? capabilitiesConfig.resources[resourceName] : undefined);
    if (!resourceConfig) {
      return null;
    }

    return this.resolvePolicy(globalConfig, resourceConfig.cache);
  }

  isToolCacheSafe(dangerLevel?: DangerLevel): boolean {
    if (dangerLevel === undefined) {
      return true;
    }
    return dangerLevel < DangerLevel.Approval;
  }

  private resolvePolicy(
    globalConfig: ResultCacheConfig,
    capabilityPolicy?: CachePolicyConfig,
  ): ResolvedCachePolicy | null {
    if (!capabilityPolicy || !capabilityPolicy.enabled) {
      return null;
    }

    const ttlSeconds = this.clamp(
      capabilityPolicy.ttlSeconds ?? globalConfig.defaultTtlSeconds,
      MIN_TTL_SECONDS,
      MAX_TTL_SECONDS,
    );

    const admissionWindowSeconds = this.clamp(
      capabilityPolicy.admissionWindowSeconds ?? globalConfig.defaultAdmissionWindowSeconds,
      MIN_TTL_SECONDS,
      MAX_TTL_SECONDS,
    );

    const maxEntryBytes = this.clamp(
      capabilityPolicy.maxEntryBytes ?? globalConfig.maxEntryBytes,
      MIN_ENTRY_BYTES,
      MAX_ENTRY_BYTES,
    );

    const defaultDenyFields = CacheKeyBuilder.DEFAULT_DENY_FIELDS;
    const denyFields = Array.from(
      new Set([...(capabilityPolicy.key?.denyFields ?? []), ...defaultDenyFields]),
    );
    const allowFields = capabilityPolicy.key?.allowFields?.length
      ? capabilityPolicy.key.allowFields
      : undefined;

    return {
      enabled: true,
      ttlSeconds,
      scope: capabilityPolicy.scope ?? CacheScope.User,
      admissionPolicy:
        capabilityPolicy.admissionPolicy ??
        this.toAdmissionPolicy(globalConfig.defaultAdmissionPolicy),
      admissionWindowSeconds,
      denyFields,
      allowFields,
      maxEntryBytes,
    };
  }

  private matchResourcePattern(
    patterns: Array<{ pattern: string; enabled?: boolean; cache?: CachePolicyConfig }>,
    uri: string,
  ): { pattern: string; enabled?: boolean; cache?: CachePolicyConfig } | null {
    const sorted = [...patterns].sort((a, b) => {
      const aPrefixLength = this.literalPrefix(a.pattern).length;
      const bPrefixLength = this.literalPrefix(b.pattern).length;
      return bPrefixLength - aPrefixLength;
    });

    for (const candidate of sorted) {
      if (this.matches(candidate.pattern, uri)) {
        return candidate;
      }
    }

    return null;
  }

  private literalPrefix(pattern: string): string {
    const wildcardIndex = pattern.indexOf('*');
    return wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
  }

  private matches(pattern: string, value: string): boolean {
    if (!pattern.includes('*')) {
      return value === pattern;
    }

    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return value.startsWith(prefix);
    }

    return value === pattern;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private toAdmissionPolicy(value: ResultCacheConfig['defaultAdmissionPolicy']): AdmissionPolicy {
    return value === AdmissionPolicy.SecondHit
      ? AdmissionPolicy.SecondHit
      : AdmissionPolicy.Immediate;
  }
}
