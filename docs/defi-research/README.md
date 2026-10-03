# DeFi research index

These notes record bounded discovery and validation evidence, not protocol endorsements or permission to transact. Deployment registries may be mutable; read each note's snapshot date and limitations. The current catalog summary is the [capability matrix](../defi-capability-matrix.md); baseline source provenance is [catalog provenance](simple-catalog-provenance.md). The current static catalog has 315 definitions (292 actions, 23 separately grantable approvals) across seven aggregate chain IDs. It preserves the full 202-definition v1 baseline and adds 113 source-qualified M2 functions. M1 was committed as `11dc6b8`; parent build/unit and v2/M1/catalog CLI checks passed, as did focused R1 validation (4 suites, 41 tests, 6.377 seconds). M2 Oracle Gate 2 passed on attempt 2/3 after R1 resolution, with no new material risks. See the [M2 delivery and coverage status](majority-m2-delivery.md). Catalog/source admission does not establish runtime identity, financial safety, liquidity, deployment, transaction success, or funded execution proof; authenticated-browser verification has not been performed.

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
