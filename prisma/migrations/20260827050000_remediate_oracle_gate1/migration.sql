-- Gate 1 bounded remediation: cross-instance active-run uniqueness, account
-- subscription mirror period/event-order fields, invoice-level Stripe identity,
-- canonical USDC submitted-hash uniqueness, and the safe versioned assignment
-- roll-forward.
--
-- No finalized invoice snapshot/hash is rewritten. No billing_plan_version is
-- rewritten in place.

-- BillingAccount: subscription mirror period/event-order fields.
ALTER TABLE "billing_accounts"
  ADD COLUMN "stripe_subscription_period_end" TIMESTAMPTZ,
  ADD COLUMN "stripe_subscription_updated_at" TIMESTAMPTZ;

-- BillingInvoice: invoice-level Stripe identity (unique).
ALTER TABLE "billing_invoices"
  ADD COLUMN "stripe_invoice_id" VARCHAR(255);
CREATE UNIQUE INDEX "billing_invoices_stripe_invoice_id_key"
  ON "billing_invoices" ("stripe_invoice_id");

-- BillingPaymentAttempt: canonical (lowercase) user-submitted USDC hash is
-- unique while non-null, so two attempts can never claim the same transfer.
CREATE UNIQUE INDEX "billing_payment_attempts_submitted_tx_hash_key"
  ON "billing_payment_attempts" ("submitted_tx_hash")
  WHERE "submitted_tx_hash" IS NOT NULL;
CREATE INDEX "billing_payment_attempts_submitted_tx_hash_idx"
  ON "billing_payment_attempts" ("submitted_tx_hash");

-- BillingReconciliationRun: at most one active (running) run per account +
-- target period + run type. Legacy runs with NULL billing_account_id are
-- unaffected (NULLs are distinct in Postgres partial indexes).
CREATE UNIQUE INDEX "billing_reconciliation_runs_active_run_key"
  ON "billing_reconciliation_runs" ("billing_account_id", "period_start", "run_type")
  WHERE "status" = 'running';
CREATE INDEX "billing_reconciliation_runs_account_period_runtype_status_idx"
  ON "billing_reconciliation_runs" ("billing_account_id", "period_start", "run_type", "status");

-- ── Safe versioned assignment roll-forward (single owner) ────────────────────
-- The accepted overage rates are API 1000 micros and wallet 10000 micros.
--
-- This is the ONLY migration that mutates plan versions/assignments. It is
-- idempotent and does NOT depend on a branch that is skipped once accepted-rate
-- ("v2") rows already exist:
--   * For each plan code, the newest version carrying the accepted rates is the
--     target. If none exists, ONE accepted-rate version is created (a clone of
--     the newest version) with new tiers.
--   * Then the assignment roll-forward runs UNCONDITIONALLY for every code:
--     safe current/future assignments (periodStart >= current UTC month) that
--     still point at a non-accepted-rate version of the same code and whose
--     period has no finalized/needs_review/void invoice are moved to the
--     accepted-rate version. Once an assignment points at the accepted-rate
--     version it no longer matches, so re-runs are no-ops.
--   * Historical assignments (past periods) and assignments referenced by an
--     immutable invoice are never touched. No billing_plan_version row is ever
--     rewritten in place and no finalized invoice snapshot/hash changes.
DO $$
DECLARE
  r RECORD;
  src_plan_id UUID;
  accepted_plan_id UUID;
  new_version INTEGER;
BEGIN
  FOR r IN
    SELECT DISTINCT pv.code FROM "billing_plan_versions" pv
  LOOP
    SELECT MAX(version) INTO new_version FROM "billing_plan_versions" WHERE code = r.code;

    IF new_version IS NULL THEN
      CONTINUE; -- no existing rows; code-first seeding handles it
    END IF;

    -- Only the newest version may be the roll-forward target. If a newer
    -- source version exists with old rates, an older accepted version must not
    -- move assignments backwards.
    SELECT pv.id INTO accepted_plan_id
      FROM "billing_plan_versions" pv
      WHERE pv.code = r.code
        AND pv.api_overage_rate_micros = 1000
        AND pv.wallet_overage_rate_micros = 10000
        AND pv.version = new_version
      ORDER BY pv.version DESC
      LIMIT 1;

    IF accepted_plan_id IS NULL THEN
      -- The newest source is not accepted yet: create one accepted-rate
      -- version after it, cloned from that newest source. This also repairs a
      -- database that already has an older accepted-rate version.
      SELECT src.id INTO src_plan_id
        FROM "billing_plan_versions" src
        WHERE src.code = r.code AND src.version = new_version
        LIMIT 1;
      IF src_plan_id IS NULL THEN
        CONTINUE;
      END IF;

      INSERT INTO "billing_plan_versions" (
        "id", "code", "version", "name", "description",
        "monthly_fee_micros", "included_outbound_micros", "included_api_calls",
        "included_wallets", "included_team_members",
        "api_overage_rate_micros", "wallet_overage_rate_micros",
        "effective_from", "created_at"
      )
      SELECT
        gen_random_uuid(), src.code, new_version + 1, src.name, src.description,
        src.monthly_fee_micros, src.included_outbound_micros, src.included_api_calls,
        src.included_wallets, src.included_team_members,
        1000, 10000,
        now(), now()
      FROM "billing_plan_versions" src
      WHERE src.code = r.code AND src.version = new_version
      RETURNING "id" INTO accepted_plan_id;

      IF accepted_plan_id IS NOT NULL THEN
        INSERT INTO "billing_plan_tiers" ("id", "plan_version_id", "lower_bound_micros", "upper_bound_micros", "rate_ppm")
        SELECT gen_random_uuid(), accepted_plan_id, t.lower_bound_micros, t.upper_bound_micros, t.rate_ppm
        FROM "billing_plan_tiers" t
        WHERE t.plan_version_id = src_plan_id;
      END IF;
    END IF;

    -- Assignment roll-forward: runs every time (not only when a version was
    -- just created), so databases where accepted-rate rows already exist still
    -- get their safe assignments moved. Idempotent by construction.
    IF accepted_plan_id IS NOT NULL THEN
      UPDATE "billing_plan_assignments" a
      SET "plan_version_id" = accepted_plan_id
      WHERE a."plan_version_id" <> accepted_plan_id
        AND EXISTS (
          SELECT 1 FROM "billing_plan_versions" pv
          WHERE pv.id = a."plan_version_id" AND pv.code = r.code
        )
        AND a."period_start" >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        AND NOT EXISTS (
          SELECT 1 FROM "billing_invoices" inv
          WHERE inv."billing_account_id" = a."billing_account_id"
            AND inv."period_start" = a."period_start"
            AND inv."status" IN ('finalized', 'needs_review', 'void')
        );
    END IF;
  END LOOP;
END $$;
