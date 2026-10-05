# Aave V3 five-chain collateral-toggle update

Inspection date: 2026-10-05. This ordinary catalog update adds one exact selector to five existing Aave V3 main Pool roles. It is based on dated public role records and pinned interface/body sources, not live deployment or financial-state verification.

## Pinned sources

Official Aave Address Book commit `17567521ae51088c85e01a6d8240f18b383bac2f` pins the `AaveV3Ethereum`, `AaveV3Optimism`, `AaveV3Polygon`, `AaveV3Base`, and `AaveV3Arbitrum` `POOL` roles. Official Aave V3 Origin commit `8305565ae342f1773c42cd2e4593f175fe5968a0` pins `src/contracts/interfaces/IPool.sol`, `src/contracts/protocol/pool/Pool.sol`, `src/contracts/protocol/libraries/logic/SupplyLogic.sol`, and `src/contracts/protocol/libraries/logic/ValidationLogic.sol`. Exact URLs, role addresses, and evidence are recorded in `data/defi-catalog/updates/aave-collateral-toggle/sources/aave-v3.json`.

## Selector and fixed protocol behavior

`setUserUseReserveAsCollateral(address,bool)` has selector `0x5a3b74b9`, full ABI hash `0x2294fd1903e82223e42d8d52c96a6e6a704d31eab78d24677917efc6360045ef`, nonpayable mutability, named inputs `asset: address` and `useAsCollateral: bool`, and no outputs. This is modeled from the Solidity declaration, not compiler artifacts.

IPool declares the method at lines 336–337. Pool.sol lines 330–345 pass caller, asset, and bool to fixed `SupplyLogic.executeUseReserveAsCollateral` with configured reserve, user configuration, and oracle context. SupplyLogic.sol lines 240–289 performs the state transition; enabling checks reserve conditions and caller-owned nonzero aToken balance/eligibility, while disabling updates collateral state and validates health factor/LTV. Pinned ValidationLogic contains the relevant reserve, collateral, and health checks. Protocol configuration and state may reject a requested operation. The interface has no recipient, callback, caller-chosen callee, or arbitrary calldata. Asset and bool remain caller-selected with no platform-specific constraints; this catalog does not establish that either choice will succeed or is financially safe.

## Static catalog result

The generic update is based on the prior accepted Aave Arbitrum/Polygon catalog and admits exactly five IDs, one for each existing main Pool role on chain IDs 1, 10, 137, 8453, and 42161. Each source function and contract is marked inactive; exact plan-bound admissions alone make the identities active in generated production. Production becomes 687 definitions (664 actions, 23 approvals), preserving 16 scopes and 69 profiles / 399 IDs. All prior 682 full function objects and profile objects remain unchanged; none of the five IDs is selected in a profile. Catalog inclusion does not assign API-key grants or prove current runtime identity, successful protocol acceptance, balance, liquidity, funded execution, complete workflows, or financial safety.
