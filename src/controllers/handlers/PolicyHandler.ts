import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { Prisma } from '@prisma/client';
import { PolicyRepository } from '../../repositories/PolicyRepository.js';
import { createLogger } from '../../logger/index.js';
import { policyEngine } from '../../mcp/services/PolicyEngine.js';

const logger = createLogger('PolicyHandler');

export class PolicyHandler {
  constructor() {}

  async handleCreatePolicySet(request: AdminRequest<{
    serverId?: string | null;
    dsl: unknown;
  }>): Promise<unknown> {
    const { serverId, dsl } = request.data || {};
    const normalizedServerId = typeof serverId === 'string' && serverId.trim() === '' ? null : (serverId ?? null);

    if (!dsl || typeof dsl !== 'object') {
      throw new AdminError('Missing or invalid field: dsl', AdminErrorCode.INVALID_REQUEST);
    }

    logger.info({ serverId: normalizedServerId }, 'Creating policy set');
    const result = await PolicyRepository.create({ serverId: normalizedServerId, dsl });
    policyEngine.clearCache(normalizedServerId);
    return result;
  }

  async handleGetPolicySets(request: AdminRequest<{
    id?: string;
    serverId?: string | null;
  }>): Promise<unknown> {
    const { id, serverId } = request.data || {};

    if (id !== undefined) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new AdminError('Missing required field: id', AdminErrorCode.INVALID_REQUEST);
      }
      const policy = await PolicyRepository.findById(id.trim());
      if (!policy) {
        throw new AdminError(`Policy set not found: ${id}`, AdminErrorCode.INVALID_REQUEST);
      }
      return { policySets: [policy] };
    }

    const normalizedServerId = typeof serverId === 'string' && serverId.trim() === '' ? null : serverId;

    if (normalizedServerId !== undefined) {
      const policies = await PolicyRepository.findByServerId(normalizedServerId);
      return { policySets: policies };
    }

    const policySets = await PolicyRepository.findAll();
    return { policySets };
  }

  async handleUpdatePolicySet(request: AdminRequest<{
    id: string;
    dsl?: unknown;
    status?: string;
  }>): Promise<unknown> {
    const { id, dsl, status } = request.data || {};

    if (!id || typeof id !== 'string') {
      throw new AdminError('Missing required field: id', AdminErrorCode.INVALID_REQUEST);
    }

    const existing = await PolicyRepository.findById(id);
    if (!existing) {
      throw new AdminError(`Policy set not found: ${id}`, AdminErrorCode.INVALID_REQUEST);
    }

    const updateData: { dsl?: Prisma.JsonValue; status?: string } = {};
    if (dsl !== undefined) updateData.dsl = dsl;
    if (status !== undefined) updateData.status = status;

    logger.info({ id, hasNewDsl: !!dsl, status }, 'Updating policy set');
    const result = await PolicyRepository.update(id, updateData, existing.serverId);
    policyEngine.clearCache(existing.serverId);
    return result;
  }
  async handleDeletePolicySet(request: AdminRequest<{
    id: string;
  }>): Promise<unknown> {
    const { id } = request.data || {};

    if (!id || typeof id !== 'string') {
      throw new AdminError('Missing required field: id', AdminErrorCode.INVALID_REQUEST);
    }

    logger.info({ id }, 'Deleting policy set');
    const existing2 = await PolicyRepository.findById(id);
    const result = await PolicyRepository.delete(id);
    policyEngine.clearCache(existing2?.serverId);
    return result;
  }
  async handleGetEffectivePolicy(request: AdminRequest<{
    serverId?: string | null;
  }>): Promise<unknown> {
    const { serverId } = request.data || {};
    const normalizedServerId = typeof serverId === 'string' && serverId.trim() === '' ? null : (serverId ?? null);

    const policies = await PolicyRepository.getEffectivePolicy(normalizedServerId);
    return { policySets: policies };
  }
}
