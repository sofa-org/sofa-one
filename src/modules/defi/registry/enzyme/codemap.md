# Enzyme Comptroller fixture

An explicit test-only Catalog/Policy fragment for the dated Ethereum Comptroller user target. It selects `buyShares`, `redeemSharesInKind`, and `redeemSharesForSpecificAssets` from the pinned SDK ABI. The raw candidate remains inactive; the builder is not runtime-wired or automatically granted. One historical fund-creation event does not prove current open purchases, all-fund coverage, runtime state, or liquidity. See [source review](../../../../../docs/defi-research/expansion55-enzyme-v6.md).
