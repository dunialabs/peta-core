-- Add use_peta_oauth_config flag to server table (default true for legacy data)
ALTER TABLE "server"
ADD COLUMN "use_peta_oauth_config" BOOLEAN NOT NULL DEFAULT true;
