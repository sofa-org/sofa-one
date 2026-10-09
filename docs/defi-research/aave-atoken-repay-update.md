# Aave V3 main-pool aToken repayment update

Inspection date: 2026-10-05. This ordinary data update adds one exact method identity to the existing Ethereum, Optimism, and Base Aave V3 main-pool targets. It is a pinned declaration/body record, not live deployment or financial-state verification.

## Pinned sources

Official Aave Address Book commit `17567521ae51088c85e01a6d8240f18b383bac2f` pins the three `AaveV3{Ethereum,Optimism,Base}.POOL` roles. Official Aave V3 Origin commit `8305565ae342f1773c42cd2e4593f175fe5968a0` pins `src/contracts/interfaces/IPool.sol`, `src/contracts/protocol/pool/Pool.sol`, and `src/contracts/protocol/libraries/logic/BorrowLogic.sol`. Their exact URLs, role addresses, and evidence are recorded in `data/defi-catalog/updates/aave-atoken-repay/sources/aave-v3.json`.

## Selector and behavior

`repayWithATokens(address,uint256,uint256)` has selector `0x2dad97d4`, full ABI hash `0x71271224f317a07c84a48e0f3a9604bcfc9c0045f99457edfea937c25ae0cada`, nonpayable mutability, inputs `asset: address`, `amount: uint256`, `interestRateMode: uint256`, and an unnamed `uint256` output. This is modeled from Solidity declarations, not compiler artifacts.

IPool declares the method at lines 325–329. Pool.sol lines 304–327 call the fixed BorrowLogic path with `_msgSender()` as both user and `onBehalfOf`, setting `useATokens=true`. BorrowLogic lines 133–169 perform protocol reserve/debt/mode/cap/amount validation; lines 183–212 burn the caller's aTokens in this branch without underlying `transferFrom`; lines 214–222 return actual payback. Protocol/collateral checks can affect outcomes. Arguments remain caller-selected and uncapped by this platform, including zero and maximum `uint256`; protocol execution may reject them. No new platform financial/recipient/owner/rate restriction or underlying approval pairing is implied.

## Static catalog result

The generic plan is based on the prior Comet delegated catalog and admits exactly these three ordinary IDs: `aave-v3:v3-origin:{1|10|8453}:{pool}:repay-with-a-tokens`. Source ABI functions remain inactive; exact source- and ABI-bound admissions make them active in generated production. Production is 680 definitions (657 actions, 23 approvals), with the same 16 scopes and 69 profiles / 399 IDs. All 677 prior function objects and all profile objects remain unchanged; the three new IDs are not selected by any profile. Catalog inclusion does not create API-key grants or prove current runtime identity, successful repayment, balances, liquidity, funded execution, complete workflows, or financial safety.
