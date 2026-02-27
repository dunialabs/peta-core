import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { Prisma } from '@prisma/client';
import { PolicyRepository } from '../../repositories/PolicyRepository.js';
import { createLogger } from '../../logger/index.js';

const logger = createLogger('PolicyHandler');

export class PolicyHandler {
  constructor() {}

  async handleCreatePolicySet(request: AdminRequest<{
    serverId?: string | null;
    dsl: unknown;
  }>): Promise<unknown> {
    const { serverId, dsl } = request.data || {};

    if (!dsl || typeof dsl !== 'object') {
      throw new AdminError('Missing or invalid field: dsl', AdminErrorCode.INVALID_REQUEST);
    }

    logger.info({ serverId }, 'Creating policy set');
    return PolicyRepository.create({ serverId: serverId ?? null, dsl });
  }

  async handleGetPolicySets(request: AdminRequest<{
    serverId?: string | null;
  }>): Promise<unknown> {
    const { serverId } = request.data || {};

    if (serverId !== undefined) {
      const policies = await PolicyRepository.findByServerId(serverId);
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
    return PolicyRepository.update(id, updateData);
  }

  async handleDeletePolicySet(request: AdminRequest<{
    id: string;
  }>): Promise<unknown> {
    const { id } = request.data || {};

    if (!id || typeof id !== 'string') {
      throw new AdminError('Missing required field: id', AdminErrorCode.INVALID_REQUEST);
    }

    logger.info({ id }, 'Deleting policy set');
    return PolicyRepository.delete(id);
  }

  async handleGetEffectivePolicy(request: AdminRequest<{
    serverId?: string | null;
  }>): Promise<unknown> {
    const { serverId } = request.data || {};

    const policies = await PolicyRepository.getEffectivePolicy(serverId ?? null);
    return { policySets: policies };
  }
}
