import { prisma } from '../config/prisma.js';

type AdmissionCountRow = {
  observation_count: number;
};

type CountRow = {
  count: number;
};

export class ResultCacheAdmissionRepository {
  static async recordAttempt(admissionKey: string, windowSeconds: number): Promise<number> {
    const query = `
      INSERT INTO result_cache_admission_counters (
        admission_key,
        observation_count,
        created_at,
        updated_at,
        expires_at
      )
      VALUES ($1, 1, NOW(), NOW(), NOW() + ($2 * INTERVAL '1 second'))
      ON CONFLICT (admission_key) DO UPDATE
      SET observation_count = CASE
            WHEN result_cache_admission_counters.expires_at < NOW() THEN 1
            ELSE result_cache_admission_counters.observation_count + 1
          END,
          updated_at = NOW(),
          expires_at = NOW() + ($2 * INTERVAL '1 second')
      RETURNING observation_count
    `;

    const rows = await prisma.$queryRawUnsafe<AdmissionCountRow[]>(
      query,
      admissionKey,
      windowSeconds,
    );
    return rows[0]?.observation_count ?? 0;
  }

  static async getCount(admissionKey: string): Promise<number> {
    const query = `
      SELECT observation_count
      FROM result_cache_admission_counters
      WHERE admission_key = $1
        AND expires_at > NOW()
      LIMIT 1
    `;

    const rows = await prisma.$queryRawUnsafe<AdmissionCountRow[]>(query, admissionKey);
    return rows[0]?.observation_count ?? 0;
  }

  static async clearAdmission(admissionKey: string): Promise<void> {
    const query = `DELETE FROM result_cache_admission_counters WHERE admission_key = $1`;
    await prisma.$executeRawUnsafe(query, admissionKey);
  }

  static async cleanupExpired(batchSize: number): Promise<number> {
    const query = `
      WITH deleted AS (
        DELETE FROM result_cache_admission_counters
        WHERE ctid IN (
          SELECT ctid
          FROM result_cache_admission_counters
          WHERE expires_at < NOW()
          ORDER BY expires_at ASC
          LIMIT $1
        )
        RETURNING admission_key
      )
      SELECT COUNT(*)::int AS count FROM deleted
    `;

    const rows = await prisma.$queryRawUnsafe<CountRow[]>(query, batchSize);
    return rows[0]?.count ?? 0;
  }
}
