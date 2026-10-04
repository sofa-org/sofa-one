# Idle Registry Fixture

This directory contains an explicit, active registry fixture for the two pinned Ethereum iDAI user operations, used only in offline catalog/policy tests. It is not runtime wired and does not publish admissions or grants. The source candidate under `data/defi-catalog/v6/sources/idle.json` remains inactive.

- `index.ts` declares the exact interface ABI and stable source-qualified capability IDs for mint and redeem.
- `index.spec.ts` binds the full source ABI/hash and exercises actual `DefiPolicyService` exact-grant, isolation, canonical calldata, payability, and caller argument behavior.

Administrative/rebalance/emergency functions and other Idle methods are intentionally excluded. See `docs/defi-research/expansion55-idle-v6.md` for evidence limits and protocol conditions.
