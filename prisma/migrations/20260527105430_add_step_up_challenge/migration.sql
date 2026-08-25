-- AlterTable
ALTER TABLE "wallet_chain_authorizations" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "step_up_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "challenge_code_hash" TEXT NOT NULL,
    "proof_token" VARCHAR(64),
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "verified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_up_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "step_up_challenges_proof_token_idx" ON "step_up_challenges"("proof_token");

-- CreateIndex
CREATE INDEX "step_up_challenges_user_id_created_at_idx" ON "step_up_challenges"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "step_up_challenges" ADD CONSTRAINT "step_up_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
