# Aave V3 Arbitrum and Polygon aToken repayment update

Inspection date: 2026-10-05. This bounded ordinary data update adds the already-qualified `repayWithATokens` method to two existing Aave V3 main Pool role targets. It records dated public source roles and a pinned shared declaration/body, not live deployment or financial-state verification.

## Pinned sources

Official Aave Address Book commit `17567521ae51088c85e01a6d8240f18b383bac2f` pins `AaveV3Polygon.POOL` and `AaveV3Arbitrum.POOL`, both at `0x794a61358D6845594F94dc1DB02A252b5b4814aD` on their respective chains. The already-qualified Aave V3 Origin commit `8305565ae342f1773c42cd2e4593f175fe5968a0` pins `IPool.sol`, `Pool.sol`, and `BorrowLogic.sol`. Exact URLs and evidence are recorded in `data/defi-catalog/updates/aave-atoken-repay-arbitrum-polygon/sources/aave-v3.json`.

## Selector and behavior

`repayWithATokens(address,uint256,uint256)` has selector `0x2dad97d4`, ABI hash `0x71271224f317a07c84a48e0f3a9604bcfc9c0045f99457edfea937c25ae0cada`, nonpayable mutability, inputs `asset: address`, `amount: uint256`, `interestRateMode: uint256`, and one unnamed `uint256` output. This ABI is modeled from the pinned Solidity interface declaration, not represented as compiler output.

The fixed Pool path passes the caller as both user and `onBehalfOf` and sets `useATokens=true`; the fixed BorrowLogic validates protocol reserve/debt/rate/cap/amount state, burns the caller's aTokens in that branch rather than calling underlying `transferFrom`, and returns actual payback. Protocol health/collateral and governance-dependent checks can affect outcomes. Asset, amount, and rate mode remain caller-selected with no platform bounds; zero and maximum `uint256` are valid ABI values but protocol execution may reject them. No recipient, owner, amount-cap, rate-only, approval-pairing, or runtime-identity restriction is introduced.

## Static catalog result

The update is based on the prior accepted three-chain Aave catalog and admits exactly two IDs: `aave-v3:v3-origin:137:0x794a61358d6845594f94dc1db02a252b5b4814ad:repay-with-a-tokens` and `aave-v3:v3-origin:42161:0x794a61358d6845594f94dc1db02a252b5b4814ad:repay-with-a-tokens`. Source functions are explicitly inactive; exact plan-bound admissions activate only those identities in generated production. Production is 682 definitions (659 actions, 23 approvals), with 16 unchanged scopes and 69 unchanged profiles / 399 IDs. All prior 680 function objects and profile objects remain unchanged; neither new ID is selected by a profile. Catalog inclusion does not grant keys or establish live runtime identity, successful repayment, balance, liquidity, funded execution, complete workflows, or financial safety.
