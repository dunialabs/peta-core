import { gunzipSync, gzipSync } from 'node:zlib';
import {
  AdmissionPolicy,
  CacheScope,
  type CacheEntryEnvelope,
  type CacheOperationType,
} from './types.js';

const GZIP_MAGIC_BYTE_0 = 0x1f;
const GZIP_MAGIC_BYTE_1 = 0x8b;

type EnvelopeCreateInput = {
  operation: CacheOperationType;
  serverId: string;
  entityId: string;
  scopeType: CacheScope;
  scopeHash: string;
  ttlSeconds: number;
  admissionPolicy: AdmissionPolicy;
  admittedAfterObservations: number;
  requestHash: string;
  payload: unknown;
  payloadBytes: number;
  payloadEncoding?: 'json' | 'gzip-json';
};

export class CacheSerializer {
  serialize(envelope: CacheEntryEnvelope, compress: boolean, compressionMinBytes: number): Buffer {
    const useCompression = compress && envelope.payloadBytes >= compressionMinBytes;
    const encoding: 'json' | 'gzip-json' = useCompression ? 'gzip-json' : 'json';
    const payload = { ...envelope, payloadEncoding: encoding };
    const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
    return useCompression ? gzipSync(jsonBuffer) : jsonBuffer;
  }

  deserialize(buffer: Buffer): CacheEntryEnvelope | null {
    if (!buffer || buffer.length === 0) {
      return null;
    }

    let payloadBuffer = buffer;
    const gzipped = this.isGzipBuffer(buffer);
    if (gzipped) {
      try {
        payloadBuffer = gunzipSync(buffer);
      } catch {
        return null;
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadBuffer.toString('utf8'));
    } catch {
      return null;
    }

    if (!this.isValidEnvelope(parsed)) {
      return null;
    }

    if (parsed.schemaVersion !== 1) {
      return null;
    }

    if (gzipped && parsed.payloadEncoding !== 'gzip-json') {
      parsed.payloadEncoding = 'gzip-json';
    }

    return parsed;
  }

  createEnvelope(input: EnvelopeCreateInput): CacheEntryEnvelope {
    return {
      schemaVersion: 1,
      operation: input.operation,
      serverId: input.serverId,
      entityId: input.entityId,
      scopeType: input.scopeType,
      scopeHash: input.scopeHash,
      createdAt: new Date().toISOString(),
      ttlSeconds: input.ttlSeconds,
      admissionPolicy: input.admissionPolicy,
      admittedAfterObservations: input.admittedAfterObservations,
      payloadEncoding: input.payloadEncoding ?? 'json',
      payloadBytes: input.payloadBytes,
      requestHash: input.requestHash,
      payload: input.payload,
    };
  }

  private isGzipBuffer(buffer: Buffer): boolean {
    return buffer.length >= 2 && buffer[0] === GZIP_MAGIC_BYTE_0 && buffer[1] === GZIP_MAGIC_BYTE_1;
  }

  private isValidEnvelope(value: unknown): value is CacheEntryEnvelope {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const entry = value as Record<string, unknown>;
    return (
      typeof entry.schemaVersion === 'number' &&
      (entry.operation === 'tool' ||
        entry.operation === 'resource' ||
        entry.operation === 'prompt') &&
      typeof entry.serverId === 'string' &&
      typeof entry.entityId === 'string' &&
      (entry.scopeType === CacheScope.User ||
        entry.scopeType === CacheScope.Tenant ||
        entry.scopeType === CacheScope.Global) &&
      typeof entry.scopeHash === 'string' &&
      typeof entry.createdAt === 'string' &&
      typeof entry.ttlSeconds === 'number' &&
      (entry.admissionPolicy === AdmissionPolicy.Immediate ||
        entry.admissionPolicy === AdmissionPolicy.SecondHit) &&
      typeof entry.admittedAfterObservations === 'number' &&
      (entry.payloadEncoding === 'json' || entry.payloadEncoding === 'gzip-json') &&
      typeof entry.payloadBytes === 'number' &&
      typeof entry.requestHash === 'string' &&
      'payload' in entry
    );
  }
}
