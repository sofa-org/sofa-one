-- BILL-016 Phase 2A: per-key acknowledgement that the operator understands
-- API-key sends are subject to the user's withdrawal destination allowlist.
-- NULL = not authorized for new direct-egress sends (canSendTransaction keys).
-- Existing keys stay NULL; create never auto-sets this (requires explicit step-up).

ALTER TABLE "api_keys"
ADD COLUMN "direct_egress_policy_accepted_at" TIMESTAMPTZ;
