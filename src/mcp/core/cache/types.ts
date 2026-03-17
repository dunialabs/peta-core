export enum CacheScope {
  User = 'user',
  Tenant = 'tenant',
  Global = 'global',
}

export enum AdmissionPolicy {
  Immediate = 'immediate',
  SecondHit = 'second_hit',
}

export interface CachePolicyConfig {
  enabled: boolean;
  ttlSeconds?: number;
  scope?: CacheScope;
  admissionPolicy?: AdmissionPolicy;
  admissionWindowSeconds?: number;
  key?: {
    denyFields?: string[];
    allowFields?: string[];
  };
  maxEntryBytes?: number;
}

export interface ResourceCachePolicies {
  exact?: Record<string, { enabled?: boolean; cache?: CachePolicyConfig }>;
  patterns?: Array<{ pattern: string; enabled?: boolean; cache?: CachePolicyConfig }>;
}

export interface CacheEntryEnvelope {
  schemaVersion: number;
  operation: 'tool' | 'resource' | 'prompt';
  serverId: string;
  entityId: string;
  scopeType: CacheScope;
  scopeHash: string;
  createdAt: string;
  ttlSeconds: number;
  admissionPolicy: AdmissionPolicy;
  admittedAfterObservations: number;
  payloadEncoding: 'json' | 'gzip-json';
  payloadBytes: number;
  requestHash: string;
  payload: unknown;
}

export interface ResolvedCachePolicy {
  enabled: boolean;
  ttlSeconds: number;
  scope: CacheScope;
  admissionPolicy: AdmissionPolicy;
  admissionWindowSeconds: number;
  denyFields: string[];
  allowFields?: string[];
  maxEntryBytes: number;
}

export interface CacheLookupResult {
  hit: boolean;
  entry?: CacheEntryEnvelope;
  bypassReason?: CacheBypassReason;
}

export type CacheBypassReason =
  | 'disabled_globally'
  | 'disabled_by_policy'
  | 'non_cacheable_dangerous_tool'
  | 'missing_user_scope_identity'
  | 'missing_tenant_scope_identity'
  | 'payload_too_large'
  | 'serialization_failed'
  | 'deserialization_failed'
  | 'backend_unavailable'
  | 'unsupported_response_type'
  | 'errors_not_cacheable'
  | 'admission_waiting_for_second_hit'
  | 'admission_record_failed';

export interface CacheScopeContext {
  userId?: string;
  tenantId?: string;
}

export type CacheOperationType = 'tool' | 'resource' | 'prompt';
