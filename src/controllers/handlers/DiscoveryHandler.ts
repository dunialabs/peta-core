import { AdminError, AdminErrorCode, AdminRequest } from '../../types/admin.types.js';
import { Prisma } from '@prisma/client';
import {
  DiscoveryGlobalConfig,
  DiscoveryMode,
  DiscoveryPreviewResult,
  DiscoveryProfileCreateInput,
  DiscoveryProfileUpdateInput,
} from '../../types/discovery.types.js';
import { createLogger } from '../../logger/index.js';
import { DiscoveryProfileRepository } from '../../repositories/DiscoveryProfileRepository.js';
import { CatalogActionRepository } from '../../repositories/CatalogActionRepository.js';
import { discoveryConfigService } from '../../mcp/services/DiscoveryConfigService.js';
import { discoveryIndexBuilder } from '../../mcp/services/DiscoveryIndexBuilder.js';

const logger = createLogger('DiscoveryHandler');

export class DiscoveryHandler {
  constructor() {}

  async handleGetConfig(): Promise<unknown> {
    const profile = await DiscoveryProfileRepository.findDefault();
    return {
      enabled: profile?.enabled ?? discoveryConfigService.isEnabled(),
      defaultProfileId: profile?.id ?? null,
      mode: profile?.mode ?? DiscoveryMode.FLAT,
    };
  }

  async handleSetConfig(request: AdminRequest<DiscoveryGlobalConfig>): Promise<unknown> {
    const config = request.data;
    if (!config || typeof config.enabled !== 'boolean') {
      throw new AdminError('Missing required field: enabled', AdminErrorCode.INVALID_REQUEST);
    }

    if (config.defaultProfileId !== undefined && config.defaultProfileId !== null) {
      const profile = await DiscoveryProfileRepository.findById(config.defaultProfileId);
      if (!profile) {
        throw new AdminError(
          `Discovery profile not found: ${config.defaultProfileId}`,
          AdminErrorCode.INVALID_REQUEST,
        );
      }
    }

    return await discoveryConfigService.setGlobalConfig(config);
  }

  async handleCreateProfile(request: AdminRequest<DiscoveryProfileCreateInput>): Promise<unknown> {
    const data = request.data;
    if (!data || typeof data.name !== 'string' || data.name.trim() === '') {
      throw new AdminError('Missing required field: name', AdminErrorCode.INVALID_REQUEST);
    }
    if (!isDiscoveryMode(data.mode)) {
      throw new AdminError('Invalid field: mode', AdminErrorCode.INVALID_REQUEST);
    }

    const created = await DiscoveryProfileRepository.create({
      name: data.name.trim(),
      description: data.description,
      mode: data.mode,
      enabled: data.enabled,
      isDefault: data.isDefault,
      publicVisible: data.publicVisible,
      anonymousVisible: data.anonymousVisible,
      config: data.config as Prisma.JsonValue | undefined,
      instructionText: data.instructionText,
    });

    if (data.isDefault) {
      await DiscoveryProfileRepository.setDefault(created.id);
      return (await DiscoveryProfileRepository.findById(created.id)) ?? created;
    }

    return created;
  }

  async handleGetProfiles(): Promise<unknown> {
    const profiles = await DiscoveryProfileRepository.findAll();
    return { profiles };
  }

  async handleGetProfile(request: AdminRequest<{ id: string }>): Promise<unknown> {
    const id = request.data?.id;
    if (!id || typeof id !== 'string') {
      throw new AdminError('Missing required field: id', AdminErrorCode.INVALID_REQUEST);
    }

    const profile = await DiscoveryProfileRepository.findById(id);
    if (!profile) {
      throw new AdminError(`Discovery profile not found: ${id}`, AdminErrorCode.INVALID_REQUEST);
    }

    return profile;
  }

  async handleUpdateProfile(request: AdminRequest<DiscoveryProfileUpdateInput>): Promise<unknown> {
    const data = request.data;
    if (!data || typeof data.id !== 'string' || data.id.trim() === '') {
      throw new AdminError('Missing required field: id', AdminErrorCode.INVALID_REQUEST);
    }

    const existing = await DiscoveryProfileRepository.findById(data.id);
    if (!existing) {
      throw new AdminError(
        `Discovery profile not found: ${data.id}`,
        AdminErrorCode.INVALID_REQUEST,
      );
    }

    if (data.mode !== undefined && !isDiscoveryMode(data.mode)) {
      throw new AdminError('Invalid field: mode', AdminErrorCode.INVALID_REQUEST);
    }

    const updated = await DiscoveryProfileRepository.update(data.id, {
      name: data.name,
      description: data.description,
      mode: data.mode,
      enabled: data.enabled,
      isDefault: data.isDefault,
      publicVisible: data.publicVisible,
      anonymousVisible: data.anonymousVisible,
      config: data.config as Prisma.JsonValue | undefined,
      instructionText: data.instructionText,
    });

    if (data.isDefault === true) {
      await DiscoveryProfileRepository.setDefault(data.id);
      return (await DiscoveryProfileRepository.findById(data.id)) ?? updated;
    }

    return updated;
  }

  async handleDeleteProfile(request: AdminRequest<{ id: string }>): Promise<unknown> {
    const id = request.data?.id;
    if (!id || typeof id !== 'string') {
      throw new AdminError('Missing required field: id', AdminErrorCode.INVALID_REQUEST);
    }

    return await DiscoveryProfileRepository.delete(id);
  }

  async handlePreviewDiscovery(request: AdminRequest<{ profileId?: string }>): Promise<unknown> {
    const profileId = request.data?.profileId;

    let profile;
    if (profileId && typeof profileId === 'string') {
      profile = await DiscoveryProfileRepository.findById(profileId);
      if (!profile) {
        throw new AdminError(
          `Discovery profile not found: ${profileId}`,
          AdminErrorCode.INVALID_REQUEST,
        );
      }
    } else {
      profile = await DiscoveryProfileRepository.findDefault();
      if (!profile) {
        // No profile at all — return empty flat preview
        return {
          mode: DiscoveryMode.FLAT,
          directTools: [],
          hiddenTools: [],
          catalogToolsIncluded: [],
          totalDirectCount: 0,
          totalHiddenCount: 0,
        } satisfies DiscoveryPreviewResult;
      }
    }

    const actions = await CatalogActionRepository.search({
      query: '',
      limit: 1000,
      offset: 0,
    });

    const mode = isDiscoveryMode(profile.mode) ? profile.mode : DiscoveryMode.FLAT;
    const directTools =
      mode === DiscoveryMode.STRICT
        ? []
        : actions.map((action) => ({
            name: action.wireName ?? action.displayName,
            serverId: action.serverId,
          }));
    const hiddenTools =
      mode === DiscoveryMode.STRICT
        ? actions.map((action) => ({
            actionId: action.actionId,
            displayName: action.displayName,
            serverId: action.serverId,
          }))
        : [];

    const result: DiscoveryPreviewResult = {
      mode,
      directTools,
      hiddenTools,
      catalogToolsIncluded:
        mode === DiscoveryMode.FLAT
          ? []
          : ['peta.catalog.search', 'peta.catalog.describe', 'peta.catalog.execute'],
      totalDirectCount: directTools.length,
      totalHiddenCount: hiddenTools.length,
    };

    return result;
  }

  async handleReindexCatalog(): Promise<unknown> {
    logger.info('Triggering discovery catalog full reindex');
    return await discoveryIndexBuilder.buildFullIndex();
  }

  async handleGetCatalogStats(): Promise<unknown> {
    const stats = await CatalogActionRepository.getStats();
    return {
      totalActions: stats.total,
      serversIndexed: stats.serverCount ?? 0,
      lastIndexedAt: stats.lastIndexedAt,
    };
  }
}

function isDiscoveryMode(value: unknown): value is DiscoveryMode {
  return (
    value === DiscoveryMode.FLAT || value === DiscoveryMode.HYBRID || value === DiscoveryMode.STRICT
  );
}
