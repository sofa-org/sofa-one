# Origin OETH Fixture

Explicit active registry builder used only by offline catalog/policy tests for four source-bound OETH operations on the Ethereum user proxy. The raw source candidate remains inactive; this directory is not wired into runtime or automatic grants.

- `index.ts`: fixed proxy-target ABI declarations and stable capability IDs.
- `index.spec.ts`: source ABI/hash binding and actual `DefiPolicyService` authorization/canonicality coverage.

The implementation deployment supplies ABI/source evidence only and is not an authorized target. See `docs/defi-research/expansion55-origin-v6.md` for the proxy role bridge and limitations.
