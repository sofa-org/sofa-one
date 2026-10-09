# Aave V3 main-pool EMode update

Inspection date: 2026-10-05. This ordinary data update admits one selector on five already-cataloged Aave V3 main Pool roles. Pinned source and role evidence is dated historical qualification, not verification of current proxy, implementation, or storage state.

## Pinned sources

Official `aave-dao/aave-v3-origin` commit `8305565ae342f1773c42cd2e4593f175fe5968a0` pins:

- `src/contracts/interfaces/IPool.sol`, declaration at line 675;
- `src/contracts/protocol/pool/Pool.sol`, routing at lines 754–765;
- `src/contracts/protocol/libraries/logic/SupplyLogic.sol`, transition at lines 304–336; and
- `src/contracts/protocol/libraries/logic/ValidationLogic.sol`, validation at lines 448–498.

Official `aave-dao/aave-address-book` commit `17567521ae51088c85e01a6d8240f18b383bac2f` pins the five chain-specific `AaveV3{Ethereum,Optimism,Polygon,Base,Arbitrum}.POOL` role records. Exact URLs and evidence are in `data/defi-catalog/updates/aave-emode/sources/aave-v3.json`. All code URLs use the full Origin SHA above.

## Selector and behavior

`setUserEMode(uint8)` has selector `0x28530a47`, full modeled ABI hash `0x9b87bec8d6e4c410420fda9eb24b179321649d13d011f932998d03f1a5896cf6`, nonpayable mutability, one `categoryId: uint8` input, and no outputs. It is a declaration model, not a compiler artifact.

The pinned Pool routes `msg.sender` and the category to fixed SupplyLogic. That logic updates the caller's EMode category and runs fixed protocol validation; ValidationLogic checks category-zero or configured-category conditions and the compatibility of the caller's borrowed/collateral assets. The selector has no caller-chosen target, callback, recipient, or arbitrary calldata. Category IDs remain caller-selected across 0–255, with no platform whitelist or asset, debt, balance, oracle, ownership, or health-factor rule. Protocol configuration and validation can reject a call. The policy only recognizes authorized fixed-ABI calldata; it does not promise category availability or successful execution.

## Static catalog result and limits

The plan uses the accepted Comet collateral-purchase catalog (688 definitions) as its exact baseline and admits five chain/role-bound `set-user-e-mode` IDs. Source functions and Pool entries are inactive; exact admissions make them active in production. Production becomes 693 definitions (670 actions, 23 approvals), preserving 16 scopes and 69 profiles / 399 IDs. Prior function objects and profiles remain unchanged, and none of the five IDs is added to a profile or granted automatically.

This does not prove live Pool/proxy/library identity, current EMode category configuration, caller-state compatibility, transaction success, liquidity, funded execution, or financial safety. It adds no approval, profile, execution scope, or platform financial-argument restriction.
