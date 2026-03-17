import { createLogger } from '../../../../logger/index.js';
import { CacheNamespaceVersionRepository } from '../../../../repositories/CacheNamespaceVersionRepository.js';
import { ResultCacheAdmissionRepository } from '../../../../repositories/ResultCacheAdmissionRepository.js';
import { ResultCacheRepository } from '../../../../repositories/ResultCacheRepository.js';
import { CacheSerializer } from '../CacheSerializer.js';
import type { ResultCacheStore } from './ResultCacheStore.js';

export class DbResultCacheStore implements ResultCacheStore {
  private readonly logger = createLogger('DbResultCacheStore');
  private readonly serializer = new CacheSerializer();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  async get(entryKey: string): Promise<Buffer | null> {
    const row = await ResultCacheRepository.getEntry(entryKey);
    if (!row) {
      return null;
    }
    return row.payload_blob;
  }

  async set(entryKey: string, value: Buffer, ttlSeconds: number): Promise<void> {
    const envelope = this.serializer.deserialize(value);
    if (!envelope) {
      throw new Error('Failed to deserialize cache entry payload before DB write');
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await ResultCacheRepository.upsertEntry(
      entryKey,
      envelope.operation,
      envelope.serverId,
      envelope.entityId,
      envelope.scopeType,
      envelope.scopeHash,
      envelope.requestHash,
      envelope.payloadEncoding,
      envelope.payloadBytes,
      value,
      expiresAt,
    );
  }

  async delete(entryKey: string): Promise<void> {
    await ResultCacheRepository.deleteEntry(entryKey);
  }

  async recordAdmissionAttempt(admissionKey: string, windowSeconds: number): Promise<number> {
    return ResultCacheAdmissionRepository.recordAttempt(admissionKey, windowSeconds);
  }

  async getAdmissionCount(admissionKey: string): Promise<number> {
    return ResultCacheAdmissionRepository.getCount(admissionKey);
  }

  async clearAdmission(admissionKey: string): Promise<void> {
    await ResultCacheAdmissionRepository.clearAdmission(admissionKey);
  }

  async getNamespaceVersion(namespaceKey: string): Promise<number> {
    return CacheNamespaceVersionRepository.getVersion(namespaceKey);
  }

  async bumpNamespaceVersion(namespaceKey: string): Promise<number> {
    return CacheNamespaceVersionRepository.bumpVersion(namespaceKey);
  }

  startSweeper(intervalSeconds: number, batchSize: number): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    if (intervalSeconds <= 0) {
      return;
    }

    this.sweepTimer = setInterval(() => {
      void this.runSweep(batchSize);
    }, intervalSeconds * 1000);
    this.sweepTimer.unref();
  }

  stopSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async healthcheck(): Promise<{ ok: boolean; details?: string }> {
    try {
      await CacheNamespaceVersionRepository.getVersion('__healthcheck__');
      return { ok: true, details: 'db store ok' };
    } catch (error) {
      this.logger.warn({ error }, 'DB cache healthcheck failed');
      return { ok: false, details: 'db store unavailable' };
    }
  }

  async close(): Promise<void> {
    this.stopSweeper();
  }

  private async runSweep(batchSize: number): Promise<void> {
    try {
      const [entriesDeleted, admissionsDeleted] = await Promise.all([
        ResultCacheRepository.cleanupExpired(batchSize),
        ResultCacheAdmissionRepository.cleanupExpired(batchSize),
      ]);

      if (entriesDeleted > 0 || admissionsDeleted > 0) {
        this.logger.debug({ entriesDeleted, admissionsDeleted }, 'Result cache DB sweep completed');
      }
    } catch (error) {
      this.logger.warn({ error }, 'Result cache DB sweep failed');
    }
  }
}
