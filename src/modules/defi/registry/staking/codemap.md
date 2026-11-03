# Staking registry

`buildStakingRegistry()` provides three source-verified Ethereum Lido actions: `submit(address)` and wstETH `wrap(uint256)` / `unwrap(uint256)`. It also exposes independent stETH/wstETH `approve(address,uint256)` capabilities (five definitions total: three actions and two approvals). `buildStakingExitRegistry()` adds three fixed withdrawal-queue request/claim actions. Queue exits are asynchronous and require protocol finalization before claim. Approvals are never automatic; no financial validators or runtime evidence are included.
