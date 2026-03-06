import { createHash } from 'crypto';

import { createLogger } from '../../logger/index.js';

const logger = createLogger('ApprovalRequestHasher');

export type CanonicalArgs = Record<string, unknown>;

export type ArgsNormalizer = (args: Record<string, unknown>) => Record<string, unknown>;

export class ApprovalRequestHasher {
  private normalizers: Map<string, ArgsNormalizer> = new Map();

  constructor() {
    this.registerDefaultNormalizers();
  }

  private registerDefaultNormalizers(): void {
    // TODO: Register tool-specific argument normalizers as needed.
  }

  registerNormalizer(toolName: string, normalizer: ArgsNormalizer): void {
    this.normalizers.set(toolName, normalizer);
  }

  private stripVolatileFields(obj: unknown): unknown {
    if (obj === null || obj === undefined) {
      return undefined;
    }

    if (typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.stripVolatileFields(item)).filter((item) => item !== undefined);
    }

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (key === '_meta') {
        continue;
      }

      const cleaned = this.stripVolatileFields(value);

      if (cleaned === null || cleaned === undefined) {
        continue;
      }

      if (Array.isArray(cleaned) && cleaned.length === 0) {
        continue;
      }
      if (typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) {
        continue;
      }

      result[key] = cleaned;
    }

    return result;
  }

  private sortKeys(obj: unknown): unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.sortKeys(item));
    }

    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj).sort();

    for (const key of keys) {
      sorted[key] = this.sortKeys((obj as Record<string, unknown>)[key]);
    }

    return sorted;
  }

  canonicalizeArgs(toolName: string, args: Record<string, unknown>): string {
    let normalized = args;
    const normalizer = this.normalizers.get(toolName);
    if (normalizer) {
      normalized = normalizer(args);
    }

    const stripped = this.stripVolatileFields(normalized);
    const sorted = this.sortKeys(stripped);

    return JSON.stringify(sorted);
  }

  computeHash(
    userId: string,
    serverId: string | null | undefined,
    toolName: string,
    args: Record<string, unknown>,
    policyVersion: number
  ): string {
    const canonicalArgs = this.canonicalizeArgs(toolName, args);
    const hashInput = `${userId}|${serverId ?? ''}|${toolName}|${canonicalArgs}|${policyVersion}`;

    const hash = createHash('sha256').update(hashInput).digest('hex');

    logger.debug({ toolName, requestHash: hash }, 'Computed approval request hash');

    return hash;
  }
}

export const approvalRequestHasher = new ApprovalRequestHasher();
