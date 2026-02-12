-- AlterTable
ALTER TABLE "server" ADD COLUMN     "cached_prompts" TEXT,
ADD COLUMN     "cached_resource_templates" TEXT,
ADD COLUMN     "cached_resources" TEXT,
ADD COLUMN     "cached_tools" TEXT,
ADD COLUMN     "lazy_start_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "transport_type" VARCHAR(10);
