import type { ResultCacheStore } from './ResultCacheStore.js';

interface MemoryEntry {
  value: Buffer;
  expiresAt: number;
}

interface AdmissionEntry {
  count: number;
  expiresAt: number;
}

export class MemoryResultCacheStore implements ResultCacheStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly admissions = new Map<string, AdmissionEntry>();
  private readonly namespaces = new Map<string, number>();
  private readonly maxEntries: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxEntries: number = 1000, sweepIntervalMs: number = 60_000) {
    this.maxEntries = maxEntries;

    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
      this.sweepTimer.unref();
    }
  }

  async get(entryKey: string): Promise<Buffer | null> {
    const entry = this.entries.get(entryKey);
    if (!entry) {
      return null;
    }

    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(entryKey);
      return null;
    }

    return entry.value;
  }

  async set(entryKey: string, value: Buffer, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= this.maxEntries && !this.entries.has(entryKey)) {
      this.evictOldest();
    }

    this.entries.set(entryKey, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async delete(entryKey: string): Promise<void> {
    this.entries.delete(entryKey);
  }

  async recordAdmissionAttempt(admissionKey: string, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const existing = this.admissions.get(admissionKey);

    if (existing && now < existing.expiresAt) {
      existing.count += 1;
      return existing.count;
    }

    const entry: AdmissionEntry = {
      count: 1,
      expiresAt: now + windowSeconds * 1000,
    };
    this.admissions.set(admissionKey, entry);
    return 1;
  }

  async getAdmissionCount(admissionKey: string): Promise<number> {
    const existing = this.admissions.get(admissionKey);
    if (!existing || Date.now() >= existing.expiresAt) {
      return 0;
    }
    return existing.count;
  }

  async clearAdmission(admissionKey: string): Promise<void> {
    this.admissions.delete(admissionKey);
  }

  async getNamespaceVersion(namespaceKey: string): Promise<number> {
    return this.namespaces.get(namespaceKey) ?? 0;
  }

  async bumpNamespaceVersion(namespaceKey: string): Promise<number> {
    const current = this.namespaces.get(namespaceKey) ?? 0;
    const next = current + 1;
    this.namespaces.set(namespaceKey, next);
    return next;
  }

  async healthcheck(): Promise<{ ok: boolean; details?: string }> {
    return {
      ok: true,
      details: `memory store: ${this.entries.size}/${this.maxEntries} entries`,
    };
  }

  async close(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.entries.clear();
    this.admissions.clear();
    this.namespaces.clear();
  }

  private evictOldest(): void {
    const now = Date.now();

    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
      }
    }

    if (this.entries.size >= this.maxEntries) {
      let oldestKey: string | null = null;
      let oldestExpiry = Infinity;

      for (const [key, entry] of this.entries) {
        if (entry.expiresAt < oldestExpiry) {
          oldestExpiry = entry.expiresAt;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        this.entries.delete(oldestKey);
      }
    }
  }

  private sweep(): void {
    const now = Date.now();

    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
      }
    }

    for (const [key, entry] of this.admissions) {
      if (now >= entry.expiresAt) {
        this.admissions.delete(key);
      }
    }
  }
}
