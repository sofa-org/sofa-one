# Expansion token approvals

Adds three exact, independently grantable ERC-20 `approve(address,uint256)` capabilities: DAI on Ethereum and BTCB/ETH on BNB Chain. Each grant permits caller-selected spender and any `uint256`, including zero and maximum; there are no action dependencies, spender/amount restrictions, automatic grants, or approval cleanup.

Addresses are sourced from the pinned provenance artifact and official deployment references. BNB token approval return behavior was not individually runtime-proven; the ABI's standard bool output is metadata only and authorization does not decode it. No underlying relationship is inferred from the Venus vBTC market.
