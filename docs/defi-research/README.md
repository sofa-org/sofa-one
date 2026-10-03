# DeFi research index

These notes record bounded discovery and validation evidence, not protocol endorsements or permission to transact. Deployment registries may be mutable; read each note's snapshot date and limitations. The current catalog summary is the [capability matrix](../defi-capability-matrix.md); baseline source provenance is [catalog provenance](simple-catalog-provenance.md). The current static catalog has 349 definitions (326 actions, 23 separately grantable approvals) across seven aggregate chain IDs. It preserves the 315-function M2 catalog and adds 34 source-qualified M3 functions, with 13 finite execution scopes. Nine fixed version `1.0.0` profiles contain 75 unique capability IDs and never auto-grant. The terminal M3 coverage projection (`c3f276857105f6759b1f1734a02176d4a13335fc9133913bbae9092ac39059ea`) reports market objective `FALSE`, nine target-scoped complete rows, and seven population-incomplete rows; these are not complete-product counts and do not establish 90% coverage. Frozen M2 activity evidence and the 8,476-row universe remain preserved. M1 commit `11dc6b8` and M2 commit `0f1635c` are historical. Terminal validation reported 2,359 tests passed with one opt-in PostgreSQL test skipped; the build passed. Oracle Gate 3 passed on attempt 2/3 after resolving R1, with no new material finding. Catalog/source admission does not establish deployment, runtime-code identity, financial safety, liquidity, transaction success, funded execution, or complete workflow availability.

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
