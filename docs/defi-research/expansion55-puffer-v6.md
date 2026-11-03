# Puffer v6 candidate — bounded source snapshot

This is a preparation-only, inactive v6 source candidate and a separate explicitly reviewed **active test fixture**. Nothing here is connected to the production registry or automatically granted. Identifiers encode a fixed snapshot; they do not assert that a current proxy still runs this implementation.

## Source binding

The pinned Puffer Deployments-and-ACL table at commit `302c0270f718a7dc20c819419a7dde965e16ce56` lists Ethereum Vault proxy `0xD9A442856C234a39a81a089C06451EBAa4306a72` → implementation `0x3b2fdfdefe919dbcce0bc5ac426097d5523b8afa`, and Withdrawal Manager proxy `0xDdA0483184E75a5579ef9635ED14BacCf9d50283` → implementation `0x98E1d95B4b3A5A082642e17274D67d62691288F1`. Address-specific Sourcify implementation records returned HTTP 200 and `exact_match`: Vault verified 2025-08-21 (`PufferVaultV5.sol`, `IPufferVaultV5.sol`); manager verified 2024-09-26 (`PufferWithdrawalManager.sol`, `IPufferWithdrawalManager.sol`). Selected full ABI entries, including names, outputs and `internalType`, are preserved in the source snapshot. Proxy shell ABI alone is not method authority. The table's published commit is pinned; its referenced source-table commit fields were not retrieved, so no source commit identity is asserted.

## Selected calls

Vault: `deposit(uint256 assets,address receiver)` nonpayable → unnamed `uint256`; `mint(uint256 shares,address receiver)` nonpayable → unnamed `uint256`; `depositETH(address receiver)` payable → unnamed `uint256`; `depositStETH(uint256 stETHSharesAmount,address receiver)` nonpayable → unnamed `uint256`; `withdraw(uint256 assets,address receiver,address owner)` nonpayable → unnamed `uint256`; and `redeem(uint256 shares,address receiver,address owner)` nonpayable → unnamed `uint256`. Manager: `requestWithdrawal(uint128 pufETHAmount,address recipient)` nonpayable → void.

All ABI-valid amount and counterpart arguments remain caller-selected. No owner/caller binding or financial validator is added. Allowances are independent, any-spender and may be max uint; no approval is coupled or auto-granted. Vault fees and daily-liquidity limits are intrinsic protocol conditions, not platform financial validators. No readiness, safety, funded execution, current runtime, or deployment-population claim is made.

The direct V5 `withdraw` and `redeem` methods are selected; they are not disabled legacy V1 methods. Puffer describes asynchronous withdrawal queue/app completion. Source indicates `completeQueuedWithdrawal`/`finalizeWithdrawals` are restricted to a withdrawal-finalizer role. No ordinary-user claim method is established by this bounded evidence, so the fixture does **not** claim a complete exit cycle or expose privileged finalization.

Stable IDs are `puffer:v5-snapshot:1:<lowercase-proxy>:deposit`, `mint`, `deposit-eth`, `deposit-st-eth`, `withdraw`, `redeem`, and `request-withdrawal`. They are exact function permissions, not family wildcards.
