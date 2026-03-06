-- Deduplicate existing rows before creating unique indexes
-- Reassign sequential versions per server_id partition
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "server_id" ORDER BY "created_at", id) AS rn
  FROM "tool_policy_set"
  WHERE "server_id" IS NOT NULL
)
UPDATE "tool_policy_set" SET "version" = numbered.rn
FROM numbered WHERE "tool_policy_set".id = numbered.id;

-- Reassign sequential versions for global policies (server_id IS NULL)
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "created_at", id) AS rn
  FROM "tool_policy_set"
  WHERE "server_id" IS NULL
)
UPDATE "tool_policy_set" SET "version" = numbered.rn
FROM numbered WHERE "tool_policy_set".id = numbered.id;

CREATE UNIQUE INDEX IF NOT EXISTS "tool_policy_set_server_version_uq"
ON "tool_policy_set" ("server_id", "version")
WHERE "server_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "tool_policy_set_global_version_uq"
ON "tool_policy_set" ("version")
WHERE "server_id" IS NULL;
