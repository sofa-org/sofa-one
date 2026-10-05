# Ankr ETH staking update

This ordinary update adds exactly one unscoped payable Ethereum binding: `stakeAndClaimAethC()` on the documented GlobalPool proxy role at `0x84db6ee82b7cf3b47e8f19270abde5718b936670`. Stable ID: `ankr-eth-global-pool:r46:1:0x84db6ee82b7cf3b47e8f19270abde5718b936670:stake-and-claim-aeth-c`. The deprecated `stake()` alias, standalone claim, unstake/withdraw, validator/admin, and every other function are excluded.

The inactive source snapshot and pinned plan are in `data/defi-catalog/updates/ankr-eth-staking/`. Family/version is `ankr-eth-global-pool` / `global-pool-r46@c3723c49`. Baseline is the accepted Stader catalog: raw SHA-256 `fcba1f520377d1c7c7c6c6105295a5ef6421caa12a789cc2ead68674678853f6`; manifest hash `0x25a5e3e965e09cf2505bb9c6d43ab6afb83827cbdb6cc7669c867fefb6e97e6d`. Source canonical SHA-256 `70005f5cec72d7955e12df295c4aeae897d4e59bd724a2e0f5fa6a957df6c95d`.

## Role, source, and ABI evidence

Pinned official `Ankr-network/ankr-docs` commit `0af3485c25398404e27cef67f58956f01cc9bb79` identifies the Ethereum Mainnet GlobalPool Proxy and `stakeAndClaimAethC()` operation. Documentation pages date to 2026-09-10; carrier inspection was 2026-10-06. The documentation naming ankrETH does not prove the configured token or current proxy/storage state.

Etherscan's dated proxy page associates target `0x84db6ee82b7cf3b47e8f19270abde5718b936670` with implementation `0xecce8778214fd9fe37c141a00cff19853ef5bc4a`. This is an address-bound historical association, not current implementation/runtime/storage proof. The inspected source path is `legacy/contracts/upgrades/GlobalPool_R46.sol` (no Git commit metadata established). Carrier SHA-256 values: `GlobalPool_R46.sol` `c3723c491b75321ca596d9daa39127a027561a84d945c94ecf3452105338f2e8`; full implementation ABI `3cadf93ae204bb935056e644c41ec4b07463d8e8fbfdecdc8bb1ae9e44a6a1e0`; selected ABI `2eb144bee40fd177027034b9c033fb9fcda496e4d147e8f232183d0a9ad660cc`; implementation HTML `605c78bfe627335395e8364e3572685c92ff157a31c338a7382f5dd9372e8ebb`; proxy HTML `2aee535fb8cd6f67fcae207dbd6615a493c115ecbbc50546c8646b9463164279`; `eth-api.mdx` `1a257655ed19c11f76766b8ab30483bd1b28112b61cfdf74a0c8b7a9f2f31bbb`; `staking-smart-contracts.mdx` `20c72506ec9fc2633eeaa035ef52c28894a38c25fe71a3c9f48c4d3a0ebee63d`.

The exact full ABI is `{"type":"function","name":"stakeAndClaimAethC","stateMutability":"payable","inputs":[],"outputs":[]}`. Selector: `0x9fa65c56`; ABI identity hash: `0xe67ba4befa7ee925b266ded353800f70d18c202406d7f9097dc32806a21335e8`.

## Inspected call behavior and limits

The inspected body calls `_stake(msg.sender, msg.value, LockStrategy.Claimable)` and then `claimAETH()`. `_stake` requires positive value, computes shares through the fixed configured `_aethContract.bondsToShares`, mints shares to this pool, and credits the caller's claimable-share balance. `claimAETH` resets that caller credit and transfers shares through the same configured token to `msg.sender`. Pause/non-reentrancy, share computation/mint, empty claim, and token transfer conditions can revert; the source also has a technical service fee (10% of rewards) in its reward accounting.

This zero-argument payable call has no caller-selected recipient or arbitrary callee/calldata. The platform adds no amount, receiver, feed, or balance gate; existing root native-value budgeting remains. Protocol positive-value requirements do not introduce a platform financial limit. Admission does not prove current proxy implementation, configured token, funding, live execution, liquidity, or financial safety.
