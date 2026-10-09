# Vesper production vUSDC deposit and withdraw update

This ordinary update admits exactly two Ethereum capabilities on Vesper's production vUSDC Grow-pool target `0x0c49066c0808ee8c673553b7cbd99bcc9abf113d`:

- `deposit(uint256 amount)` — `vesper-vusdc:v1:1:0x0c49066c0808ee8c673553b7cbd99bcc9abf113d:deposit`
- `withdraw(uint256 shares)` — `vesper-vusdc:v1:1:0x0c49066c0808ee8c673553b7cbd99bcc9abf113d:withdraw`

Both functions are nonpayable with empty outputs. Family/version: `vesper-vusdc` / `vusdc@894defe7`. The inactive source snapshot and explicit plan are under `data/defi-catalog/updates/vesper-vusdc-prod/`.

The immutable baseline is the accepted vaETH catalog at 730 definitions. Baseline raw SHA-256: `2a2edbaf1bbe8bc14e10e423a97709a1bf91815a928eb0131438e279381f7878`; manifest hash: `0xea9c1edbfa17560a11239e6478e9330e76134df753fe841b8d96a770ba99a5ba`. Source canonical SHA-256: `56da4049b77eb9fd18b6d72b5568700617707b52fc17963973611514260ba6ad`.

## Role and exact ABI evidence

The official VesperFi/metadata commit `7334bb44adcce9de3e318e0322218197c932fee0` (2024-12-04), retained as `vesper-metadata.json` SHA-256 `8f2b548013e944bb5c91a692e3cd49d0bfd36d54a1db6778bf0588f8ccc774f1`, identifies this exact address as Ethereum vUSDC, `stage: prod`, type `grow`, with USDC collateral.

Address-bound verified-source inspection on 2026-10-06 identifies `VUSDC.verified.sol` SHA-256 `894defe72c67e4c7271440af7cf18f1754f900bd18f36a5be1fa5dd1bfa3609f`; retained address page `vusdc-prod.html` SHA-256 `0d665bf3a2c299093eb8e6fe176b2ccd58dd8389ecfec4459bd7464580dfa671`. The full ABI carrier SHA-256 is `4167ed702abe5caf41dd4cc98c5b55ed5f653fbfa5e51954fd078a6e2c144a20`. Each selected ABI carrier independently matches exactly one full-ABI entry, including parameter name and `internalType`: `deposit-abi.json` SHA-256 `bea4b91d3c162058d74ddad7a4b3e76092b6e2059f12f2954b906adb57fd4f33`; `withdraw-abi.json` SHA-256 `59eb4544a9098490d5e918fb80b278ee40026aaf78225a5587180d6c7360f319`.

Exact deposit ABI: `deposit(uint256 amount)`, selector `0xb6b55f25`, identity hash `0x4b8d5087f536c653adfbe5bb850747e7d834ad59aa36b4fdbb671f0a4dcc38ba`. Exact withdraw ABI: `withdraw(uint256 shares)`, selector `0x2e1a7d4d`, identity hash `0xedeff682646a16fce72d0397c106942d1bc502ff5fc61027967fd2bf63a97071`. Both are nonpayable with no outputs. No repository deployment record is cited: the retained `VPool.json`/`VPool_Proxy.json` carriers identify the different, prior vUSDC address `0xc1efbee3a8dabd30d1d789138bc6ea43a399c335`, not this production target. The dated address-bound source observation is not proof of present runtime, proxy storage, or initialization.

## Inspected behavior and limits

`deposit(uint256 amount)` is `nonReentrant` and `whenNotPaused`. Its fixed internal path converts the amount, calculates shares from pool supply/value, calls `_beforeMinting` to transfer the pool's configured token from the caller, mints shares to the caller, and emits `Deposit`. Configured controller/reward hooks may update the caller's rewards during minting. The protocol rejects zero at share conversion; this is a protocol condition, not a platform amount restriction. Other amounts remain caller-selected within `uint256` and can fail protocol arithmetic, token allowance/balance, or accounting checks. ERC-20 approval remains separately grantable and is not paired or automatically granted.

`withdraw(uint256 shares)` is `nonReentrant` and `whenNotShutdown`. It rejects zero shares, calls the strategy selected by the pool's configured controller before withdrawal, applies the configured withdrawal fee/collector, calculates collateral from pool valuation, and burns the fee-adjusted shares. If local collateral is insufficient, the fixed configured strategy is asked to withdraw; the final payout is clamped to actual token balance and transferred to the caller. Importantly, this VUSDC source burns the computed shares before that final payout clamp and does **not** proportionally reduce the burned shares when the payout is short. Thus partial strategy liquidity may mean the caller receives less than the computed collateral amount; full redemption is not guaranteed. Controller, strategy, reward, valuation, fee, token, governance, and liquidity behavior may revert or affect outcome. Internal configured calls are protocol dependencies, not wallet-selected targets or extra execution nodes.

The platform adds no amount, recipient, owner, balance, feed, or financial-safety gate. ABI argument `0` is policy-authorized, though protocol source rejects zero deposit/share amounts; `uint256` maximum is also not platform-capped and may fail protocol checks. There is no recipient argument; caller-directed share/payout behavior is protocol behavior, not an added platform recipient restriction. Only these two methods are admitted; combined reward-claim, strategy/admin, and native-ETH helper methods are excluded. Dated source evidence proves neither current runtime/storage identity nor funding, liquidity, execution success, or financial safety. No live or funded execution was performed.
