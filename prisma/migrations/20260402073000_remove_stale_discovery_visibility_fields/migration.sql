ALTER TABLE "public"."discovery_profile"
  DROP COLUMN IF EXISTS "public_visible",
  DROP COLUMN IF EXISTS "anonymous_visible";

ALTER TABLE "public"."catalog_action"
  DROP COLUMN IF EXISTS "category",
  DROP COLUMN IF EXISTS "tags",
  DROP COLUMN IF EXISTS "required_scopes",
  DROP COLUMN IF EXISTS "approval_required",
  DROP COLUMN IF EXISTS "public_visible";

DROP INDEX IF EXISTS "public"."idx_catalog_action_category";
