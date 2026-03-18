import { createLogger } from '../../logger/index.js';
import { DiscoveryProfileRepository } from '../../repositories/DiscoveryProfileRepository.js';
import { DiscoveryGlobalConfig, DiscoveryMode } from '../../types/discovery.types.js';

type DiscoveryProfileLike = Awaited<ReturnType<typeof DiscoveryProfileRepository.findDefault>>;

export class DiscoveryConfigService {
  private static instance: DiscoveryConfigService;
  private readonly logger = createLogger('DiscoveryConfigService');
  private enabled = false;

  private constructor() {}

  static getInstance(): DiscoveryConfigService {
    if (!DiscoveryConfigService.instance) {
      DiscoveryConfigService.instance = new DiscoveryConfigService();
    }
    return DiscoveryConfigService.instance;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async getActiveProfile(userId?: string): Promise<DiscoveryProfileLike> {
    void userId;
    const profile = await DiscoveryProfileRepository.findDefault();
    this.enabled = Boolean(profile?.enabled);
    return profile;
  }

  async getMode(): Promise<DiscoveryMode> {
    const profile = await this.getActiveProfile();
    if (!profile || !profile.enabled) {
      return DiscoveryMode.FLAT;
    }

    if (profile.mode === DiscoveryMode.HYBRID) {
      return DiscoveryMode.HYBRID;
    }
    if (profile.mode === DiscoveryMode.STRICT) {
      return DiscoveryMode.STRICT;
    }
    return DiscoveryMode.FLAT;
  }

  async setGlobalConfig(
    config: DiscoveryGlobalConfig,
  ): Promise<{ enabled: boolean; defaultProfileId: string | null }> {
    if (config.defaultProfileId) {
      await DiscoveryProfileRepository.setDefault(config.defaultProfileId);
    }

    const activeProfile = await DiscoveryProfileRepository.findDefault();

    if (activeProfile) {
      await DiscoveryProfileRepository.update(activeProfile.id, {
        enabled: config.enabled,
      });
    }

    this.enabled = config.enabled;
    this.logger.info(
      {
        enabled: config.enabled,
        defaultProfileId: config.defaultProfileId ?? activeProfile?.id ?? null,
      },
      'Updated discovery global configuration',
    );

    const refreshed = await DiscoveryProfileRepository.findDefault();
    this.enabled = Boolean(refreshed?.enabled);

    return {
      enabled: this.enabled,
      defaultProfileId: refreshed?.id ?? null,
    };
  }
}

export const discoveryConfigService = DiscoveryConfigService.getInstance();
