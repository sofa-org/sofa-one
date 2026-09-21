# scripts/

Operational helper scripts (not part of the NestJS runtime or public API).

| Script                     | npm entry                       | Purpose                                                                             |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `billing-testnet-smoke.ts` | `npm run billing:testnet-smoke` | Read-only billing smoke                                                             |
| `billing-fixture.ts`       | `npm run billing:fixture`       | Historical unpaid-invoice fixture with HMAC manifests + atomic create-only finalize |
| `billing-e2e-runner.ts`    | `npm run test:e2e:billing`      | Runner-owned fresh DB+role, migrate, billing + Phase2/3 E2E, forced drop            |

## Billing E2E runner (Gate 1)

Provisions a **new** PostgreSQL database and login role per run (names embed a
unique run id), verifies `current_database` / `current_user` / `session_user` /
database owner / `application_name`, runs `prisma migrate deploy`, then Jest for
`billing-e2e-database` gate tests + `billing-http` + claim/settlement concurrency +
`api-key-direct-egress` + concurrency lock evidence (BILL-016 Phase 2A) +
`usdc-wallet-payment` (Phase 2B quote-bound pay-from-wallet; providers mocked) +
`phase3-billing` (Phase 3 disposable-DB evidence: cross-rail checkout conflict,
cleanup lease/late-session discovery CAS, worker unresolved backlog vs terminal
review health; Stripe/Openfort mocked only — no live provider contract claimed).
Drops the database `WITH (FORCE)` and the role in `finally`.

**Hard rules**

- Admin input only: `BILLING_E2E_ADMIN_DATABASE_URL` (superuser → maintenance
  `postgres` DB). Never falls back to `DATABASE_URL` or a static shared test DB.
- Child Jest receives only the generated target URL + runner metadata
  (`BILLING_E2E_PROVISIONED=runner-v1`, run id, expected db/user/owner/app name,
  `BILLING_E2E_DISPOSABLE_DB=true`). The admin URL is stripped from the child env.
- Credentials and full URLs are never logged.
- Gate-only (no Postgres): `npm run test:e2e:billing:gate`

```bash
export BILLING_E2E_ADMIN_DATABASE_URL='postgresql://postgres:…@localhost:5432/postgres'
npm run test:e2e:billing
```

## Billing historical fixture

Atomic path: assignment + posted usage + `BillingService.createFinalizedInvoiceOnlyInTx`
under one Serializable billing-period advisory lock. Ownership only when
`created: true`.

**Hard rules**

- Default dry-run; writes need `BILLING_FIXTURE_ENABLED=true`, `--apply`,
  `BILLING_FIXTURE_DATABASE_URL`, `BILLING_FIXTURE_MANIFEST_KEY`, allowed `NODE_ENV`.
- Manifest publish is **exclusive no-clobber** (never overwrites an existing file).
- Prior signed manifests are **never rewritten** after successful baseline verify.
- Cleanup deletes a period only when `invoiceOwnedByFixture=true` + `mode=created`
  - assignment owned. Missing invoice with any residue → fail closed (no deletes).
- If assignment was reused (not fixture-created), cleanup refuses destructive
  assignment/invoice delete (`cleanup_assignment_not_owned`).
- Usage rows must keep all provider/evidence columns null; reverse/adjustment
  dependents block delete.
- Plan terms+tiers fingerprint is pinned in the manifest and re-checked inside
  the cleanup transaction (not only at identity time).
- Invoice integrity uses production `buildInvoiceLineSpecs` + `planVersionToConfig`
  (**pinned DB terms**, not static PLANS fees) and order-independent line multiset
  compare. included\* must be non-null and equal pinned plan.
- Runtime logs use fixed labels only (`<default-manifest>`, `<user-uuid>`, …);
  never echo free-text paths/ids. Manifest v2 with `planTermsFingerprint` is
  required (older unsigned/v1 or snapshots without `plan.version` fail closed).
- Does not bootstrap plan catalog. Prefer a dedicated fixture user.
- **Each period** is one atomic Serializable tx; **seed+manifest publish is not**
  one atomic unit — a crash after DB commit but before exclusive manifest write
  can leave rows without a manifest (do not invent cleanup for those). Do not run
  concurrent seeds for the same fixture.
- Unit coverage: line multiset (JSON keys, reorder, field drift), log fixed labels,
  usage evidence null/cleanup decision helpers, `planVersionToConfig` DB-term drift.
  Real multi-process lock/payment-attempt concurrency is **not** claimed as verified
  in the default unit suite (opt-in DB smoke: seed→reseed→verify→cleanup only).

```bash
npm run billing:fixture -- --help
openssl rand -hex 32
export BILLING_FIXTURE_MANIFEST_KEY   # paste hex
export NODE_ENV=test BILLING_FIXTURE_ENABLED=true
export BILLING_FIXTURE_DATABASE_URL   # never logged
npm run billing:fixture -- seed --apply --user-id <uuid> --periods 2025-01 --fixture-id demo --api-calls 2
```

Full guide: [`docs/billing-testnet.md`](../docs/billing-testnet.md).
