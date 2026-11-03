# StakeStone StoneVault fixture

An explicit test-only Catalog/Policy fragment for the documented Ethereum StoneVault role. It binds only payable `deposit()` and nonpayable `requestWithdraw(uint256)` / `cancelWithdraw(uint256)` from the target-specific verified ABI. The raw candidate remains inactive; the builder is not runtime-wired or automatically granted. Withdrawal request/cancel are not a complete exit workflow, and no current runtime, liquidity, or funded behavior is certified. See [source review](../../../../../docs/defi-research/expansion55-stakestone-v6.md).
