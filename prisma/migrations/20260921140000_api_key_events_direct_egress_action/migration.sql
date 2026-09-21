-- BILL-016: allow audit action for API-key direct-egress reauthorization.
-- Do not edit the historical CHECK in 20260427120000; extend it here on fresh deploys.

ALTER TABLE "api_key_events" DROP CONSTRAINT IF EXISTS "api_key_events_action_check";

ALTER TABLE "api_key_events"
  ADD CONSTRAINT "api_key_events_action_check"
  CHECK (
    "action" IN (
      'api_key.created',
      'api_key.revoked',
      'api_key.rotated',
      'api_key.permission_changed',
      'api_key.direct_egress_authorized'
    )
  );
