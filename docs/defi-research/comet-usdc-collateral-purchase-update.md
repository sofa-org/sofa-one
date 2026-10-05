# Compound Comet USDC collateral purchase update

Inspection date: 2026-10-05. This ordinary data update admits one selector on the existing Ethereum Compound Comet USDC target. Pinned declarations and source roles are historical source evidence, not live deployment or execution-state verification.

## Pinned sources

Official `compound-finance/comet` commit `f766f51583c23acc33b2a7824654ef2029a96804` pins:

- `deployments/mainnet/usdc/roots.json` (role record blob `8cdf987c178cd0ba8af8286a4089b70c11bbcf24`), identifying target `0xc3d688b66703497daa19211eedff47f25384cdc3`;
- `contracts/CometMainInterface.sol` (blob `5347b22f73d010017a1162579d1fd8bad13f8328`); and
- `contracts/CometWithExtendedAssetList.sol` (implementation blob `3490e984d133789aa1afe2e8f7e37a11d2512396`).

Exact URLs and source evidence are stored in `data/defi-catalog/updates/comet-usdc-collateral-purchase/sources/compound-comet.json`.

## Selector and fixed behavior

`buyCollateral(address,uint256,uint256,address)` has selector `0xe4e6e779`, ABI hash `0xa6e84436299da494593db33a343545d2fd6c769e10b73bd387a468f0abd013e2`, nonpayable mutability, inputs `asset: address`, `minAmount: uint256`, `baseAmount: uint256`, `recipient: address`, and no outputs. This canonical ABI is modeled from the pinned Solidity declaration, not compiler artifacts.

The pinned implementation's `buyCollateral` body (lines 1122–1141) follows a fixed path: check pause/reserve conditions; transfer `baseAmount` of the configured base token from `msg.sender`; calculate collateral using the configured asset/pricing/discount path; enforce protocol `minAmount` and collateral-reserve checks; and transfer the configured collateral token to the chosen recipient. There is no callback, arbitrary callee, or arbitrary calldata parameter. Asset, minAmount, baseAmount, and recipient remain caller-selected ABI inputs without platform-specific bounds. A base-token approval can be a separate prerequisite; catalog admission does not grant or pair one. Protocol pause, balances, configuration, pricing, slippage, reserves, and token behavior may affect success. No market, liquidity, or financial-safety guarantee follows.

## Static catalog result

The generic plan uses the prior accepted Aave collateral-toggle catalog (687 definitions) and admits exactly `compound-iii:v3-comet:1:0xc3d688b66703497daa19211eedff47f25384cdc3:buy-collateral`. The source function and contract are inactive; one exact source-/ABI-bound admission makes it active in production. Production becomes 688 definitions (665 actions, 23 approvals), preserving 16 scopes and 69 profiles / 399 IDs. All prior 687 function objects and profile objects remain unchanged; the new ID is not selected in a profile. Catalog inclusion does not assign API-key grants or prove current runtime identity, token approval, balance, liquidity, funded execution, successful purchase, or financial safety.
