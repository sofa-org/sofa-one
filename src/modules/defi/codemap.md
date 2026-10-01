# Code Map for /src/modules/defi

## Responsibility
Fail-closed foundation for reviewed DeFi capability catalog metadata, API-key grant normalization, contract-call authorization, persistent pause state, and safe audit. The shipped catalog is empty and signing authorization is always denied.

## Files and flow
- `defi-catalog.service.ts`: injected nested chain → contract → function catalog, validates identities/selectors/hierarchy/fixed ABI/synchronous validators at construction, deep-freezes copied entries, and serves pause-aware async metadata.
- `defi-grant.service.ts`: omitted grants normalize to empty; explicit null is rejected. Exact grant ID normalization (max 100, unique, sorted); grant validation takes global state `FOR SHARE` and permits only active, unpaused contract-call entries.
- `defi-policy.service.ts`: strict hierarchy and canonical ABI authorization, valid owner/nonempty batch requirements, transaction-final authorization check, and safe audit.
- `defi-pause.service.ts`: structured scope keys, validated operator evidence, shared/exclusive global row locks, no-op suppression, READ COMMITTED atomic audit and after-commit export.
- `defi.types.ts`, `index.ts`: cross-module stable interfaces and barrel exports.
- `defi.module.ts`: leaf providers; depends on security events and global Prisma.

## Security constraints
No active entries, typed data always denied, fixed ABI + synchronous code validator only, no automatic pause-row repair. Final recheck performs primary database reads; it does not eliminate external submission TOCTOU. Denials must be audited after rollback and audit failures cannot mask the stable policy denial. The PostgreSQL multi-client lock spec is gated by `DEFI_POLICY_PG_TEST=true` and a configured `DATABASE_URL`.
