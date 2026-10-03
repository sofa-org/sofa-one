# DeFi research index

These notes record bounded discovery and validation evidence, not protocol endorsements or permission to transact. Deployment registries may be mutable; read each note's snapshot date and limitations. The current catalog summary is the [capability matrix](../defi-capability-matrix.md); baseline source provenance is [catalog provenance](simple-catalog-provenance.md). The assembled snapshot is 202 definitions (179 actions, 23 separately grantable approvals) across seven mainnets. Oracle Gate 1 initial attempt 1/3 passed for scoped catalog/source admission and local authorization with no material findings. Both nonblocking provenance-reference alignment notes were resolved; no material re-review was needed. Independent structural scan passed. Backend build and unit validation passed (112 suites, 2,263 tests); one opt-in PostgreSQL suite/test was skipped. This is not runtime identity, financial strategy, liquidity, safety, deployment, transaction success, or funded execution proof; authenticated-browser verification has not been performed.

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
| [Price-feed research](price-feeds.md) | Chainlink USD-feed/sequencer candidates and exact-input price-bound method. |
| [Deployment checks](deployment-checks.md) | Recorded read-only deployment/runtime/getter observations and unavailable checks. |
| [Deployed-source evidence](deployed-source-evidence.md) | Sourcify/source correspondence for selected exact deployments, including Ethereum USDC's ZeppelinOS proxy pattern. |
| [Fork validation plan](fork-validation-plan.md) | Safe local Anvil fork procedure, Calibur path boundaries and assertion recipe. |
| [Fork execution results](fork-execution-results.md) | Recorded local-fork DEX results and unsuccessful/unresolved Aave supply attempt. |
| [Aave revert diagnosis](aave-fork-revert.md) | Source diagnosis of the observed Aave revert selector and required trace reconciliation. |
