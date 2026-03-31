import { prisma } from '../config/prisma.js';

type ResultCacheEntryRow = {
  payload_blob: Buffer | Uint8Array;
  payload_encoding: string;
  expires_at: Date;
};

type CountRow = {
  count: number;
};

export class ResultCacheRepository {
  static async getEntry(cacheKey: string): Promise<ResultCacheEntryRow | null> {
    const query = `
      SELECT payload_blob, payload_encoding, expires_at
      FROM result_cache_entries
      WHERE cache_key = $1
        AND expires_at > NOW()
      LIMIT 1
    `;

    const rows = await prisma.$queryRawUnsafe<ResultCacheEntryRow[]>(query, cacheKey);
    return rows[0] ?? null;
  }

  static async upsertEntry(
    cacheKey: string,
    operationType: string,
    serverId: string,
    entityId: string,
    scopeType: string,
    scopeHash: string,
    requestHash: string,
    payloadEncoding: string,
    payloadBytes: number,
    payloadBlob: Buffer,
    expiresAt: Date,
  ): Promise<void> {
    const query = `
      INSERT INTO result_cache_entries (
        cache_key,
        operation_type,
        server_id,
        entity_id,
        scope_type,
        scope_hash,
        request_hash,
        payload_encoding,
        payload_bytes,
        payload_blob,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (cache_key) DO UPDATE
      SET operation_type = EXCLUDED.operation_type,
          server_id = EXCLUDED.server_id,
          entity_id = EXCLUDED.entity_id,
          scope_type = EXCLUDED.scope_type,
          scope_hash = EXCLUDED.scope_hash,
          request_hash = EXCLUDED.request_hash,
          payload_encoding = EXCLUDED.payload_encoding,
          payload_bytes = EXCLUDED.payload_bytes,
          payload_blob = EXCLUDED.payload_blob,
          created_at = NOW(),
          expires_at = EXCLUDED.expires_at
    `;

    await prisma.$executeRawUnsafe(
      query,
      cacheKey,
      operationType,
      serverId,
      entityId,
      scopeType,
      scopeHash,
      requestHash,
      payloadEncoding,
      payloadBytes,
      payloadBlob,
      expiresAt,
    );
  }

  static async deleteEntry(cacheKey: string): Promise<void> {
    const query = `DELETE FROM result_cache_entries WHERE cache_key = $1`;
    await prisma.$executeRawUnsafe(query, cacheKey);
  }

  static async cleanupExpired(batchSize: number): Promise<number> {
    const query = `
      WITH deleted AS (
        DELETE FROM result_cache_entries
        WHERE ctid IN (
          SELECT ctid
          FROM result_cache_entries
          WHERE expires_at < NOW()
          ORDER BY expires_at ASC
          LIMIT $1
        )
        RETURNING cache_key
      )
      SELECT COUNT(*)::int AS count FROM deleted
    `;

    const rows = await prisma.$queryRawUnsafe<CountRow[]>(query, batchSize);
    return rows[0]?.count ?? 0;
  }
}
