CREATE TABLE IF NOT EXISTS "discovery_profile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mode" VARCHAR(20) NOT NULL DEFAULT 'FLAT',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "instruction_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovery_profile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "catalog_action" (
    "id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "server_id" VARCHAR(128) NOT NULL,
    "original_name" TEXT NOT NULL,
    "wire_name" TEXT,
    "display_name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT,
    "risk_level" VARCHAR(20),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "input_schema" JSONB NOT NULL,
    "output_schema" JSONB,
    "annotations" JSONB,
    "examples" JSONB,
    "schema_hash" TEXT NOT NULL,
    "search_text" TEXT,
    "last_indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_action_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "catalog_action_profile" (
    "id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "direct_callable" BOOLEAN NOT NULL DEFAULT false,
    "rank_boost" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "catalog_action_profile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "discovery_profile_name_key" ON "discovery_profile"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_action_action_id_key" ON "catalog_action"("action_id");
CREATE INDEX IF NOT EXISTS "idx_catalog_action_server_id" ON "catalog_action"("server_id");
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_action_profile_action_id_profile_id_key"
ON "catalog_action_profile"("action_id", "profile_id");
CREATE INDEX IF NOT EXISTS "idx_catalog_action_profile_profile_id"
ON "catalog_action_profile"("profile_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'catalog_action_profile_action_id_fkey'
  ) THEN
    ALTER TABLE "catalog_action_profile"
      ADD CONSTRAINT "catalog_action_profile_action_id_fkey"
      FOREIGN KEY ("action_id") REFERENCES "catalog_action"("action_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'catalog_action_profile_profile_id_fkey'
  ) THEN
    ALTER TABLE "catalog_action_profile"
      ADD CONSTRAINT "catalog_action_profile_profile_id_fkey"
      FOREIGN KEY ("profile_id") REFERENCES "discovery_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
