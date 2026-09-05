import { createHash } from 'node:crypto';
import { CacheScope, type CacheOperationType } from './types.js';

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

export class CacheKeyBuilder {
  canonicalizeParams(params: unknown, denyFields: string[], allowFields?: string[]): string {
    const denySet = new Set(denyFields);
    const prepared = this.applyFieldPolicies(params, denySet, allowFields);
    const canonical = this.stableStringify(this.normalizeValue(prepared));
    return this.sha256(canonical);
  }

  buildEntityHash(entityId: string): string {
    return this.sha256(entityId);
  }

  buildScopeHash(scopeIdentity: string): string {
    return this.sha256(scopeIdentity);
  }

  buildResultEntryKey(
    prefix: string,
    operation: CacheOperationType,
    serverId: string,
    entityHash: string,
    scopeType: CacheScope,
    scopeHash: string,
    globalVersion: number,
    serverVersion: number,
    entityVersion: number,
    requestHash: string,
  ): string {
    return `${prefix}:rc:v2:${operation}:${serverId}:${entityHash}:${scopeType}:${scopeHash}:gv${globalVersion}:sv${serverVersion}:ev${entityVersion}:${requestHash}`;
  }

  buildAdmissionKey(
    prefix: string,
    operation: CacheOperationType,
    serverId: string,
    entityHash: string,
    scopeType: CacheScope,
    scopeHash: string,
    globalVersion: number,
    serverVersion: number,
    entityVersion: number,
    requestHash: string,
  ): string {
    return `${prefix}:rcadm:v2:${operation}:${serverId}:${entityHash}:${scopeType}:${scopeHash}:gv${globalVersion}:sv${serverVersion}:ev${entityVersion}:${requestHash}`;
  }

  buildNamespaceKey(prefix: string, ...parts: string[]): string {
    return `${prefix}:rcns:${parts.join(':')}`;
  }

  private sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  private applyFieldPolicies(
    value: unknown,
    denySet: Set<string>,
    allowFields?: string[],
  ): unknown {
    if (allowFields && this.isRecord(value)) {
      const allowed = new Set(allowFields);
      const filtered = Object.fromEntries(
        Object.entries(value).filter(([key]) => allowed.has(key)),
      );
      return this.stripDeniedFields(filtered, denySet);
    }
    return this.stripDeniedFields(value, denySet);
  }

  private stripDeniedFields(value: unknown, denySet: Set<string>): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.stripDeniedFields(item, denySet));
    }

    if (!this.isRecord(value)) {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !denySet.has(key))
        .map(([key, nested]) => [key, this.stripDeniedFields(nested, denySet)]),
    );
  }

  private normalizeValue(value: unknown): JsonLike {
    if (value === null) {
      return null;
    }
    if (value === undefined) {
      return { __type: 'undefined' };
    }

    const valueType = typeof value;
    if (valueType === 'string') {
      return value as string;
    }
    if (valueType === 'boolean') {
      return value as boolean;
    }
    if (valueType === 'number') {
      if (!Number.isFinite(value as number)) {
        return { __type: 'non_finite_number', value: String(value) };
      }
      return value as number;
    }
    if (valueType === 'bigint') {
      return { __type: 'bigint', value: (value as bigint).toString(10) };
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeValue(item));
    }

    if (value instanceof Date) {
      return { __type: 'date', value: value.toISOString() };
    }

    if (!this.isRecord(value)) {
      return { __type: 'unsupported', value: Object.prototype.toString.call(value) };
    }

    const keys = Object.keys(value).sort();
    return Object.fromEntries(
      keys.map((key) => [key, this.normalizeValue(value[key])]),
    );
  }

  private stableStringify(value: JsonLike): string {
    if (value === null) {
      return 'null';
    }
    if (typeof value === 'string') {
      return JSON.stringify(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }

    const keys = Object.keys(value).sort();
    const items = keys.map((key) => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`);
    return `{${items.join(',')}}`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
