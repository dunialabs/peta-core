import { AdminError, AdminErrorCode, AdminRequest } from '../../types/admin.types.js';
import { Prisma } from '@prisma/client';
import {
  DiscoveryGlobalConfig,
  DiscoveryMode,
  DiscoveryPreviewResult,
  DiscoveryProfileConfig,
  DiscoveryProfileCreateInput,
  DiscoveryProfileUpdateInput,
  evaluateExposureRules,
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
      config: data.config as Prisma.JsonValue | undefined,
      instructionText: data.instructionText,
    });

    if (data.isDefault) {
      await DiscoveryProfileRepository.setDefault(created.id);
      discoveryConfigService.invalidateCache();
      const refreshed = (await DiscoveryProfileRepository.findById(created.id)) ?? created;
      return refreshed;
    }

    discoveryConfigService.invalidateCache();
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

    if (data.name !== undefined && typeof data.name === 'string' && data.name.trim() === '') {
      throw new AdminError('Profile name cannot be blank', AdminErrorCode.INVALID_REQUEST);
    }

    const updated = await DiscoveryProfileRepository.update(data.id, {
      name: data.name !== undefined ? data.name.trim() : undefined,
      description: data.description,
      mode: data.mode,
      enabled: data.enabled,
      isDefault: data.isDefault,
      config: data.config as Prisma.JsonValue | undefined,
      instructionText: data.instructionText,
    });

    if (data.isDefault === true) {
      await DiscoveryProfileRepository.setDefault(data.id);
      discoveryConfigService.invalidateCache();
      const refreshed = (await DiscoveryProfileRepository.findById(data.id)) ?? updated;
      return refreshed;
    }

    discoveryConfigService.invalidateCache();
    return updated;
  }

  async handleDeleteProfile(request: AdminRequest<{ id: string }>): Promise<unknown> {
    const id = request.data?.id;
    if (!id || typeof id !== 'string') {
      throw new AdminError('Missing required field: id', AdminErrorCode.INVALID_REQUEST);
    }

    const existing = await DiscoveryProfileRepository.findById(id);
    if (!existing) {
      throw new AdminError(`Discovery profile not found: ${id}`, AdminErrorCode.INVALID_REQUEST);
    }

    const deleted = await DiscoveryProfileRepository.delete(id);
    discoveryConfigService.invalidateCache();
    return deleted;
  }

  /**
   * Preview uses catalog rows as a discovery index snapshot.
   * It is not runtime source-of-truth for executable tool routing.
   */
  async handlePreviewDiscovery(request: AdminRequest<{ profileId?: string }>): Promise<unknown> {
    const profileId = request.data?.profileId;

    const profile =
      profileId && typeof profileId === 'string'
        ? await DiscoveryProfileRepository.findById(profileId)
        : await DiscoveryProfileRepository.findDefault();
    if (profileId && typeof profileId === 'string' && !profile) {
      throw new AdminError(
        `Discovery profile not found: ${profileId}`,
        AdminErrorCode.INVALID_REQUEST,
      );
    }
    if (!profile) {
      const allActions = await CatalogActionRepository.search({
        query: '',
        limit: 5000,
        offset: 0,
      });
      const flatDirect = allActions.map((a) => ({
        // Preview name is the catalog reference name (wireName) when available.
        name: a.wireName ?? a.displayName,
        serverId: a.serverId,
      }));
      return {
        mode: DiscoveryMode.FLAT,
        directTools: flatDirect,
        hiddenTools: [],
        catalogToolsIncluded: [],
        totalDirectCount: flatDirect.length,
        totalHiddenCount: 0,
      } satisfies DiscoveryPreviewResult;
    }

    const config = profile.config as DiscoveryProfileConfig | null;
    const exposureRules = config?.directExposureRules;
    const mode = isDiscoveryMode(profile.mode) ? profile.mode : DiscoveryMode.FLAT;

    const allActions = await CatalogActionRepository.search({
      query: '',
      limit: 5000,
      offset: 0,
    });

    let directTools: Array<{ name: string; serverId: string }> = [];
    let hiddenTools: Array<{ actionId: string; displayName: string; serverId: string }> = [];

    if (mode === DiscoveryMode.FLAT) {
      directTools = allActions.map((action) => ({
        name: action.wireName ?? action.displayName,
        serverId: action.serverId,
      }));
    } else if (mode === DiscoveryMode.STRICT) {
      hiddenTools = allActions.map((action) => ({
        actionId: action.actionId,
        displayName: action.displayName,
        serverId: action.serverId,
      }));
    } else {
      for (const action of allActions) {
        const isDirect = evaluateExposureRules(
          exposureRules,
          {
            serverId: action.serverId,
            riskLevel: action.riskLevel,
          },
          false,
        );
        if (isDirect) {
          directTools.push({
            name: action.wireName ?? action.displayName,
            serverId: action.serverId,
          });
        } else {
          hiddenTools.push({
            actionId: action.actionId,
            displayName: action.displayName,
            serverId: action.serverId,
          });
        }
      }
    }

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
