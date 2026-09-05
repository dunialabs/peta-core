import { createHash } from 'crypto';

import { createLogger } from '../../logger/index.js';

const logger = createLogger('ApprovalRequestHasher');

export type CanonicalArgs = Record<string, unknown>;

const APPROVAL_HASH_VERSION = 'v2';

export class ApprovalRequestHasher {
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

    const keys = Object.keys(obj).sort();
    return Object.fromEntries(
      keys.map((key) => [key, this.sortKeys((obj as Record<string, unknown>)[key])]),
    );
  }

  canonicalizeArgs(args: Record<string, unknown>): string {
    const sorted = this.sortKeys(args);

    return JSON.stringify(sorted);
  }

  computeHash(
    userId: string,
    serverId: string | null | undefined,
    toolName: string,
    args: Record<string, unknown>,
    policyVersion: number
  ): string {
    const canonicalArgs = this.canonicalizeArgs(args);
    const hashInput = JSON.stringify([
      APPROVAL_HASH_VERSION,
      userId,
      serverId ?? null,
      toolName,
      canonicalArgs,
      policyVersion,
    ]);

    const hash = createHash('sha256').update(hashInput).digest('hex');

    logger.debug({ toolName, requestHash: hash }, 'Computed approval request hash');

    return hash;
  }
}

export const approvalRequestHasher = new ApprovalRequestHasher();
