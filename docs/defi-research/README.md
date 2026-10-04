# DeFi research index

These notes record bounded discovery and validation evidence, not protocol endorsements or permission to transact. Deployment registries may be mutable; read each note's snapshot date and limitations. The current catalog summary is the [capability matrix](../defi-capability-matrix.md); baseline source provenance is [catalog provenance](simple-catalog-provenance.md). Current production v4 has 368 definitions (345 actions, 23 separately grantable approvals) across seven aggregate chain IDs. It preserves the 349-function v3 catalog and adds 19 source-qualified functions, with 14 finite execution scopes. Twelve fixed version `1.0.0` profiles contain 94 unique IDs and never auto-grant. Gate 4 is FINAL PASS on attempt 3/3 (R1/R2/R3 closed), but the independent M4 coverage objective remains `FALSE`, and `marketDenominator` is null: the retained 8,476-row raw roster is not a verified canonical product denominator. The independent activity/coverage audit distinguishes raw source IDs from canonical identity counts; neither is a 90% market claim. M1 commit `11dc6b8`, M2 commit `0f1635c`, and M3 commit `e453acd` are historical; the current M4 partial delivery is locally uncommitted and has no claimed commit hash. Parent integrated validation reported 2,380 tests passing plus one opt-in PostgreSQL test skipped; build passed. Final independent audit and review each passed 10 tests. Catalog/source admission does not establish deployment, runtime-code identity, financial safety, liquidity, transaction success, funded execution, or complete workflow availability.

| Note | Scope |
|---|---|
| [DEX deployment research](dex.md) | Historical pre-simplification deployment research for Original Uniswap V3, SwapRouter02 and PancakeSwap V3; catalog authority is defined by current source inventory and fixed ABIs. |
| [Lending and market research](lending-vaults.md) | Historical pre-simplification research for Aave V3 Pool/assets and Compound III USDC Comet. |
| [Vault candidates](vaults.md) | Historical pre-simplification Morpho Vault V2 discovery notes and call shapes. |
| [DEX expansion provenance](expansion-dex-provenance.md) | Official source/address admission for Aerodrome, Velodrome, and PancakeSwap V2 direct router functions. |
| [Lending and staking expansion provenance](expansion-lending-staking-provenance.md) | Official source/address admission for selected Morpho Blue and Lido functions, including asynchronous withdrawal queue calls. |
| [SushiSwap V2 bounded provenance](expansion-2-sushi-provenance.md) | Ten direct classic-router methods on six explicitly keyed chains; Monad deferred. |
| [Spark/Venus bounded provenance](expansion-2-lending-provenance.md) | SparkLend and selected Venus market actions, with three independent token approvals; Savings vault candidates remain deferred. |
| [Rocket Pool bounded provenance](expansion-2-rocket-pool-provenance.md) | Deposit, rETH burn, and rETH approval interface shapes are documented, but all three exact deployment targets remain deferred. |
| [M2 source-qualified catalog and coverage status](majority-m2-delivery.md) | Exact v2 function admissions, catalog delta, conservative market-coverage status, and remaining workflow/product uncertainty. |
| [M3 workflow-extension catalog and profile review](majority-catalog-v3.md) | 34 source-qualified function additions, 13 finite execution scopes, nine exact versioned profiles, limitations, and terminal Gate 3 result. |
| [M3 milestone delivery and coverage status](majority-m3-delivery.md) | Integrated execution boundaries, terminal validation evidence, R1 resolution, and market-coverage limitations. |
| [M4 candidate delivery and coverage status](majority-m4-delivery.md) | Current v4 inventory, preserved v3 authority, profile limits, independent audit, remaining market denominator/evidence gaps, and current gate/validation status. |
| [M4 independent offline audit](majority-m4-independent-audit.md) | Independent v4 source/catalog/profile verification and separate raw-source versus normalized-coverage cardinalities. |
| [M4 catalog refresh audit](majority-m4-refresh-audit.md) | Offline same-ID authority and immutable-profile reconciliation behavior and current v3-to-v4 result. |
| [M2 DEX source snapshot](majority-dex-v2.md) | Uniswap V3 position-manager and Balancer V2 Vault source records. |
| [M2 lending/yield source fragment](majority-lending-yield-v2.md) | Aave V3, Compound III, and Compound V2 source records and call-shape limits. |
| [M2 identity reconciliation](majority-identity-v2.md) | Exact identity bridges and retained unresolved raw-roster rows. |
| [M2 activity evidence](majority-activity-v2.md) | DeFiLlama seven-chain snapshot provenance and activity-method limitations. |
| [Price-feed research](price-feeds.md) | Chainlink USD-feed/sequencer candidates and exact-input price-bound method. |
| [Deployment checks](deployment-checks.md) | Recorded read-only deployment/runtime/getter observations and unavailable checks. |
| [Deployed-source evidence](deployed-source-evidence.md) | Sourcify/source correspondence for selected exact deployments, including Ethereum USDC's ZeppelinOS proxy pattern. |
| [Fork validation plan](fork-validation-plan.md) | Safe local Anvil fork procedure, Calibur path boundaries and assertion recipe. |
| [Fork execution results](fork-execution-results.md) | Recorded local-fork DEX results and unsuccessful/unresolved Aave supply attempt. |
| [Aave revert diagnosis](aave-fork-revert.md) | Source diagnosis of the observed Aave revert selector and required trace reconciliation. |
