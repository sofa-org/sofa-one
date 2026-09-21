import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * B7: migration/schema alignment for billing_payment + iam auth_method.
 * Static evidence — no live DB. Complements prisma validate/generate.
 */
describe('Phase 2B wallet-payment schema/migrations', () => {
  const migrationsDir = join(__dirname, '../../../../prisma/migrations');
  const schemaPath = join(__dirname, '../../../../prisma/schema.prisma');

  const migrationNames = readdirSync(migrationsDir).filter((n) => n.match(/^\d{14}_/));

  function readMigration(name: string): string {
    return readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
  }

  it('has reservation migration before auth_method iam migration (ordered timestamps)', () => {
    const reservation = migrationNames.find((n) =>
      n.includes('billing_wallet_payment_reservation'),
    );
    const authIam = migrationNames.find((n) => n.includes('transactions_auth_method_iam'));
    expect(reservation).toBeDefined();
    expect(authIam).toBeDefined();
    expect(reservation! < authIam!).toBe(true);
  });

  it('reservation migration allows operation_type billing_payment', () => {
    const sql = readMigration(
      migrationNames.find((n) => n.includes('billing_wallet_payment_reservation'))!,
    );
    expect(sql).toMatch(/billing_payment/);
    expect(sql).toMatch(/transactions_operation_type_check/);
    expect(sql).toMatch(/wallet_payment_transaction_id/);
    expect(sql).toMatch(/wallet_payment_reserved/);
    expect(sql).toMatch(/wallet_dispatch_started_at/);
  });

  it('auth_method migration widens CHECK to api_key and iam without rewriting rows', () => {
    const sql = readMigration(
      migrationNames.find((n) => n.includes('transactions_auth_method_iam'))!,
    );
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS "transactions_auth_method_check"/);
    expect(sql).toMatch(/CHECK \("auth_method" IN \('api_key', 'iam'\)\)/);
    // Must not DELETE/UPDATE existing auth_method values.
    expect(sql).not.toMatch(/UPDATE\s+"transactions"/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+"transactions"/i);
  });

  it('Prisma schema models wallet-payment reservation fields and Transaction relation', () => {
    const schema = readFileSync(schemaPath, 'utf8');
    expect(schema).toMatch(/walletPaymentTransactionId/);
    expect(schema).toMatch(/walletPaymentReserved/);
    expect(schema).toMatch(/walletDispatchStartedAt/);
    expect(schema).toMatch(/WalletPaymentReservation/);
  });

  it('service insert shape uses authMethod iam + operationType billing_payment', () => {
    const servicePath = join(__dirname, 'usdc-wallet-payment.service.ts');
    const src = readFileSync(servicePath, 'utf8');
    expect(src).toMatch(/authMethod:\s*'iam'/);
    expect(src).toMatch(/OPERATION_TYPE\s*=\s*'billing_payment'/);
    expect(src).toMatch(/operationType:\s*OPERATION_TYPE/);
  });

  it('FK restrict migration follows reservation and uses ON DELETE RESTRICT', () => {
    const fk = migrationNames.find((n) => n.includes('wallet_payment_fk_restrict'));
    const reservation = migrationNames.find((n) =>
      n.includes('billing_wallet_payment_reservation'),
    );
    expect(fk).toBeDefined();
    expect(reservation).toBeDefined();
    expect(reservation! < fk!).toBe(true);
    const sql = readMigration(fk!);
    expect(sql).toMatch(/ON DELETE RESTRICT/);
    expect(sql).not.toMatch(/ON DELETE SET NULL/);
  });

  it('exposes recoverReservedPayment evidence-only seam (no blind submit)', () => {
    const src = readFileSync(join(__dirname, 'usdc-wallet-payment.service.ts'), 'utf8');
    expect(src).toMatch(/async recoverReservedPayment\(/);
    expect(src).toMatch(/claimFromWalletServerBinding/);
    const recoverIdx = src.indexOf('async recoverReservedPayment');
    const nextMethod = src.indexOf('\n  private async preflight', recoverIdx + 10);
    const recoverBody = src.slice(recoverIdx, nextMethod > 0 ? nextMethod : recoverIdx + 5000);
    expect(recoverBody).not.toMatch(/submitUserOperation/);
  });

  it('Prisma schema uses onDelete Restrict for wallet payment binding', () => {
    const schema = readFileSync(schemaPath, 'utf8');
    expect(schema).toMatch(/WalletPaymentReservation[\s\S]*onDelete:\s*Restrict/);
  });

  it('M4: schema does not declare full-table @unique on walletPaymentTransactionId', () => {
    const schema = readFileSync(schemaPath, 'utf8');
    // Field exists without @unique — partial unique is migration-only.
    // Relation is 1:N in Prisma so multiple NULL FKs are type-valid; DB partial
    // unique still enforces at-most-one non-null binding.
    expect(schema).toMatch(/walletPaymentTransactionId\s+String\?/);
    expect(schema).not.toMatch(/walletPaymentTransactionId\s+String\?\s+@unique/);
    expect(schema).toMatch(/walletPaymentAttempts\s+BillingPaymentAttempt\[\]/);
  });

  it('M3: active-payment index migration includes wallet_payment_reserved', () => {
    const m = migrationNames.find((n) => n.includes('wallet_payment_active_reservation_index'));
    expect(m).toBeDefined();
    const sql = readMigration(m!);
    expect(sql).toMatch(/one_active_payment_per_invoice_idx/);
    expect(sql).toMatch(/wallet_payment_reserved" = true/);
    expect(sql).toMatch(/status" IN \('pending', 'confirming'\)/);
  });
});
