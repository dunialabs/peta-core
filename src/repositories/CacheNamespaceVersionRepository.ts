import { prisma } from '../config/prisma.js';

type NamespaceVersionRow = {
  version: number;
};

export class CacheNamespaceVersionRepository {
  static async getVersion(namespaceKey: string): Promise<number> {
    const query = `
      SELECT version
      FROM result_cache_namespace_versions
      WHERE namespace_key = $1
      LIMIT 1
    `;

    const rows = await prisma.$queryRawUnsafe<NamespaceVersionRow[]>(query, namespaceKey);
    return rows[0]?.version ?? 0;
  }

  static async bumpVersion(namespaceKey: string): Promise<number> {
    const query = `
      INSERT INTO result_cache_namespace_versions (namespace_key, version, updated_at)
      VALUES ($1, 1, NOW())
      ON CONFLICT (namespace_key) DO UPDATE
      SET version = result_cache_namespace_versions.version + 1,
          updated_at = NOW()
      RETURNING version
    `;

    const rows = await prisma.$queryRawUnsafe<NamespaceVersionRow[]>(query, namespaceKey);
    return rows[0]?.version ?? 0;
  }
}
