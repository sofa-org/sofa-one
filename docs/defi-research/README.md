# DeFi research index

These notes record bounded discovery and validation evidence, not protocol endorsements or permission to transact. Deployment registries may be mutable; read each note's snapshot date and limitations. The current capability summary is [the interim capability matrix](../defi-capability-matrix.md). Production assembly has three narrowly active Ethereum USDC/WETH fee-500 definitions; Oracle Gate 1 attempt 3 passed 3/3 for this exact authority set. This does not claim release/deployment or live UserOperation execution. The other 67 definitions are inactive.

| Note | Scope |
|---|---|
| [DEX deployment research](dex.md) | Original Uniswap V3, SwapRouter02 and PancakeSwap V3 candidate deployments and fixed ABI distinctions. |
| [Lending and market research](lending-vaults.md) | Pinned Aave V3 Pool/assets and Compound III USDC Comet market facts and lending semantics. |
| [Vault candidates](vaults.md) | Morpho Vault V2 discovery candidates, mutable API provenance and fixed call shapes. |
| [Price-feed research](price-feeds.md) | Chainlink USD-feed/sequencer candidates and exact-input price-bound method. |
| [Deployment checks](deployment-checks.md) | Recorded read-only deployment/runtime/getter observations and unavailable checks. |
| [Deployed-source evidence](deployed-source-evidence.md) | Sourcify/source correspondence for selected exact deployments, including Ethereum USDC's ZeppelinOS proxy pattern. |
| [Fork validation plan](fork-validation-plan.md) | Safe local Anvil fork procedure, Calibur path boundaries and assertion recipe. |
| [Fork execution results](fork-execution-results.md) | Recorded local-fork DEX results and unsuccessful/unresolved Aave supply attempt. |
| [Aave revert diagnosis](aave-fork-revert.md) | Source diagnosis of the observed Aave revert selector and required trace reconciliation. |
