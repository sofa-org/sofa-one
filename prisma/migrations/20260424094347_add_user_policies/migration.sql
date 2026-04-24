-- CreateTable
CREATE TABLE "user_policies" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "openfort_policy_id" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_policies_user_id_openfort_policy_id_key" ON "user_policies"("user_id", "openfort_policy_id");

-- AddForeignKey
ALTER TABLE "user_policies" ADD CONSTRAINT "user_policies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
