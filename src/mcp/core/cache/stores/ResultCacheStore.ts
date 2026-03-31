export interface ResultCacheStore {
  get(entryKey: string): Promise<Buffer | null>;
  set(entryKey: string, value: Buffer, ttlSeconds: number): Promise<void>;
  delete(entryKey: string): Promise<void>;
  recordAdmissionAttempt(admissionKey: string, windowSeconds: number): Promise<number>;
  getAdmissionCount(admissionKey: string): Promise<number>;
  clearAdmission(admissionKey: string): Promise<void>;
  getNamespaceVersion(namespaceKey: string): Promise<number>;
  bumpNamespaceVersion(namespaceKey: string): Promise<number>;
  healthcheck(): Promise<{ ok: boolean; details?: string }>;
  close?(): Promise<void>;
}
