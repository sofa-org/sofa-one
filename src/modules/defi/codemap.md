# Code Map for /src/modules/defi

## Responsibility
Fail-closed foundation for reviewed DeFi capability catalog metadata, API-key grant normalization, contract-call authorization, persistent pause state, and safe audit. The assembled catalog has 70 definitions: three active Ethereum Uniswap V3 USDC/WETH fee-500 capabilities (swap and two explicit token approvals) and 67 inactive definitions. Oracle Gate 1 attempt 3 passed 3/3 for this exact authority set; this is not a release/deployment claim or broad multi-chain DeFi coverage.

## Files and flow
- `evidence/defi-evidence.service.ts`: mandatory bounded read-only RPC verification of the frozen reviewed manifest, pinned deployment/runtime identities, asset funding/allowances, price feeds, pools and supported lending reserves. It emits a short-lived commitment tied to the authorization and one recorded block; no signing, sending, or caller-selected RPC.
- `evidence/defi-evidence.service.spec.ts`: unit coverage for single-block pinning, manifest/chain drift, and fail-closed RPC/code checks.
- `defi-catalog.service.ts`: injected nested chain → contract → function catalog, validates identities/selectors/hierarchy/fixed ABI/synchronous validators at construction, deep-freezes copied entries, and serves pause-aware async metadata.
- `defi-grant.service.ts`: omitted grants normalize to empty; explicit null is rejected. Exact grant ID normalization (max 100, unique, sorted); grant validation takes global state `FOR SHARE` and permits only active, unpaused contract-call entries.
- `defi-policy.service.ts`: strict hierarchy and canonical ABI authorization, valid owner/nonempty batch requirements, transaction-final authorization check, and safe audit.
- `defi-pause.service.ts`: structured scope keys, validated operator evidence, shared/exclusive global row locks, no-op suppression, READ COMMITTED atomic audit and after-commit export.
- `defi.types.ts`, `index.ts`: cross-module stable interfaces and barrel exports.
- `defi-batch.policy.ts`: atomic approval/action/cleanup grammar and per-operation asset ceilings; it performs no RPC checks.
- `registry/`: family-fragment manifest contracts, explicit serializable policy identity hashing, and derived finite ERC-20 approval identities. Manifest hash excludes function source and includes ABI, policy/version, metadata, refs, configuration, and activation evidence; registry inputs are cloned before freezing.
- `defi.module.ts`: leaf providers; depends on security events and global Prisma.

## Security constraints
Only the exact three Ethereum USDC/WETH fee-500 entries are active; all other definitions remain inactive and exact grants are never automatic. Oracle Gate 1 attempt 3 passed 3/3 for this exact scope. This does not establish live UserOperation/bundler success or authorize a broader rollout. Typed data remains denied, with fixed ABI + synchronous code validator only and no automatic pause-row repair. The swap requires short-lived server evidence. Final recheck performs primary database reads; it does not eliminate external submission TOCTOU. Denials must be audited after rollback and audit failures cannot mask the stable policy denial. The PostgreSQL multi-client lock spec is gated by `DEFI_POLICY_PG_TEST=true` and a configured `DATABASE_URL`.
