# Integral SIZE Ethereum relayer candidate (v6)

This bounded source candidate is pinned to `IntegralHQ/Integral-SIZE-Smart-Contracts` commit `91d8803b1732dfe675e25754332f1078945dcc89`, whose commit timestamp is 2026-10-02 and was observed 2026-10-04. The official [`deployments.json`](https://github.com/IntegralHQ/Integral-SIZE-Smart-Contracts/blob/91d8803b1732dfe675e25754332f1078945dcc89/deployments.json) mainnet `relayerProxy` role is `0xd17b3c9784510E33cD5B87b490E79253BcD81e2E`. It is a pinned source role, not an on-chain deployment block/date, current proxy-implementation proof, or runtime-code certification.

The fixture contains only two payable methods from the pinned [`ITwapRelayer.sol`](https://github.com/IntegralHQ/Integral-SIZE-Smart-Contracts/blob/91d8803b1732dfe675e25754332f1078945dcc89/contracts/interfaces/ITwapRelayer.sol):

| Method | Complete tuple declaration | Return |
| --- | --- | --- |
| `sell` | `sellParams: struct ITwapRelayer.SellParams` = `(address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOutMin,bool wrapUnwrap,address to,uint32 submitDeadline)` | `uint256 orderId` |
| `buy` | `buyParams: struct ITwapRelayer.BuyParams` = `(address tokenIn,address tokenOut,uint256 amountInMax,uint256 amountOut,bool wrapUnwrap,address to,uint32 submitDeadline)` | `uint256 orderId` |

The full ABI tuple field names and primitive `internalType` values are retained. `quoteSell` / `quoteBuy` are view methods and are not transaction capabilities. `rebalanceSellWithOneInch` and router-plus-calldata paths, administrative methods, and any generic execution authority are excluded.

The pinned [`TwapRelayer.sol`](https://github.com/IntegralHQ/Integral-SIZE-Smart-Contracts/blob/91d8803b1732dfe675e25754332f1078945dcc89/contracts/TwapRelayer.sol) routes both submissions through `ITwapDelay(DELAY_ADDRESS).relayerSell(...)` and returns an order ID. A successful authorization or returned ID does not guarantee synchronous output delivery or eventual settlement. The official [SIZE documentation](https://docs.integral.link/size/llms-full.txt) distinguishes a 30-minute TWAP delay from a zero-delay Instant Swap product; this source subset does not establish which downstream execution/settlement timing any specific order will receive, and no single delay is generalized to all calls. Source implementation has protocol-side pair, token-transfer, wrapping, and dynamically calculated delay-gas-prepayment checks; this fixture does not emulate or strengthen them. It adds no queue cancellation, claim, or retry capability.

All ABI-valid token addresses, amounts, minimum/maximum bounds, `to`, `submitDeadline`, `wrapUnwrap`, and native value remain caller-selected without platform-specific caps or owner/feed restrictions. Contract-native WETH/value checks, independent token allowances, protocol fees/prepayment, order processing, and liquidity remain separate prerequisites. Approvals remain independent and are never paired automatically. Stable IDs are `integral:size-relayer-v1:1:<lowercase-proxy>:sell` and `...:buy`.

`data/defi-catalog/v6/sources/integral.json` is an inactive candidate. `buildIntegralSizeRelayerRegistry()` is active only for isolated Catalog/Policy tests; it is not production-wired or a user grant. These two methods are not a complete Integral product/workflow, proof of pair population/current liquidity, codehash or proxy-slot proof, funded execution, or a claim that every order completes.
