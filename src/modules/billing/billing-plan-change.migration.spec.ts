import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Migration intent test (no live Postgres required): the plan-change migration
 * must drop the STANDALONE unique INDEX on (account, period), not only a
 * table constraint, and recreate a partial unique index limited to
 * purpose='usage_period'.
 */
describe('billing plan-change migration SQL', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../../prisma/migrations/20260917000000_add_billing_plan_change/migration.sql',
    ),
    'utf8',
  );

  it('drops the legacy full unique index by name', () => {
    expect(sql).toMatch(
      /DROP INDEX IF EXISTS "billing_invoices_billing_account_id_period_start_key"/,
    );
  });

  it('creates a partial unique index for usage_period only', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "billing_invoices_one_usage_period_per_account_period_idx"/,
    );
    expect(sql).toMatch(/WHERE "purpose" = 'usage_period'/);
  });

  it('adds BillingPlanChange.valid_until for server-derived windows', () => {
    expect(sql).toMatch(/"valid_until" TIMESTAMPTZ NOT NULL/);
  });
});

describe('billing subscription sync queue migration SQL', () => {
  const queueSql = readFileSync(
    join(
      __dirname,
      '../../../prisma/migrations/20260917150000_sync_intent_queue_behind_in_flight/migration.sql',
    ),
    'utf8',
  );
  const originalSql = readFileSync(
    join(
      __dirname,
      '../../../prisma/migrations/20260917120000_add_billing_subscription_sync_intent/migration.sql',
    ),
    'utf8',
  );

  it('original migration created the blocking one_active (pending+in_flight) index', () => {
    expect(originalSql).toMatch(
      /CREATE UNIQUE INDEX "billing_subscription_sync_intents_one_active_per_account_idx"/,
    );
    expect(originalSql).toMatch(/WHERE "status" IN \('pending', 'in_flight'\)/);
  });

  it('drops the old one_active index so pending can queue behind in_flight', () => {
    expect(queueSql).toMatch(
      /DROP INDEX IF EXISTS "billing_subscription_sync_intents_one_active_per_account_idx"/,
    );
  });

  it('replaces with one_in_flight-only unique index (queued pending may coexist)', () => {
    expect(queueSql).toMatch(
      /CREATE UNIQUE INDEX "billing_subscription_sync_intents_one_in_flight_per_account_idx"/,
    );
    expect(queueSql).toMatch(/WHERE "status" = 'in_flight'/);
    expect(queueSql).not.toMatch(/WHERE "status" IN \('pending', 'in_flight'\)/);
  });
});
