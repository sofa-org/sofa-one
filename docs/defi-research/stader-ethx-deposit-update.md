# Stader ETHx StakePoolsManager deposit update

This update adds one unscoped payable Ethereum binding: `deposit(address)` on the documented StaderStakePoolsManager target `0xcf5ea1b38380f6af39068375516daf40ed70d299`. Its stable ID is `stader-ethx-manager:v1:1:0xcf5ea1b38380f6af39068375516daf40ed70d299:deposit`. Only the one-address overload is included; `deposit(address,string)` referral, validator batch deposit, operator/admin, withdrawal, and token methods are not admitted.

The inactive source snapshot and exact plan are in `data/defi-catalog/updates/stader-ethx-deposit/`. Family/version is `stader-ethx-manager` / `staking-pool-manager@6be9f851`. The immutable baseline is the accepted Dinero AutoPxEth catalog, raw SHA-256 `e5e96e7b934043d87f0ae8a72dd68857c11cbfe56656e573b7fa00fa77aafd03`, manifest hash `0xa841dea1554af510617e3d85625c00de5fe1fc9e99c5fa2c8a1bc133ede8c7b8`. Source canonical SHA-256 is `4f6f54ad75ab47428279fcb2a08c231343ce6e018587a781ab3445ec32014ee0`.

## Role, source, and ABI evidence

Official Stader Ethereum smart-contract documentation and the ETHx overview describe the product and manager role. The pinned `stader-labs/ethx` address-registry commit `9d4a9211431d6c0cdf014bd64d3718cba4ce96ab` lists the exact mainnet role/address. Registry publication (2025-12-18) and inspection date (2026-10-06 UTC) are distinct. The retained address-bound Etherscan page associates implementation `0x716df97ebc05ccb2745bf04cd67df75cf2d11ee6`; this dated association does not establish current proxy implementation or storage.

Inspected carrier hashes: `StaderStakePoolsManager.sol` `6be9f851a4e892b276042e07eb8fb07c1e9fb90b025eb75ad3c42f2e8681c084`; `IStaderStakePoolManager.sol` `1a2757856d1a27b8e2895fc489ad3e47a17c9a98f0d51433961a98ac0d24e238`; full ABI `336492de8b46b8ea5c20302eaaa201254ba5dd8b364697b0b8ddfc95e967afb2`; Etherscan HTML `ea70a36059e6462b6331362275438e2553e00e2ab19bb680875025b02d3bef22`; pinned address-registry carrier `63694006b27b1150411432f37efb5922ca92392ad7b546fe2545ab14dae23cc8`.

The exact declaration is `deposit(address _receiver) payable returns (uint256)` with one built-in `address` input and one unnamed built-in `uint256` output. Selector is `0xf340fa01`; full ABI identity hash is `0x42abde06a5110aaf72bf13d8ac24f72c008cc68abb15657c3e1ce24ff971c062`.

## Call behavior and limits

The inspected method uses `msg.value` as the deposit asset, checks the protocol's `maxDeposit()` and `minDeposit()`, obtains shares through `previewDeposit`, and calls `_deposit(msg.sender, _receiver, assets, shares)`. `_deposit` mints the calculated ETHx shares to the caller-selected receiver through the configured ETHx token. Protocol pause, amount bounds, exchange-rate/oracle, configuration, and token/governance state may reject a call.

This is an ordinary payable call: native value is part of the request and continues through the existing wallet-outflow budgeting. The platform adds no separate minimum/maximum amount, receiver, feed, or balance gate, no arbitrary callee/calldata support, no grant, and no approval pairing. Admission does not imply a complete withdrawal workflow, current proxy/storage/configuration, funding, successful execution, or financial safety.
