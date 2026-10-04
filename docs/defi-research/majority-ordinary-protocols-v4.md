# Ordinary-protocol source snapshot v4

## Scope and status

`data/defi-catalog/v4/sources/ordinary-protocols.json` is a bounded, offline source-evidence snapshot for **two exact contract deployments and 13 function ABIs**: four Curve 3pool StableSwap functions on Ethereum and nine PancakeSwap V3 Position Manager functions on BNB Chain. The snapshot is now explicitly admitted into current v4 under its exact canonical JSON digest and per-function ABI bindings. Pancake's wrapper admission carries the fixed eight-child one-level scope. This remains source/ABI authority only, not deployment/runtime verification, market enumeration, or permission automatically assigned to users/API keys. Yearn is admitted separately under `data/defi-catalog/v4/sources/yearn.json`.

The source document uses the existing v2/v3 shape: `schemaVersion`, `families`, `sources`, `unresolved`; source records have only `sourceId`, `url`, `retrievedAtUtc`, and `evidence`. Retrieval date is 2026-10-04. The live source date/status/byte/hash facts are recorded in evidence strings rather than non-schema fields. All six pinned raw GitHub URLs below returned HTTP 200 on that date. SHA-256 is over the exact retrieved raw bytes.

## Exact admissions proposed for later review

### Curve 3pool StableSwap — Ethereum

- Family: `curve-3pool-stableswap`, source revision label `curve-contract-574f440`.
- Exact target: `0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7`, identified as `swap_address` in the pinned `pooldata.json`; the same source record lists DAI, USDC, and USDT. The pinned Vyper file declares `N_COINS = 3`.
- Four function declarations, all `nonpayable`, with no Vyper return annotation (empty ABI outputs):
  - `add_liquidity(uint256[3],uint256)` — fixed array `amounts`, then `min_mint_amount`.
  - `exchange(int128,int128,uint256,uint256)` — `i`, `j`, `dx`, `min_dy`.
  - `remove_liquidity(uint256,uint256[3])` — `_amount`, fixed array `min_amounts`.
  - `remove_liquidity_one_coin(uint256,int128,uint256)` — `_token_amount`, signed `int128 i`, `min_amount`.
- Other pool methods, including `remove_liquidity_imbalance`, factories, routers, wildcard pools, payable/native functions, and other targets are not in this snapshot. Coin indices, amounts, and minimum outputs remain caller-selected ABI arguments; no protocol-specific financial bounds are asserted.

### PancakeSwap V3 Position Manager — BNB Chain

- Family: `pancakeswap-v3-position-manager`, source revision label `pancake-v3-contracts-9868479`.
- Exact target: chain 56, `0x46A15B0b27311cedF172AB29E4f4766fbE7F4364`, taken from the pinned `deployments/bscMainnet.json` `NonfungiblePositionManager` entry.
- The nine complete ABI objects are mechanically transcribed from the pinned Pancake interfaces and were compared field-for-field (including tuple component names, state mutability, and outputs) against the corresponding nine ABI objects in the frozen v3 Uniswap Position Manager source snapshot. Pancake source URLs—not Uniswap URLs—qualify this Pancake deployment:
  - Position lifecycle: `mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))`, `increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))`, `decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))`, `collect((uint256,address,uint128,uint128))`, and `burn(uint256)`.
  - Helpers: `refundETH()`, `unwrapWETH9(uint256,address)`, and `sweepToken(address,uint256,address)`.
  - Wrapper: `multicall(bytes[])` returning `bytes[]`.
- All nine declarations are `payable`, matching the pinned interfaces and exact copied ABI objects. The Multicall base implementation uses `address(this).delegatecall` for each child and reverts on child failure. This data file does not bind an execution scope; any later admission must explicitly bind the wrapper to the existing finite eight-child set, one level only, excluding recursive/unknown functions and all uncataloged authority. Whole-contract shared ETH/WETH/token balances remain a residual risk; supplied value remains one outer-call value. No separate child budget, financial cap, NFT permit/transfer/operator approval, or automatic funding approval is introduced.

## Retrieved source records

| Source record | Pinned raw URL | HTTP / date / bytes | Raw-body SHA-256 |
|---|---|---:|---|
| `curve-3pool-pooldata-574f440` | [pooldata.json](https://raw.githubusercontent.com/curvefi/curve-contract/574f44027d089de0eac765f5a74ea5ae96aba968/contracts/pools/3pool/pooldata.json) | 200 / 2026-10-04 / 922 | `cdfb2035afbd97181030637cdd60ef12ad4694832d437f7ed8ccf24cde08336f` |
| `curve-3pool-stableswap-vy-574f440` | [StableSwap3Pool.vy](https://raw.githubusercontent.com/curvefi/curve-contract/574f44027d089de0eac765f5a74ea5ae96aba968/contracts/pools/3pool/StableSwap3Pool.vy) | 200 / 2026-10-04 / 25,886 | `03e0bf29ae2fe945a3629b8085062da8f9d9d25957e86001dfc3df68c895f9dc` |
| `pancake-v3-bsc-mainnet-deployments-9868479` | [bscMainnet.json](https://raw.githubusercontent.com/pancakeswap/pancake-v3-contracts/986847948755cba528324d41be19480731c36c2a/deployments/bscMainnet.json) | 200 / 2026-10-04 / 768 | `cd72575c75643cc55e500963b2a94451e64166a84ce15a57412ce9737d48ad05` |
| `pancake-v3-npm-interface-9868479` | [INonfungiblePositionManager.sol](https://raw.githubusercontent.com/pancakeswap/pancake-v3-contracts/986847948755cba528324d41be19480731c36c2a/projects/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol) | 200 / 2026-10-04 / 8,608 | `4511a8f7c847648973554d371d13e7c17bbead601382336e2cb82ef745f55722` |
| `pancake-v3-periphery-payments-9868479` | [IPeripheryPayments.sol](https://raw.githubusercontent.com/pancakeswap/pancake-v3-contracts/986847948755cba528324d41be19480731c36c2a/projects/v3-periphery/contracts/interfaces/IPeripheryPayments.sol) | 200 / 2026-10-04 / 1,506 | `7dc30ff757e09b7ae754dbe36542c7fe416abf2cbda9042b4bf14e3e3ca4caa9` |
| `pancake-v3-multicall-base-9868479` | [Multicall.sol](https://raw.githubusercontent.com/pancakeswap/pancake-v3-contracts/986847948755cba528324d41be19480731c36c2a/projects/v3-periphery/contracts/base/Multicall.sol) | 200 / 2026-10-04 / 964 | `029ad0bcade48ff32da51094a3fb245fd7d8324c4fb4dd20fb4b2614efc9618c` |

## Local structural checks and limitations

The source parser yielded 13 candidates; exact admissions activate those 13 functions in current v4. Canonical ABI parsing accepts Curve's `uint256[3]` fixed arrays and signed `int128` parameters. All 13 `(chain,target,selector)` keys are unique and do not collide with the frozen v3 catalog. Pancake's nine full ABI JSON objects compare exactly to the corresponding v3 source objects; the new Pancake scope is bound to the eight same-target children, not recursively extensible. Production policy tests exercise these new functions. Admission still does not establish deployment/runtime identity, state, liquidity, funded execution, user-operation success, financial safety, or market coverage.

No deployment bytecode/runtime identity, on-chain state, liquidity, pool health, funded execution, user-operation success, financial safety, or market-coverage conclusion is established. The 90% coverage objective remains unchanged and is not claimed. No network calls beyond the six listed public raw source GETs, database access, funded actions, dependency change, or commit were performed.
