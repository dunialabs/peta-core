/**
 * ApprovalService - Async Human-in-the-Loop Approval Queue Manager
 *
 * Orchestrates the approval lifecycle:
 * 1. PolicyEngine decides REQUIRE_APPROVAL
 * 2. ApprovalService creates/deduplicates a pending request (via requestHash)
 * 3. Client (Desk) receives notification and shows approval UI
 * 4. User approves/rejects via Desk → ApprovalService.decide()
 * 5. Next tool call with same requestHash finds APPROVED → claims and executes
 *
 * Key properties:
 * - Idempotent: duplicate tool calls with same args deduplicate via requestHash
 * - Durable: approval state persists in DB, survives restarts
 * - Async: no synchronous 55s timeout — approval can happen at any time before expiry
 */

import { createLogger } from '../../logger/index.js';
import { ApprovalStatus } from '../../types/enums.js';
import { ApprovalRepository, CreateApprovalParams } from '../../repositories/ApprovalRepository.js';
import { approvalRequestHasher } from './ApprovalRequestHasher.js';
import type { ApprovalRequest } from '@prisma/client';

const logger = createLogger('ApprovalService');

/** Default approval expiry: 10 minutes */
const DEFAULT_EXPIRY_MS = 10 * 60 * 1000;
const APPROVAL_CREATE_RATE_LIMIT_COUNT = 10;
const APPROVAL_CREATE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const APPROVAL_CREATE_RATE_LIMIT_PER_HASH_COUNT = 3;
const EXECUTING_STALE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_EXECUTION_RESULT_BYTES = 64 * 1024;
const MAX_EXECUTION_RESULT_PREVIEW_CHARS = 280;

export interface CreateApprovalInput {
  userId: string;
  serverId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  policyVersion: number;
  uniformRequestId?: string | null;
  expiresInMs?: number;
}

export interface ApprovalCheckResult {
  /** Whether approval is required and pending */
  needsApproval: boolean;
  created: boolean;
  /** The approval request (if created or found pending) */
  request: ApprovalRequest | null;
  /** The request hash for retry matching */
  requestHash: string;
}

export interface ApprovalClaimResult {
  /** Whether the approved request was successfully claimed */
  claimed: boolean;
  /** The claimed approval request */
  request: ApprovalRequest | null;
}

export class ApprovalRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRateLimitError';
  }
}

export class ApprovalService {
  private static instance: ApprovalService;
  private expirySweeper: NodeJS.Timeout | null = null;

  private constructor() {}

  static getInstance(): ApprovalService {
    if (!ApprovalService.instance) {
      ApprovalService.instance = new ApprovalService();
    }
    return ApprovalService.instance;
  }

  /**
   * Create or retrieve a pending approval request.
   *
   * Called by ProxySession.handleToolCall() when PolicyEngine returns REQUIRE_APPROVAL.
   *
   * Flow:
   * 1. Compute requestHash from (userId, serverId, toolName, args, policyVersion)
   * 2. Try to INSERT new PENDING request (ON CONFLICT → deduplicate)
   * 3. If existing APPROVED request found → return it for immediate claim
   * 4. If PENDING → caller should return error with retry token to client
   *
   * @returns ApprovalCheckResult indicating whether approval is still needed
   */
  async checkOrCreateApproval(input: CreateApprovalInput): Promise<ApprovalCheckResult> {
    const { userId, serverId, toolName, args, policyVersion, uniformRequestId, expiresInMs } =
      input;

    const requestHash = approvalRequestHasher.computeHash(
      userId,
      serverId,
      toolName,
      args,
      policyVersion,
    );

    const canonicalArgsJson = approvalRequestHasher.canonicalizeArgs(toolName, args);
    const canonicalArgs = JSON.parse(canonicalArgsJson) as Record<string, unknown>;
    const redactedArgs = this.redactArgs(args);

    const existing = await ApprovalRepository.findActiveByRequestHash(requestHash);
    if (existing) {
      if (existing.status === ApprovalStatus.Approved) {
        return { needsApproval: false, created: false, request: existing, requestHash };
      }
      return { needsApproval: true, created: false, request: existing, requestHash };
    }

    const rateLimitWindowStart = new Date(Date.now() - APPROVAL_CREATE_RATE_LIMIT_WINDOW_MS);

    const recentCreatesByHash = await ApprovalRepository.countRecentCreationsByRequestHash(
      userId,
      requestHash,
      rateLimitWindowStart,
    );

    if (recentCreatesByHash >= APPROVAL_CREATE_RATE_LIMIT_PER_HASH_COUNT) {
      throw new ApprovalRateLimitError(
        `Too many retries for this exact approval request. Please retry after 60 seconds.`,
      );
    }

    const recentCreates = await ApprovalRepository.countRecentCreationsByTool(
      userId,
      serverId,
      toolName,
      rateLimitWindowStart,
    );

    if (recentCreates >= APPROVAL_CREATE_RATE_LIMIT_COUNT) {
      throw new ApprovalRateLimitError(
        `Too many approval requests for ${toolName}. Please retry after 60 seconds.`,
      );
    }

    const expiresAt = new Date(Date.now() + (expiresInMs ?? DEFAULT_EXPIRY_MS));

    const params: CreateApprovalParams = {
      userId,
      serverId,
      toolName,
      canonicalArgs,
      redactedArgs,
      policyVersion,
      requestHash,
      expiresAt,
      uniformRequestId: uniformRequestId ?? null,
    };

    const { created, request } = await ApprovalRepository.createOrGetPending(params);

    if (created) {
      logger.info(
        { approvalRequestId: request.id, requestHash, toolName, userId },
        'Created new pending approval request',
      );
    }

    if (!created && request.status === ApprovalStatus.Approved) {
      logger.info(
        { approvalRequestId: request.id, requestHash },
        'Found existing APPROVED request, ready to claim',
      );
      return { needsApproval: false, created: false, request, requestHash };
    }

    return { needsApproval: true, created, request, requestHash };
  }

  /**
   * Try to claim an approved request for execution.
   *
   * Called when a retry tool call arrives and the request has been approved.
   * Atomically transitions APPROVED → EXECUTING to prevent double execution.
   */
  async claimForExecution(requestHash: string): Promise<ApprovalClaimResult> {
    const request = await ApprovalRepository.claimApprovedForExecution(requestHash);

    if (!request) {
      logger.debug({ requestHash }, 'No APPROVED request to claim');
      return { claimed: false, request: null };
    }

    logger.info(
      { approvalRequestId: request.id, requestHash },
      'Claimed approval request for execution',
    );

    return { claimed: true, request };
  }

  async claimForExecutionById(approvalRequestId: string): Promise<ApprovalClaimResult> {
    const request = await ApprovalRepository.claimApprovedForExecutionById(approvalRequestId);

    if (!request) {
      logger.debug({ approvalRequestId }, 'No APPROVED request to claim by id');
      return { claimed: false, request: null };
    }

    logger.info(
      { approvalRequestId: request.id, requestHash: request.requestHash },
      'Claimed approval request for execution by id',
    );

    return { claimed: true, request };
  }

  async decide(
    approvalRequestId: string,
    decision: 'APPROVED' | 'REJECTED',
    reason?: string,
  ): Promise<ApprovalRequest | null> {
    const request = await ApprovalRepository.decide(approvalRequestId, decision, reason);

    if (!request) {
      logger.warn(
        { approvalRequestId, decision },
        'Decision failed: request not found, not PENDING, or expired',
      );
      return null;
    }

    logger.info(
      { approvalRequestId, decision, requestHash: request.requestHash },
      `Approval request ${decision.toLowerCase()}`,
    );

    return request;
  }

  async markExecuted(id: string, executionResult: unknown): Promise<ApprovalRequest | null> {
    const safeExecutionResult = this.sanitizeExecutionResult(executionResult);
    return ApprovalRepository.markExecuted(id, safeExecutionResult);
  }

  async markFailed(id: string, error: string): Promise<ApprovalRequest | null> {
    return ApprovalRepository.markFailed(id, error);
  }

  async touchExecuting(id: string): Promise<ApprovalRequest | null> {
    return ApprovalRepository.touchExecuting(id);
  }

  async listPending(
    userId?: string | null,
    filters?: { serverId?: string; toolName?: string },
  ): Promise<ApprovalRequest[]> {
    return ApprovalRepository.listPending(userId ?? null, filters);
  }

  async countPending(userId?: string | null): Promise<number> {
    return ApprovalRepository.countPending(userId ?? null);
  }

  async getById(id: string): Promise<ApprovalRequest | null> {
    return ApprovalRepository.findById(id);
  }

  async getResultById(id: string): Promise<ApprovalRequest | null> {
    const request = await ApprovalRepository.findById(id);
    if (!request) {
      return null;
    }

    if (request.status !== ApprovalStatus.Executed && request.status !== ApprovalStatus.Failed) {
      return null;
    }

    return request;
  }

  async expireStale(): Promise<ApprovalRequest[]> {
    const requests = await ApprovalRepository.expireStale();
    if (requests.length > 0) {
      logger.info({ count: requests.length }, 'Expired stale approval requests');
    }
    return requests;
  }

  async recoverStaleExecuting(): Promise<ApprovalRequest[]> {
    const requests = await ApprovalRepository.recoverStaleExecuting(
      new Date(Date.now() - EXECUTING_STALE_TIMEOUT_MS),
    );
    if (requests.length > 0) {
      logger.warn({ count: requests.length }, 'Recovered stale EXECUTING approval requests');
    }
    return requests;
  }

  startExpirySweeper(notifier: {
    notifyApprovalExpired: (userId: string, data: { id: string; toolName: string }) => void;
    notifyApprovalFailed?: (
      userId: string,
      data: { id: string; toolName: string; error: string },
    ) => void;
  }): void {
    if (this.expirySweeper) {
      return;
    }

    this.expirySweeper = setInterval(() => {
      void this.expireStale()
        .then((expiredRequests) => {
          for (const request of expiredRequests) {
            notifier.notifyApprovalExpired(request.userId, {
              id: request.id,
              toolName: request.toolName,
            });
          }
        })
        .catch((error) => {
          logger.error({ error }, 'Failed to run approval expiry sweeper');
        });

      void this.recoverStaleExecuting()
        .then((recoveredRequests) => {
          for (const request of recoveredRequests) {
            if (notifier.notifyApprovalFailed) {
              notifier.notifyApprovalFailed(request.userId, {
                id: request.id,
                toolName: request.toolName,
                error: request.executionError ?? 'Stale executing request recovered',
              });
            } else {
              notifier.notifyApprovalExpired(request.userId, {
                id: request.id,
                toolName: request.toolName,
              });
            }
          }
        })
        .catch((error) => {
          logger.error({ error }, 'Failed to recover stale EXECUTING approvals');
        });
    }, 60_000);
  }

  stopExpirySweeper(): void {
    if (!this.expirySweeper) {
      return;
    }

    clearInterval(this.expirySweeper);
    this.expirySweeper = null;
  }

  /**
   * Redact tool arguments for display purposes.
   *
   * Strategy:
   * - Keep all keys visible
   * - Truncate string values longer than 100 chars
   * - Replace deeply nested objects with "[object]"
   * - Keep numbers, booleans, and short strings as-is
   */
  private redactArgs(args: Record<string, unknown>, depth: number = 0): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    const MAX_STRING_LENGTH = 100;
    const MAX_DEPTH = 2;

    for (const [key, value] of Object.entries(args)) {
      if (value === null || value === undefined) {
        redacted[key] = value;
      } else if (typeof value === 'string') {
        redacted[key] =
          value.length > MAX_STRING_LENGTH ? value.substring(0, MAX_STRING_LENGTH) + '...' : value;
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        redacted[key] = value;
      } else if (Array.isArray(value)) {
        if (depth < MAX_DEPTH) {
          redacted[key] = value.map((item) => {
            if (item === null || item === undefined) return item;
            if (typeof item === 'string') {
              return item.length > MAX_STRING_LENGTH
                ? item.substring(0, MAX_STRING_LENGTH) + '...'
                : item;
            }
            if (typeof item === 'number' || typeof item === 'boolean') return item;
            if (typeof item === 'object') return '[object]';
            return String(item);
          });
        } else {
          redacted[key] = `[Array(${value.length})]`;
        }
      } else if (typeof value === 'object') {
        if (depth < MAX_DEPTH) {
          redacted[key] = this.redactArgs(value as Record<string, unknown>, depth + 1);
        } else {
          redacted[key] = '[object]';
        }
      } else {
        redacted[key] = String(value);
      }
    }

    return redacted;
  }

  private sanitizeExecutionResult(executionResult: unknown): Record<string, unknown> {
    if (!executionResult || typeof executionResult !== 'object' || Array.isArray(executionResult)) {
      return {
        kind: 'execution_result_unavailable',
        preview: 'Execution result is unavailable for replay.',
        truncated: false,
      };
    }

    try {
      const redactedResult = this.redactSensitiveExecutionFields(
        executionResult as Record<string, unknown>,
      );
      const rawJson = JSON.stringify(redactedResult);
      if (rawJson.length <= MAX_EXECUTION_RESULT_BYTES) {
        return redactedResult;
      }

      return {
        kind: 'execution_result_truncated',
        preview: rawJson.slice(0, MAX_EXECUTION_RESULT_PREVIEW_CHARS),
        truncated: true,
        originalSizeBytes: rawJson.length,
      };
    } catch {
      return {
        kind: 'execution_result_unserializable',
        preview: 'Execution result could not be serialized safely.',
        truncated: false,
      };
    }
  }

  private redactSensitiveExecutionFields(input: Record<string, unknown>): Record<string, unknown> {
    const sensitivePattern = /(password|secret|token|apikey|api_key|authorization|credential)/i;

    const walk = (value: unknown, keyHint?: string): unknown => {
      if (keyHint && sensitivePattern.test(keyHint)) {
        return '[redacted]';
      }

      if (Array.isArray(value)) {
        return value.map((item) => walk(item));
      }

      if (!value || typeof value !== 'object') {
        return value;
      }

      const result: Record<string, unknown> = {};
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        result[nestedKey] = walk(nestedValue, nestedKey);
      }
      return result;
    };

    return walk(input) as Record<string, unknown>;
  }
}

export const approvalService = ApprovalService.getInstance();
