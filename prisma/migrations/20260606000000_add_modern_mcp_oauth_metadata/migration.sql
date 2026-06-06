ALTER TABLE "public"."oauth_clients" ADD COLUMN "issuer" VARCHAR(255) NOT NULL DEFAULT 'default';
ALTER TABLE "public"."oauth_clients" ADD COLUMN "application_type" VARCHAR(32) NOT NULL DEFAULT 'web';
CREATE INDEX "idx_oauth_client_issuer_client_id" ON "public"."oauth_clients"("issuer", "client_id");
