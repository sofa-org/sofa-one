ALTER TABLE "api_keys"
  ADD COLUMN "can_sign" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "can_send_transaction" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "can_read_transaction_status" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "can_use_eoa_execution" BOOLEAN NOT NULL DEFAULT false;
