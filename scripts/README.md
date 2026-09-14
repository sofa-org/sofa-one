# scripts/

Operational helper scripts (not part of the NestJS runtime or public API).

| Script                     | npm entry                       | Purpose                                                                             |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `billing-testnet-smoke.ts` | `npm run billing:testnet-smoke` | Read-only billing smoke                                                             |
| `billing-fixture.ts`       | `npm run billing:fixture`       | Historical unpaid-invoice fixture with HMAC manifests + atomic create-only finalize |

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
