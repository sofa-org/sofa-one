-- CreateTable
CREATE TABLE "signing_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "api_key_id" UUID,
    "type" VARCHAR(20) NOT NULL,
    "chain_id" BIGINT,
    "wallet_address" VARCHAR(42) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "digest" VARCHAR(66) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'submitting',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "signing_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signing_requests_user_id_created_at_idx" ON "signing_requests"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "signing_requests_api_key_id_created_at_idx" ON "signing_requests"("api_key_id", "created_at");

-- CreateIndex
CREATE INDEX "signing_requests_request_hash_idx" ON "signing_requests"("request_hash");

-- AddForeignKey
ALTER TABLE "signing_requests" ADD CONSTRAINT "signing_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signing_requests" ADD CONSTRAINT "signing_requests_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
