# Lista StakeManager fixture

An explicit test-only Catalog/Policy fragment for the BSC StakeManager role identified by Lista's pinned mainnet-fork test. It binds only `deposit()`, `requestWithdraw(uint256)`, and `claimWithdraw(uint256)`. The raw candidate is inactive; the builder is not runtime-wired or automatically granted. The published fork test upgrades the proxy during setup, so neither it nor the pinned source proves current proxy implementation or funded execution. See [source review](../../../../../docs/defi-research/expansion55-lista-v6.md).
