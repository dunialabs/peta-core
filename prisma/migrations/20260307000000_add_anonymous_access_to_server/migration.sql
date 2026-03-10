-- AlterTable
ALTER TABLE "server" ADD COLUMN     "anonymous_access" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "server" ADD COLUMN     "anonymous_rate_limit" INTEGER NOT NULL DEFAULT 10;
