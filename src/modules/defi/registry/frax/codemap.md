# Frax frxETH v2 fixture

Test-only Catalog/Policy fragment for the documented Ethereum frxETH v2 Minter and sfrxETH vault. It binds three payable minter entrypoints and four exact Sourcify-verified vault methods. The raw candidates remain inactive; the builder is not runtime-wired or automatically granted. Vault exits yield frxETH, not native ETH; present runtime state, liquidity, queue, and funded behavior are not certified. See [source review](../../../../../docs/defi-research/expansion55-frax-v6.md).
