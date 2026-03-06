import { prisma } from '../config/prisma.js';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger/index.js';
import { UserRole } from '../types/enums.js';

const logger = createLogger('ApprovalRepository');

export interface ApprovalRequest {
  id: string;
  userId: string;
  serverId: string | null;
  toolName: string;
  canonicalArgs: Prisma.JsonValue;
  redactedArgs: Prisma.JsonValue;
  policyVersion: number;
  requestHash: string;
  status: string;
  expiresAt: Date;
  decidedAt: Date | null;
  decisionReason: string | null;
  decidedByUserId: string | null;
  decidedByRole: UserRole | null;
  decisionChannel: string | null;
  executedAt: Date | null;
  executionError: string | null;
  executionResult: Prisma.JsonValue | null;
  uniformRequestId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalDecisionActor {
  actorUserId: string | null;
  actorRole: UserRole | null;
  channel: 'admin_api' | 'socket';
}

export interface ApprovalListParams {
  userId: string | null;
  status?: string;
  page: number;
  pageSize: number;
  filters?: { serverId?: string; toolName?: string };
}

export interface ApprovalListResult {
  requests: ApprovalRequest[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

type ApprovalRequestDelegate = {
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy?: { createdAt: 'asc' | 'desc' };
  }): Promise<ApprovalRequest | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: { createdAt: 'asc' | 'desc' };
    skip?: number;
    take?: number;
  }): Promise<ApprovalRequest[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  findUnique(args: { where: { id: string } }): Promise<ApprovalRequest | null>;
};

const approvalRequestModel = prisma as unknown as { approvalRequest: ApprovalRequestDelegate };

export interface CreateApprovalParams {
  userId: string;
  serverId: string | null;
  toolName: string;
  canonicalArgs: Record<string, unknown>;
  redactedArgs: Record<string, unknown>;
  policyVersion: number;
  requestHash: string;
  expiresAt: Date;
  uniformRequestId?: string | null;
}

export class ApprovalRepository {
  static async createOrGetPending(
    params: CreateApprovalParams,
    retryCount = 0,
  ): Promise<{ created: boolean; request: ApprovalRequest }> {
    const maxRetries = 3;
    const id = randomUUID();
    const now = new Date();

    const inserted = await prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`
        INSERT INTO approval_request (
          id, user_id, server_id, tool_name,
          canonical_args, redacted_args, policy_version,
          request_hash, status, expires_at,
          uniform_request_id,
          created_at, updated_at
        ) VALUES (
          ${id}, ${params.userId}, ${params.serverId}, ${params.toolName},
          ${JSON.stringify(params.canonicalArgs)}::jsonb, ${JSON.stringify(params.redactedArgs)}::jsonb, ${params.policyVersion},
          ${params.requestHash}, 'PENDING', ${params.expiresAt},
          ${params.uniformRequestId ?? null},
          ${now}, ${now}
        )
        ON CONFLICT (request_hash)
        WHERE status IN ('PENDING', 'APPROVED', 'EXECUTING')
        DO NOTHING
        RETURNING *
      `,
    );

    if (inserted.length > 0) {
      const request = this.mapSnakeToCamel(inserted[0]);
      logger.info(
        { approvalRequestId: request.id, requestHash: params.requestHash, status: 'PENDING' },
        'Created new approval request',
      );
      return { created: true, request };
    }

    const existing = await approvalRequestModel.approvalRequest.findFirst({
      where: {
        requestHash: params.requestHash,
        OR: [
          {
            status: { in: ['PENDING', 'APPROVED'] },
            expiresAt: { gt: now },
          },
          {
            status: 'EXECUTING',
          },
        ],
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!existing) {
      if (retryCount >= maxRetries) {
        throw new Error(
          `Failed to create or find approval request after ${maxRetries} retries: ${params.requestHash}`,
        );
      }

      logger.warn(
        { requestHash: params.requestHash, retryCount },
        'ON CONFLICT triggered but no active non-expired row found; retrying',
      );

      await prisma.$queryRaw(
        Prisma.sql`
          UPDATE approval_request
          SET status = 'EXPIRED', updated_at = NOW()
          WHERE request_hash = ${params.requestHash}
            AND status IN ('PENDING', 'APPROVED')
            AND expires_at <= NOW()
        `,
      );

      return this.createOrGetPending(params, retryCount + 1);
    }

    logger.info(
      { approvalRequestId: existing.id, requestHash: params.requestHash, status: existing.status },
      'Returning existing active approval request',
    );

    return { created: false, request: existing };
  }

  static async decide(
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    actor: ApprovalDecisionActor,
    reason?: string,
  ): Promise<ApprovalRequest | null> {
    const now = new Date();
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`
        UPDATE approval_request
        SET status = ${decision},
            decided_at = ${now},
            decision_reason = ${reason ?? null},
            decided_by_user_id = ${actor.actorUserId},
            decided_by_role = ${actor.actorRole},
            decision_channel = ${actor.channel},
            updated_at = ${now}
        WHERE id = ${id}
          AND status = 'PENDING'
          AND expires_at > ${now}
        RETURNING *
      `,
    );

    if (rows.length === 0) {
      logger.warn(
        { approvalRequestId: id, decision, actorUserId: actor.actorUserId, channel: actor.channel },
        'Decision failed: request not found, not PENDING, or expired',
      );
      return null;
    }

    const request = this.mapSnakeToCamel(rows[0]);
    logger.info(
      {
        approvalRequestId: id,
        decision,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        channel: actor.channel,
      },
      `Approval request ${decision.toLowerCase()}`,
    );
    return request;
  }

  static async claimApprovedForExecution(requestHash: string): Promise<ApprovalRequest | null> {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`
        UPDATE approval_request
        SET status = 'EXECUTING', updated_at = NOW()
        WHERE request_hash = ${requestHash}
          AND status = 'APPROVED'
          AND expires_at > NOW()
        RETURNING *
      `,
    );

    if (rows.length === 0) {
      logger.debug({ requestHash }, 'No APPROVED request to claim for execution');
      return null;
    }

    const request = this.mapSnakeToCamel(rows[0]);
    logger.info(
      { approvalRequestId: request.id, requestHash },
      'Claimed approval request for execution (APPROVED -> EXECUTING)',
    );
    return request;
  }

  static async claimApprovedForExecutionById(id: string): Promise<ApprovalRequest | null> {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`
        UPDATE approval_request
        SET status = 'EXECUTING', updated_at = NOW()
        WHERE id = ${id}
          AND status = 'APPROVED'
          AND expires_at > NOW()
        RETURNING *
      `,
    );

    if (rows.length === 0) {
      logger.debug({ approvalRequestId: id }, 'No APPROVED request to claim for execution by id');
      return null;
    }

    const request = this.mapSnakeToCamel(rows[0]);
    logger.info(
      { approvalRequestId: request.id, requestHash: request.requestHash },
      'Claimed approval request for execution by id (APPROVED -> EXECUTING)',
    );
    return request;
  }

  static async markExecuted(id: string, executionResult: unknown): Promise<ApprovalRequest | null> {
    const now = new Date();
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`
        UPDATE approval_request
        SET status = 'EXECUTED',
            executed_at = ${now},
            execution_result = ${JSON.stringify(executionResult)}::jsonb,
            updated_at = ${now}
        WHERE id = ${id}
          AND status = 'EXECUTING'
        RETURNING *
      `,
    );

    if (rows.length === 0) {
      logger.warn({ approvalRequestId: id }, 'markExecuted failed: not in EXECUTING state');
      return null;
    }

    const request = this.mapSnakeToCamel(rows[0]);
    logger.info({ approvalRequestId: id }, 'Approval request executed (EXECUTING -> EXECUTED)');
    return request;
  }

  static async markFailed(id: string, error: string): Promise<ApprovalRequest | null> {
    const now = new Date();
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`
        UPDATE approval_request
        SET status = 'FAILED', execution_error = ${error}, updated_at = ${now}
        WHERE id = ${id}
          AND status = 'EXECUTING'
        RETURNING *
      `,
    );

    if (rows.length === 0) {
      logger.warn({ approvalRequestId: id, error }, 'markFailed failed: not in EXECUTING state');
      return null;
    }

    const request = this.mapSnakeToCamel(rows[0]);
    logger.info({ approvalRequestId: id, error }, 'Approval request failed (EXECUTING -> FAILED)');
    return request;
  }

  static async touchExecuting(id: string): Promise<ApprovalRequest | null> {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`
        UPDATE approval_request
        SET updated_at = NOW()
        WHERE id = ${id}
          AND status = 'EXECUTING'
        RETURNING *
      `,
    );

    if (rows.length === 0) {
      return null;
    }

    return this.mapSnakeToCamel(rows[0]);
  }

  static async list(params: ApprovalListParams): Promise<ApprovalListResult> {
    const { userId, status, page, pageSize, filters } = params;
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, pageSize);
    const where: Record<string, unknown> = {};

    if (userId) {
      where.userId = userId;
    }

    if (status) {
      if (status === 'PENDING') {
        where.status = 'PENDING';
        where.expiresAt = { gt: new Date() };
      } else {
        where.status = status;
      }
    }

    if (filters?.serverId) {
      where.serverId = filters.serverId;
    }

    if (filters?.toolName) {
      where.toolName = filters.toolName;
    }

    const requests = await approvalRequestModel.approvalRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (safePage - 1) * safePageSize,
      take: safePageSize + 1,
    });

    return {
      requests: requests.slice(0, safePageSize),
      page: safePage,
      pageSize: safePageSize,
      hasMore: requests.length > safePageSize,
    };
  }

  static async countPending(userId: string | null): Promise<number> {
    const where: Record<string, unknown> = {
      status: 'PENDING',
      expiresAt: { gt: new Date() },
    };

    if (userId) {
      where.userId = userId;
    }

    return await approvalRequestModel.approvalRequest.count({
      where,
    });
  }

  static async findById(id: string): Promise<ApprovalRequest | null> {
    return await approvalRequestModel.approvalRequest.findUnique({
      where: { id },
    });
  }

  static async findByRequestHash(requestHash: string): Promise<ApprovalRequest | null> {
    return await approvalRequestModel.approvalRequest.findFirst({
      where: { requestHash },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async findActiveByRequestHash(requestHash: string): Promise<ApprovalRequest | null> {
    return await approvalRequestModel.approvalRequest.findFirst({
      where: {
        requestHash,
        OR: [
          {
            status: { in: ['PENDING', 'APPROVED'] },
            expiresAt: { gt: new Date() },
          },
          {
            status: 'EXECUTING',
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async countRecentCreationsByTool(
    userId: string,
    serverId: string | null,
    toolName: string,
    since: Date,
  ): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS count
        FROM approval_request
        WHERE user_id = ${userId}
          AND tool_name = ${toolName}
          AND (${serverId}::varchar IS NULL AND server_id IS NULL OR server_id = ${serverId})
          AND created_at >= ${since}
      `,
    );

    return Number(rows[0]?.count ?? 0n);
  }

  static async countRecentCreationsByRequestHash(
    userId: string,
    requestHash: string,
    since: Date,
  ): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS count
        FROM approval_request
        WHERE user_id = ${userId}
          AND request_hash = ${requestHash}
          AND created_at >= ${since}
      `,
    );

    return Number(rows[0]?.count ?? 0n);
  }

  static async expireStale(): Promise<ApprovalRequest[]> {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`
        UPDATE approval_request
        SET status = 'EXPIRED', updated_at = NOW()
        WHERE status IN ('PENDING', 'APPROVED')
          AND expires_at <= NOW()
        RETURNING *
      `,
    );

    return rows.map((row) => this.mapSnakeToCamel(row));
  }

  static async recoverStaleExecuting(staleBefore: Date): Promise<ApprovalRequest[]> {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`
        UPDATE approval_request
        SET status = 'FAILED',
            execution_error = 'Stale EXECUTING approval recovered by sweeper timeout',
            updated_at = NOW()
        WHERE status = 'EXECUTING'
          AND updated_at <= ${staleBefore}
        RETURNING *
      `,
    );

    return rows.map((row) => this.mapSnakeToCamel(row));
  }

  static async forceExpire(id: string): Promise<void> {
    await prisma.$queryRaw(
      Prisma.sql`
        UPDATE approval_request
        SET status = 'EXPIRED', updated_at = NOW()
        WHERE id = ${id}
          AND status IN ('PENDING', 'APPROVED', 'EXECUTING')
      `,
    );
    logger.info({ approvalRequestId: id }, 'Force-expired approval request');
  }

  private static mapSnakeToCamel(row: Record<string, unknown>): ApprovalRequest {
    return {
      id: row.id as string,
      userId: (row.user_id ?? row.userId) as string,
      serverId: (row.server_id ?? row.serverId ?? null) as string | null,
      toolName: (row.tool_name ?? row.toolName) as string,
      canonicalArgs: (row.canonical_args ?? row.canonicalArgs) as Prisma.JsonValue,
      redactedArgs: (row.redacted_args ?? row.redactedArgs) as Prisma.JsonValue,
      policyVersion: (row.policy_version ?? row.policyVersion) as number,
      requestHash: (row.request_hash ?? row.requestHash) as string,
      status: row.status as string,
      expiresAt: new Date((row.expires_at ?? row.expiresAt) as string | number | Date),
      decidedAt:
        (row.decided_at ?? row.decidedAt)
          ? new Date((row.decided_at ?? row.decidedAt) as string | number | Date)
          : null,
      decisionReason: (row.decision_reason ?? row.decisionReason ?? null) as string | null,
      decidedByUserId: (row.decided_by_user_id ?? row.decidedByUserId ?? null) as string | null,
      decidedByRole: (row.decided_by_role ?? row.decidedByRole ?? null) as UserRole | null,
      decisionChannel: (row.decision_channel ?? row.decisionChannel ?? null) as string | null,
      executedAt:
        (row.executed_at ?? row.executedAt)
          ? new Date((row.executed_at ?? row.executedAt) as string | number | Date)
          : null,
      executionError: (row.execution_error ?? row.executionError ?? null) as string | null,
      executionResult: (row.execution_result ??
        row.executionResult ??
        null) as Prisma.JsonValue | null,
      uniformRequestId: (row.uniform_request_id ?? row.uniformRequestId ?? null) as string | null,
      createdAt: new Date((row.created_at ?? row.createdAt) as string | number | Date),
      updatedAt: new Date((row.updated_at ?? row.updatedAt) as string | number | Date),
    };
  }
}

export default ApprovalRepository;
