# Rocket Pool registry fixture

This folder defines a source-qualified, inactive fixture for two Ethereum Mainnet Rocket Pool calls: payable `RocketDepositPool.deposit()` and nonpayable `RocketTokenRETH.burn(uint256)`. `buildRocketPoolRegistry` returns the fixture fragment for catalog/policy tests; it is not wired to a runtime registry or grants.

The deployment addresses and evidence snapshot are recorded in `docs/defi-research/expansion55-rocket-pool-v5.md`. Dynamic Rocket Storage lookup is the documented operational pattern; this snapshot does not claim current resolution, runtime-code verification, funded execution, or guaranteed redemption liquidity.
