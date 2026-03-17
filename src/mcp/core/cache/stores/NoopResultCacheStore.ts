import type { ResultCacheStore } from './ResultCacheStore.js';

export class NoopResultCacheStore implements ResultCacheStore {
  async get(_entryKey: string): Promise<Buffer | null> {
    return null;
  }

  async set(_entryKey: string, _value: Buffer, _ttlSeconds: number): Promise<void> {
    return;
  }

  async delete(_entryKey: string): Promise<void> {
    return;
  }

  async recordAdmissionAttempt(_admissionKey: string, _windowSeconds: number): Promise<number> {
    return 0;
  }

  async getAdmissionCount(_admissionKey: string): Promise<number> {
    return 0;
  }

  async clearAdmission(_admissionKey: string): Promise<void> {
    return;
  }

  async getNamespaceVersion(_namespaceKey: string): Promise<number> {
    return 0;
  }

  async bumpNamespaceVersion(_namespaceKey: string): Promise<number> {
    return 0;
  }

  async healthcheck(): Promise<{ ok: boolean; details?: string }> {
    return { ok: true, details: 'noop store' };
  }

  async close(): Promise<void> {
    return;
  }
}
