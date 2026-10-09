# EigenLayer mainnet staking/withdrawal candidate (v6)

Source qualification is pinned to official `Layr-Labs/eigenlayer-contracts` commit `ef8f97992241338cb88335b9d74295e33321b780`. Its `script/configs/mainnet/mainnet-addresses.config.json` identifies `chainId: 1`, deployment block `22434239`, semver `v1.4.1`, StrategyManager proxy `0x858646372CC42E1A627fcE94aa7A7033e7CF075A`, and DelegationManager proxy `0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A`. The separately listed stETH strategy `0x93c4b944D05dfe6df7645A86cd2206016c51564D` is deployment metadata, not a separately granted target. Qualification binds the pinned deployment roles and interfaces; it is not a current proxy-slot/runtime implementation or funded-execution assertion.

The fixture includes exactly these three nonpayable methods, preserving full ABI component names, contract internal types, outputs, and array/tuple structure from pinned `IStrategyManager.sol`, `IDelegationManager.sol`, and `IDelegationManagerTypes`:

| Method | ABI inputs | Output |
| --- | --- | --- |
| `depositIntoStrategy` | `strategy: contract IStrategy`, `token: contract IERC20`, `amount: uint256` | `depositShares: uint256` |
| `queueWithdrawals` | `params: struct IDelegationManagerTypes.QueuedWithdrawalParams[]`, each `(strategies: contract IStrategy[], depositShares: uint256[], __deprecated_withdrawer: address)` | unnamed `bytes32[]` |
| `completeQueuedWithdrawal` | `withdrawal: struct IDelegationManagerTypes.Withdrawal` = `(staker: address, delegatedTo: address, withdrawer: address, nonce: uint256, startBlock: uint32, strategies: contract IStrategy[], scaledShares: uint256[])`; `tokens: contract IERC20[]`; `receiveAsTokens: bool` | none |

All ABI-valid caller-selected strategy/token addresses, amounts, array contents, withdrawal identities and receive mode remain unrestricted by platform caps, ownership or strategy/token allowlists. This does not bypass protocol checks: strategy eligibility, token allowance, queue delay/slashing, and caller/staker/withdrawer requirements at completion remain protocol prerequisites. A successful queue call is not completion; this three-method subset is not a complete workflow certificate or guarantee of eligible strategy population, available liquidity, or funded execution. No separate strategy grant or automatic dependent capability is introduced.

`data/defi-catalog/v6/sources/eigenlayer.json` retains the candidate as inactive. `buildEigenLayerRegistry()` is active only for isolated Catalog/Policy tests, with no production wiring or automatic grants. Stable IDs use `eigenlayer:v1-4-1:1:<lowercase-target>:deposit-into-strategy`, `...:queue-withdrawals`, and `...:complete-queued-withdrawal`.
