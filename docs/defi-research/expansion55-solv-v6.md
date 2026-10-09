# Solv v6 source candidate: Ethereum SolvBTC Router V2

## Target and source roles

Pinned official `solv-finance/SolvBTC` commit `74dd242c676f6934d73767fc8b2d409c25207810`, `deployments/mainnet/SolvBTCRouterV2Proxy.json`, identifies the Ethereum user proxy `0x3d93B9e8F0886358570646dAd9421564C5fE6334` and deployment transaction `0x34cda00dab7e095da8b4945721c5f420e75bf011016685ad21aa842016ceb8c3`. The recorded transaction is in block `21587187` and its Upgraded event names implementation `0xeEdFBda83be3D1ADeB6f5A3D48933A372AcB7C9C`.

The [Etherscan-verified proxy page](https://etherscan.io/address/0x3d93b9e8f0886358570646dad9421564c5fe6334#code) (retrieved HTTP 200) links the separately listed [`SolvBTCRouterV2` implementation/interface](https://etherscan.io/address/0x1d8595e194eaaff37496a9a5f3f509f5eea9c70b#code), which supplies the complete 24-function ABI/source snapshot used for selector fidelity. This dated explorer association is not proof of the proxy storage slot or current runtime implementation. The deployment receipt's `Upgraded` event names a different implementation, `0xeEdFBda83be3D1ADeB6f5A3D48933A372AcB7C9C`. Further, the [pinned Git Router source](https://github.com/solv-finance/SolvBTC/tree/74dd242c676f6934d73767fc8b2d409c25207810) has a three-argument `deposit`; it cannot establish that the selected five-argument deposit belongs to that pinned source generation. Keep the verified explorer ABI carrier, the receipt-named implementation, and pinned Git source as distinct evidence roles; do not infer a same-implementation relationship or assign an invented Git revision to Etherscan source.

The source methods are ordinary external virtual `nonReentrant` functions without `onlyOwner`. Pool-path configuration, SFT slot authorization, currency compatibility, KYC/whitelist, fees, token allowance, and request queue state are intrinsic protocol checks—not platform financial restrictions.

## Selected methods

These three full-ABI declarations are nonpayable:

* `deposit(address targetToken_,address currency_,uint256 currencyAmount_,uint256 minimumTargetTokenAmount_,uint64 expireTime_) returns (uint256 targetTokenAmount_)` → `solv:router-v2:1:0x3d93b9e8f0886358570646dad9421564c5fe6334:deposit`.
* `withdrawRequest(address targetToken_,address currency_,uint256 withdrawAmount_) returns (address,uint256)` with both output names empty → `solv:router-v2:1:0x3d93b9e8f0886358570646dad9421564c5fe6334:withdraw-request`.
* `cancelWithdrawRequest(address targetToken_,address redemption_,uint256 redemptionId_) returns (uint256 targetTokenAmount_)` → `solv:router-v2:1:0x3d93b9e8f0886358570646dad9421564c5fe6334:cancel-withdraw-request`.

All caller-selected assets, amounts, minimums, expiry, redemption references, and IDs remain governed only by their exact ABI types plus protocol checks. No platform owner, asset, amount, recipient, deadline, price/feed, or approval-pairing restrictions are introduced. Independent approvals, including arbitrary spender and maximum amount, are not coupled or automatically granted.

## Limits

Only these three methods are selected. Privileged token mint/burn, bare burn, permit, admin, generic execute, batch methods, and other router operations are excluded. `withdrawRequest` starts an asynchronous request and `cancelWithdrawRequest` cancels it; no settlement/claim completion is included. The candidate is inactive and the separate active builder is isolated to tests. This is not current proxy-implementation verification, liquidity/funded-execution certification, complete SolvBTC lifecycle support, or whole-market coverage.
