-- CreateTable
CREATE TABLE "user_mfa_totp_credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "encrypted_secret" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "enabled_at" TIMESTAMPTZ,
    "disabled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_mfa_totp_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_mfa_totp_recovery_codes" (
    "id" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_mfa_totp_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_mfa_totp_credentials_user_id_key" ON "user_mfa_totp_credentials"("user_id");

-- CreateIndex
CREATE INDEX "user_mfa_totp_recovery_codes_credential_id_used_at_idx" ON "user_mfa_totp_recovery_codes"("credential_id", "used_at");

-- AddForeignKey
ALTER TABLE "user_mfa_totp_credentials" ADD CONSTRAINT "user_mfa_totp_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_mfa_totp_recovery_codes" ADD CONSTRAINT "user_mfa_totp_recovery_codes_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "user_mfa_totp_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
