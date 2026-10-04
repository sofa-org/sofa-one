# Pendle — v5 source-qualified fixture

Snapshot date: 2026-10-04. Source repository: official `pendle-finance/pendle-core-v2-public` at immutable commit `87685c89d05087535e9b9647eeda0e3d297d1f06`. The repository's `deployments/1-core.json` declares Ethereum Router V3 at `0x888888888889758F76e7103c6CbF23ABbF58F946` and source-owned ActionAddRemoveLiqV3 / ActionMiscV3 facets. The pinned `IPActionAddRemoveLiqV3.sol`, `IPActionMiscV3.sol`, and `IStandardizedYield.sol` interfaces declare the methods below. This source role mapping does not prove current facet installation or runtime implementation state.

The bounded fixture contains six ordinary methods on two Ethereum targets:

| Target role | Signature | Mutability |
| --- | --- | --- |
| Router V3 | `addLiquidityDualSyAndPt(address,address,uint256,uint256,uint256)` | nonpayable |
| Router V3 | `removeLiquidityDualSyAndPt(address,address,uint256,uint256,uint256)` | nonpayable |
| Router V3 | `mintPyFromSy(address,address,uint256,uint256)` | nonpayable |
| Router V3 | `redeemPyToSy(address,address,uint256,uint256)` | nonpayable |
| Standardized Yield | `deposit(address,address,uint256,uint256)` | payable |
| Standardized Yield | `redeem(address,uint256,address,uint256,bool)` | nonpayable |

The four router interfaces and their named uint256 outputs, plus both SY interfaces and outputs, are mirrored in the inactive source snapshot and compared to the fixture by exact chain, target, signature, and canonical ABI hash in tests. The API-only SY target is `0xcad69479358c1ef3560f29f278966df772abf42f`, identified from one active Ethereum market response for market `0x03005432d0f02c46d48ccd859d677d261640e5e1` (expiry 2026-12-10; PT `0x47f4d6505e39998bbabf325def4c4861695ac8f5`; YT `0x7a3d12d8262b0246f4bbf8da354272e73a831a4b`). This is one time-bounded target snapshot, not an exhaustive market population.

IDs are permission-template identities `pendle-v3:v3:1:<lowercase-target>:<operation>`; `v3` does not claim a live implementation version. The source records and builder are fixtures only: no production registry admission, no published grants, and no automatic approval/dependency.

## Scope and limits

Router dual-liquidity entrypoints consume caller-owned SY/PT or LP through protocol-owned flows. PY mint/redeem calls use the caller-selected YT; before expiry, redeeming PY to SY requires the applicable PT/YT position. SY deposit accepts a caller-selected input token; `redeem` exposes the declared `burnFromInternalBalance` boolean. Receiver, market/YT/token, amounts, minimums, and that boolean remain caller-controlled ABI values; the fixture adds no financial caps, token/market allowlists, or ownership policy. Native value is structurally permitted only by SY `deposit`, including when protocol semantics may reject the chosen token/value combination.

External swaps, arbitrary multicalls, zaps, token-input payloads, limit orders, callback executors, and unrelated router/SY methods are excluded. Required underlying/SY/PT/PY/YT/LP approvals are independent permissions, not bundled or automatically coupled; this six-function set alone is not a complete funding path.

Evidence is limited to pinned declared interfaces, official deployment role records, and one official active-market API response. It does not establish current runtime/facet configuration, successful or funded execution, liquidity, or full Pendle markets/chains coverage.
