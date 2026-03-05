import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { approvalService } from '../../mcp/services/ApprovalService.js';
import { socketNotifier } from '../../socket/SocketNotifier.js';
import { createLogger } from '../../logger/index.js';

const logger = createLogger('ApprovalHandler');

export class ApprovalHandler {
  constructor() {}

  async handleListApprovalRequests(
    request: AdminRequest<{
      userId?: string;
      serverId?: string;
      toolName?: string;
    }>,
  ): Promise<unknown> {
    const { userId, serverId, toolName } = request.data || {};

    const requests = await approvalService.listPending(
      userId && typeof userId === 'string' ? userId : null,
      { serverId, toolName },
    );
    return {
      requests: requests.map((item) => ({
        ...item,
        resumeToken: item.id,
        executionResultAvailable: item.executionResult != null,
      })),
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
      resumeToken: approvalRequest.id,
      executionResultAvailable: approvalRequest.executionResult != null,
    };
  }

  async handleDecideApprovalRequest(
    request: AdminRequest<{
      id: string;
      decision: 'APPROVED' | 'REJECTED';
      reason?: string;
    }>,
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

    const result = await approvalService.decide(id, decision, reason);
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

    logger.info({ id, decision }, 'Approval request decided via admin API');
    return {
      ...result,
      resumeToken: result.id,
      executionResultAvailable: result.executionResult != null,
    };
  }

  async handleGetPendingApprovalsCount(
    request: AdminRequest<{
      userId: string;
    }>,
  ): Promise<unknown> {
    const { userId } = request.data || {};

    if (!userId || typeof userId !== 'string') {
      throw new AdminError('Missing required field: userId', AdminErrorCode.INVALID_REQUEST);
    }

    const count = await approvalService.countPending(userId);
    return { count };
  }
}
