# DeFi coverage tooling

Offline, isolated coverage calculation utilities, not a runtime policy or market-discovery service. Snapshot-specific source adapters and CLIs were removed; reports under `data/defi-coverage/` are historical artifacts and do not drive current catalog maintenance.

- `types.ts`: typed normalized snapshot, product/workflow/instance/activity evidence, and report input vocabulary.
- `calculator.ts`: validates normalized input and computes observed/conservative product and workflow completeness, chain/category breakdowns, and compatible activity weighting. Missing attribution, incomplete enumerations, unknown time, and unresolved records stay explicit and block objective establishment; no source is fetched and no transaction policy is affected.
- `cli-helpers.ts`: pure report serialization and check helpers.
- `calculator.spec.ts`, `cli-helpers.spec.ts`: synthetic calculator and CLI-helper contracts.

Historical reports are not claims that the market denominator is complete or that runtime capabilities are safe, funded, or deployed. The pure calculator is retained only for synthetic/offline use.
