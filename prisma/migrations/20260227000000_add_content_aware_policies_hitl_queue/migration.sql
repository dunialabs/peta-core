CREATE TABLE "approval_request" (
    "id" TEXT NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "server_id" VARCHAR(128),
    "tool_name" TEXT NOT NULL,
    "canonical_args" JSONB NOT NULL,
    "redacted_args" JSONB NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "executed_at" TIMESTAMP(3),
    "execution_error" TEXT,
    "uniform_request_id" VARCHAR,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_request_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tool_policy_set" (
    "id" TEXT NOT NULL,
    "server_id" VARCHAR(128),
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "dsl" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_policy_set_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "approval_request_request_hash_status_idx" ON "approval_request"("request_hash", "status");

CREATE INDEX "approval_request_user_id_status_idx" ON "approval_request"("user_id", "status");

CREATE INDEX "approval_request_user_id_created_at_idx" ON "approval_request"("user_id", "created_at");

CREATE INDEX "approval_request_expires_at_status_idx" ON "approval_request"("expires_at", "status");

CREATE INDEX "tool_policy_set_server_id_status_idx" ON "tool_policy_set"("server_id", "status");

CREATE UNIQUE INDEX "approval_request_request_hash_active_uq" ON "approval_request" ("request_hash") WHERE "status" IN ('PENDING', 'APPROVED', 'EXECUTING');
