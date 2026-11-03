# Historical Idle candidate — superseded deployment attribution

**Superseded on 2026-11-01.** The address below is a bZx LoanToken/LoanTokenLogicV4_Chai deployment, not an Idle vault. It was an integrated receipt-token address in the historical Idle configuration; that does not bind the Idle ABI to this target. Both old capability IDs and the standalone fixture have been removed.

The corrected Idle DAI root is `0x3fe7940616e5bc47b0775a0dccf6237893353bb4`. Current proxy/implementation binding, pooled evidence and explicit dispositions are recorded in `data/defi-catalog/sources/partial-interface-one-completion.json`. Replacement IDs require fresh explicit authorization; no custom grant is retargeted. The remaining report is retained only as an audit trail of the rejected historical attribution.

## Exact selection

The inactive raw candidate pins Idle-Labs/idle-contracts commit `70b31e6ef4724e2f6e501ebb49dcc9c759ee2ea6`, the Ethereum iDAI live/proxy address `0x493C57C4763932315A328269E1ADaD09653B9081`, and DAI underlying `0x6B175474E89094C44Da98b954EedeAC495271d0F`. Address evidence is the pinned `migrations/addresses.js`. The selected interface is `contracts/interfaces/IIdleTokenV3_1.sol`; implementation behavior is cross-checked against `contracts/IdleTokenGovernance.sol`.

Two ordinary nonpayable functions are represented:

* `mintIdleToken(uint256,bool,address) returns (uint256)`, capability `idle:v3-1:1:0x493c57c4763932315a328269e1adad09653b9081:mint-idle-token`.
* `redeemIdleToken(uint256) returns (uint256)`, capability `idle:v3-1:1:0x493c57c4763932315a328269e1adad09653b9081:redeem-idle-token`.

The fixture retains parameter names from the pinned interface. In particular, the interface names the second mint argument `_skipRebalance`, while the implementation's corresponding bool is unnamed and unused. This is a documented declaration difference, not evidence of compiled ABI identity.

Mint pulls underlying from the caller and mints Idle tokens to that caller. Redemption burns caller-held Idle tokens, transfers underlying and invokes rewards redemption. Protocol pause state, token allowance, and available liquidity remain intrinsic conditions. The caller retains control of ABI-valid amounts, bool and referral without platform caps, referral restriction or approval pairing.

## Exclusions and status

Only these two user operations are selected. Rebalance/admin functions, `redeemInterestBearingTokens`, emergency routes, permit and other extra methods are excluded. The raw catalog candidate is inactive. The separate active registry builder is explicitly for offline `DefiCatalogService`/`DefiPolicyService` tests; it is not wired into runtime, source admission, a production catalog, or automatic user grants. This evidence does not certify current proxy implementation/code, funded execution, liquidity, or complete Idle coverage.
