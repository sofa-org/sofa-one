# Kelp — v5 source-qualified fixture

Snapshot date: 2026-10-04. The source is the official `Kelp-DAO/LRT-rsETH` repository at immutable commit `3dded885f6f797f5959aff449c3a30c5cbb6ce23`; deployment roles/addresses are taken from its README and function declarations from `contracts/interfaces/ILRTDepositPool.sol` and `contracts/interfaces/ILRTWithdrawalManager.sol`.

The bounded Ethereum Mainnet targets are the documented `LRTDepositPool` proxy `0x036676389e48133B63a802f8635AD39E752D375D` and `LRTWithdrawalManager` proxy `0x62De59c08eB5dAE4b7E6F7a8cAd3006d6965ec16`. The fixture includes only four ordinary entry methods, all with declared empty outputs:

| Target role | Signature | Mutability |
| --- | --- | --- |
| LRTDepositPool | `depositETH(uint256,string)` | payable |
| LRTDepositPool | `depositAsset(address,uint256,uint256,string)` | nonpayable |
| LRTWithdrawalManager | `initiateWithdrawal(address,uint256,string)` | nonpayable |
| LRTWithdrawalManager | `completeWithdrawal(address,string)` | nonpayable |

The exact target/function mapping is immutable in the fixture. IDs use `kelp:v1:1:<lowercase-target>:<deposit-eth|deposit-asset|initiate-withdrawal|complete-withdrawal>`; `v1` identifies this permission template, not a live implementation version. The source JSON is inactive and the registry builder is fixture/test-only. Neither is wired into production admission, and no grants are published or assigned.

## Scope and limitations

`initiateWithdrawal`'s `rsETHUnstaked` is rsETH-denominated, not units of the selected output asset. The caller chooses the supported asset and ABI-valid amount/referral/minimum values; this source qualification does not introduce financial limits, allowlists, price checks, owner filters, or approval coupling. An ERC-20 approval is independent and is not included or inferred.

`completeWithdrawal` is a user-callable later step, conditional on operator unlock, configured delay, and liquidity; it does not promise an instant exit. Source initialization sets an eight-day management delay, but that value is configurable and is not a guaranteed live delay. Operator-only `completeWithdrawalForUser`, queue administration, and unconfirmed `instantWithdrawal` are excluded, as are arbitrary callbacks and permit paths.

The README supplies proxy role/address evidence and the pinned interfaces supply declared function ABI. This does not establish current implementation/runtime code, funded liquidity, successful execution, or all Kelp deployments/chains/markets. It is one exact Ethereum deployment pair and four declared ordinary user entry methods, not whole-protocol coverage.
