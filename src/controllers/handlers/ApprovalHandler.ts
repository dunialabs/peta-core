import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { approvalService } from '../../mcp/services/ApprovalService.js';
import { socketNotifier } from '../../socket/SocketNotifier.js';
import { createLogger } from '../../logger/index.js';
import type { AuthContext } from '../../types/auth.types.js';
import { ApprovalStatus } from '../../types/enums.js';

const logger = createLogger('ApprovalHandler');
const VALID_APPROVAL_STATUSES = new Set<string>(Object.values(ApprovalStatus));

function serializeApprovalRequest(item: {
  id: string;
  executionResult?: unknown;
}): { resumeToken: string; executionResultAvailable: boolean } {
  return {
    resumeToken: item.id,
    executionResultAvailable: item.executionResult != null,
  };
}

export class ApprovalHandler {
  constructor() {}

  async handleListApprovalRequests(
    request: AdminRequest<{
      userId?: string;
      serverId?: string;
      toolName?: string;
      status?: string;
      page?: number;
      pageSize?: number;
    }>,
  ): Promise<unknown> {
    const { userId, serverId, toolName, status, page, pageSize } = request.data || {};

    if (status && !VALID_APPROVAL_STATUSES.has(status)) {
      throw new AdminError(`Invalid status filter: ${status}`, AdminErrorCode.INVALID_REQUEST);
    }

    const result = await approvalService.listApprovals({
      userId: userId && typeof userId === 'string' ? userId : null,
      status,
      page: typeof page === 'number' ? page : undefined,
      pageSize: typeof pageSize === 'number' ? pageSize : undefined,
      filters: { serverId, toolName },
    });

    return {
      requests: result.requests.map((item) => ({
        ...item,
        ...serializeApprovalRequest(item),
      })),
      page: result.page,
      pageSize: result.pageSize,
      hasMore: result.hasMore,
    };
  }

  async handleGetApprovalRequest(
    request: AdminRequest<{
      id: string;
    }>,
  ): Promise<unknown> {
    const { id } = request.data || {};

    if (!id || typeof id !== 'string') {
      throw new AdminError('Missing required field: id', AdminErrorCode.INVALID_REQUEST);
    }

    const approvalRequest = await approvalService.getById(id);
    if (!approvalRequest) {
      throw new AdminError(`Approval request not found: ${id}`, AdminErrorCode.INVALID_REQUEST);
    }

    return {
      ...approvalRequest,
      ...serializeApprovalRequest(approvalRequest),
    };
  }

  async handleDecideApprovalRequest(
    request: AdminRequest<{
      id: string;
      decision: 'APPROVED' | 'REJECTED';
      reason?: string;
    }>,
    authContext?: AuthContext,
  ): Promise<unknown> {
    const { id, decision, reason } = request.data || {};

    if (!id || typeof id !== 'string') {
      throw new AdminError('Missing required field: id', AdminErrorCode.INVALID_REQUEST);
    }

    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      throw new AdminError(
        'Invalid decision: must be APPROVED or REJECTED',
        AdminErrorCode.INVALID_REQUEST,
      );
    }

    const result = await approvalService.decide(
      id,
      decision,
      {
        actorUserId: authContext?.userId ?? null,
        actorRole: authContext?.role ?? null,
        channel: 'admin_api',
      },
      reason,
    );
    if (!result) {
      throw new AdminError(
        'Decision failed: request not found, not PENDING, or expired',
        AdminErrorCode.INVALID_REQUEST,
      );
    }

    socketNotifier.notifyApprovalDecided(result.userId, {
      id: result.id,
      toolName: result.toolName,
      decision: result.status,
      reason: result.decisionReason,
    });

    logger.info(
      { id, decision, actorUserId: authContext?.userId ?? null },
      'Approval request decided via admin API',
    );
    return {
      ...result,
      ...serializeApprovalRequest(result),
    };
  }

  async handleGetPendingApprovalsCount(
    request: AdminRequest<{
      userId?: string;
    }>,
  ): Promise<unknown> {
    const { userId } = request.data || {};

    if (userId !== undefined && userId !== null && typeof userId !== 'string') {
      throw new AdminError('Invalid field: userId must be a string', AdminErrorCode.INVALID_REQUEST);
    }

    const normalizedUserId =
      typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;

    const count = await approvalService.countPending(normalizedUserId);
    return { count };
  }
}
