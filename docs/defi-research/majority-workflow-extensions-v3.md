# M3 workflow-extension source candidates

This source-only snapshot records **34 additional ABI definitions across nine deployment records** (seven Uniswap V3 NPM and two Morpho Blue). The NPM records also repeat the five M2 NPM methods solely to make each family/contract record self-contained; this adds 35 repeated records, not new definitions. The resulting source file has 69 function records total. Retrieved dates are recorded as `2026-10-04` only, not as full UTC retrieval instants.

These are source facts and ABI candidates, **not activation, published capability IDs, grants, runtime support, or a whole-workflow coverage claim**. ABI arguments remain caller-selected under the protocol's native semantics; this snapshot does not add platform financial caps, recipients, approval coupling, or automatic approvals.

## Uniswap V3 NonfungiblePositionManager inherited helpers

The seven per-chain NPM deployments were independently listed on their respective official deployment pages and are repeated here without address propagation:

| Chain | Address | Deployment source |
|---|---|---|
| Ethereum (1) | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` | [Ethereum deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments.md) |
| Base (8453) | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` | [Base deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments.md) |
| Optimism (10) | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` | [Optimism deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-optimism-deployments.md) |
| Arbitrum (42161) | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` | [Arbitrum deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments.md) |
| Polygon (137) | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` | [Polygon deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-polygon-deployments.md) |
| BNB Chain (56) | `0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613` | [BNB deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-bnb-deployments.md) |
| Monad (143) | `0x7197e214c0b767cfb76fb734ab638e2c192f4e53` | [Monad deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-monad-deployments.md) |

Four additional ABI methods are repeated at each target (28 added definitions):

- `refundETH()` — payable; no outputs.
- `unwrapWETH9(uint256 amountMinimum,address recipient)` — payable; no outputs.
- `sweepToken(address token,uint256 amountMinimum,address recipient)` — payable; no outputs.
- `multicall(bytes[] data)` — payable; returns `bytes[] results`.

Source records point to the tagged v1.0.0 `INonfungiblePositionManager`, `PeripheryPayments`, base `Multicall`, `LiquidityManagement`, and `NonfungiblePositionManager` sources. The release tag is a source URL, not a claimed full immutable commit SHA. The source implementation uses delegatecall for multicall, preserves the original caller/value context, has no recursion guard, and reverts the whole outer call if a child fails. `refundETH` can refund ETH to the original sender; `unwrapWETH9` and `sweepToken` act on contract balances and accept caller-specified recipients/minimums. Residual/shared balances therefore require clear user disclosure; these signatures do not establish ownership or asset isolation.

Permit, NFT operator/transfer, pool creation, and other inherited or sibling methods are not included. Any child-by-child authorization, recursion prohibition, or batch composition rule is a separate proposed execution-policy question for M3 review—not encoded or decided by this source artifact.

## Morpho Blue standard market methods

The official Morpho address directory and each chain's explorer source page independently identify the same address:

| Chain | Address | Evidence |
|---|---|---|
| Ethereum (1) | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | [Official address directory](https://docs.morpho.org/get-started/resources/addresses/), [Etherscan source page](https://etherscan.io/address/0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb#code) |
| Base (8453) | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | [Official address directory](https://docs.morpho.org/get-started/resources/addresses/), [Basescan source page](https://basescan.org/address/0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb#code) |

The file records the pinned official `IMorpho.sol`, `Morpho.sol`, and `IMorphoCallbacks.sol` at commit `8e26ca6a8dbc5089edcd67fb576248810fd2870a`. The `MarketParams` tuple fields are `loanToken`, `collateralToken`, `oracle`, and `irm` (all `address`), followed by `lltv` (`uint256`). Three nonpayable methods are recorded on each chain (six definitions): `supply(MarketParams,uint256 assets,uint256 shares,address onBehalf,bytes data)` returning `assetsSupplied`/`sharesSupplied`; `supplyCollateral(MarketParams,uint256 assets,address onBehalf,bytes data)`; and `repay(MarketParams,uint256 assets,uint256 shares,address onBehalf,bytes data)` returning `assetsRepaid`/`sharesRepaid`.

In the pinned implementation, nonempty `data` triggers the corresponding `msg.sender` callback before the token transfer-from; empty data skips that callback branch and uses the standard method path. This repository has no Morpho callback handler. Therefore nonempty callback support is unresolved and must not be represented as currently working or unrestricted. The source signature alone does not establish market existence, valid health, liquidity, execution, or runtime admission. No flash-loan, liquidation, arbitrary delegate-handler, or other Morpho methods are added.

## Review boundary

The source and exact ABI records are suitable for independent source/selector review only. Parent/Oracle review must separately decide any execution policy and later catalog admission. Standard-path caller arguments remain free subject to protocol-native rules. Token approvals remain standalone explicit user grants, never an automatic workflow prerequisite. No live chain, RPC, funded transaction, or runtime code check was performed.
