# StakeWise — v5 source candidate

## Scope and source pin

This inactive candidate is limited to three declared functions on the canonical Ethereum Genesis Vault, `0xAC0F906E433d58FA868F936E8A43230473652885` (chain 1). Official `stakewise/v3-core` is pinned at exact HEAD `fc70cbe1b3d41bc5f78434830d837aa270ca33bc`. The deployment record is `deployments/mainnet.json`; the ABI declarations are `contracts/interfaces/IVaultEthStaking.sol` and `contracts/interfaces/IVaultEnterExit.sol` at that same revision. The source snapshot records the URLs, retrieval date and evidence.

## Declared subset

- `deposit(address receiver,address referrer) payable returns (uint256 shares)`
- `enterExitQueue(uint256 shares,address receiver) returns (uint256 positionTicket)`
- `claimExitedAssets(uint256 positionTicket,uint256 timestamp,uint256 exitQueueIndex)`

ABI-valid receiver, referrer, share, ticket and queue-index/timestamp choices are caller controlled; no platform receiver/owner whitelist, financial cap, approval coupling or extra transfer/approval method is implied. The protocol's intrinsic restriction that the designated receiver claims a queued position is not a platform financial-receiver policy. Exit is asynchronous, not an instant redemption: source qualification does not prove queue readiness, available liquidity, timing, payout, or successful execution. Broader deployments, methods, and claim protocol conditions are not certified here.

The catalog source stays `inactive`. `buildStakeWiseRegistry` is a pure explicit fixture for focused tests only; it is not runtime/module imported, does not publish admission, and does not grant capabilities by default. This evidence is not compiled on-chain bytecode/proxy verification, current liquidity, funded execution, or eligibility proof.
