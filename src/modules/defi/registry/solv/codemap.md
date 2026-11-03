# SolvBTC Router V2 Fixture

Explicit active registry fragment for three selected Ethereum SolvBTC Router V2 proxy methods, used only in isolated offline catalog/policy tests. The raw v6 candidate remains inactive; this fixture is not runtime wired or automatically granted.

- `index.ts` records the exact Etherscan-listed implementation ABI for deposit, withdrawal request, and cancellation while targeting the pinned official user proxy.
- `index.spec.ts` checks exact ABI/hash/ID/source-reference binding and actual Catalog/Policy grant, isolation, canonicality, and payability behavior.

Deployment-receipt and separately listed implementation evidence differ; no present proxy slot is asserted. The async request/cancel methods do not complete settlement. See `docs/defi-research/expansion55-solv-v6.md`.
