# Code Map for /src/modules/defi

## Responsibility
Function-level DeFi capability catalog, explicit API-key grants, transaction-call binding, persistent pause state, and safe audit. Users accept the risks of arguments inside a specifically granted fixed ABI function; this layer does not impose financial amount, recipient, deadline, slippage, asset, or spender restrictions. No arbitrary calldata or automatic dependencies are authorized. Signing always denies.

## Files and flow
- `defi.types.ts`: immutable execution, capability, match, authorization, denial, database and pause types.
- `registry/defi-manifest.types.ts`, `registry/defi-manifest.ts`, `registry/production-registry.ts`: nested-chain fragments merge into a reviewed manifest containing only chains, capabilities, and deterministic identity hash. The assembled snapshot preserves the 108-definition baseline and adds 94 definitions (91 actions, 3 approvals), for 202 total (179 actions, 23 explicit approvals) across seven mainnets. Oracle Gate 1 initial attempt 1/3 passed for scoped catalog/source and local authorization with no material findings. Both nonblocking provenance-reference alignment notes were resolved; no material re-review was needed. An independent structural scan passed. Backend build and unit validation passed (112 suites, 2,263 tests); one opt-in PostgreSQL suite/test was skipped. This is not runtime, funded-execution, or deployment proof. Builders validate fixed ABI/provenance and selector uniqueness, clone, and deep-freeze.
- `defi-catalog.service.ts`: injected catalog/manifest identity consistency, immutable copies, pause-aware metadata, and chain/capability lookup.
- `defi-grant.service.ts`: exact grant ID normalization and transactional active/unpaused grant validation under the global shared pause lock.
- `defi-policy.service.ts`: chain/contract-local selector lookup, explicit grant and pause checks, canonical ABI decode/re-encode, uint256/payability validation, request commitment, final live-key/catalog/grant/pause checks, and safe audit.
- `defi-pause.service.ts`: structured scope keys, validated operator evidence, shared/exclusive global row locks, no-op suppression, READ COMMITTED atomic audit and after-commit export.
- `defi.module.ts`: catalog, grant, pause, policy and security-event providers; no DeFi evidence/RPC provider.
- `defi-catalog.service.spec.ts`, `defi-policy.service.spec.ts`, `defi-grant.service.spec.ts`, `defi-pause.service.spec.ts`, `defi-pause.concurrent.pg.spec.ts`: focused contracts and database concurrency coverage.

## Security constraints
Active entries require verified source provenance, matching chain/contract/signature/ABI identity and fixed ABI selector uniqueness. ABI hash is Keccak-256 of recursively key-sorted ABI JSON (array order retained); catalog hash sorts capability IDs and commits only identity fields, not human copy or provenance dates. Every function must be explicitly granted, remain unpaused and exactly match canonical calldata. Native value is a nonnegative uint256 and must be zero for nonpayable functions. Final authorization rechecks current API-key ownership, freeze/revocation/expiry, permission, grants, pause, manifest identity and call binding under caller-owned READ COMMITTED transaction locks; it does no RPC. Denial audit excludes calldata/arguments. No signing authorization is emitted.
