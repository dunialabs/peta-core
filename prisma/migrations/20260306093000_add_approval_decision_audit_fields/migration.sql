ALTER TABLE "approval_request"
ADD COLUMN "decided_by_user_id" VARCHAR(64),
ADD COLUMN "decided_by_role" INTEGER,
ADD COLUMN "decision_channel" VARCHAR(32);
