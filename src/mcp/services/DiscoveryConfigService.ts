import { createLogger } from '../../logger/index.js';
import { DiscoveryProfileRepository } from '../../repositories/DiscoveryProfileRepository.js';
import { DiscoveryGlobalConfig, DiscoveryMode } from '../../types/discovery.types.js';

type DiscoveryProfileLike = Awaited<ReturnType<typeof DiscoveryProfileRepository.findDefault>>;

export class DiscoveryConfigService {
  private static instance: DiscoveryConfigService;
  private readonly logger = createLogger('DiscoveryConfigService');
  private enabled = false;
  private cachedProfile: DiscoveryProfileLike = null;
  private cacheExpiry = 0;
  private static readonly CACHE_TTL_MS = 10_000;

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

    const now = Date.now();
    if (this.cachedProfile !== undefined && now < this.cacheExpiry) {
      this.enabled = Boolean(this.cachedProfile?.enabled);
      return this.cachedProfile;
    }

    const profile = await DiscoveryProfileRepository.findDefault();
    this.cachedProfile = profile;
    this.cacheExpiry = now + DiscoveryConfigService.CACHE_TTL_MS;
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

    this.invalidateCache();

    const refreshed = await DiscoveryProfileRepository.findDefault();
    this.enabled = Boolean(refreshed?.enabled);

    return {
      enabled: this.enabled,
      defaultProfileId: refreshed?.id ?? null,
    };
  }

  invalidateCache(): void {
    this.cacheExpiry = 0;
  }
}

export const discoveryConfigService = DiscoveryConfigService.getInstance();
