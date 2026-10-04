# Liquity V2 WETH branch — v6 candidate

This bounded candidate is preparation only. Raw source functions are inactive; the separate active fragment is a reviewed **test fixture**, not production wiring/admission and not an automatic grant. It does not certify live runtime, funded execution, market population, or complete protocol support.

## Pinned source and target

At official `liquity/bold` commit `d262669ef3c4d37bf0544df3bb2624c07b8a5ee0`, `contracts/addresses/1.json` lists the WETH branch `BorrowerOperations` at `0x372abd1810eaf23cb9d941bbe7596dfb2c46bc65` and `StabilityPool` at `0x5721cbbd64fc7ae3ef44a0a3f9a790a9264cf9bf`. The same address table records WETH collateral and BOLD token metadata; neither token receives an implicit approval capability. The pinned `Interfaces/IBorrowerOperations.sol` and `BorrowerOperations.sol`, plus `Interfaces/IStabilityPool.sol` and `StabilityPool.sol`, ground the ten complete selected ABI entries in `data/defi-catalog/v6/sources/liquity.json`.

## Fixed operation subset

All ten calls are nonpayable with primitive `internalType` matching each Solidity ABI type:

- BorrowerOperations: `openTrove(address _owner,uint256 _ownerIndex,uint256 _collAmount,uint256 _boldAmount,uint256 _upperHint,uint256 _lowerHint,uint256 _annualInterestRate,uint256 _maxUpfrontFee,address _addManager,address _removeManager,address _receiver) returns (uint256)`; `addColl(uint256 _troveId,uint256 _collAmount)`; `withdrawColl(uint256 _troveId,uint256 _amount)`; `withdrawBold(uint256 _troveId,uint256 _amount,uint256 _maxUpfrontFee)`; `repayBold(uint256 _troveId,uint256 _amount)`; `adjustTrove(uint256 _troveId,uint256 _collChange,bool _isCollIncrease,uint256 _boldChange,bool _isDebtIncrease,uint256 _maxUpfrontFee)`; `closeTrove(uint256 _troveId)`.
- StabilityPool: `provideToSP(uint256 _amount,bool _doClaim)`; `withdrawFromSP(uint256 _amount,bool doClaim)`; `claimAllCollGains()`.

All omitted return lists are void. No V1/LUSD method, other collateral branch, batch-manager action, zapper, admin, permit, or general executor is included. IDs use the exact format `liquity-v2:v2-weth:1:<lowercase-target>:<hyphenated-method>`.

## Authority and protocol conditions

ABI-valid amounts, trove IDs, owner/manager/receiver addresses, hints, interest rates, fee limits and flags remain caller-selected. There are no platform amount, asset, owner, oracle, collateral, health-factor, funding, or allowance checks, and no approval pairing. Liquity's own solvency rules, manager rights, oracle state, token allowances and branch conditions remain intrinsic prerequisites.

Stability Pool claim behavior is conditional: `provideToSP`/`withdrawFromSP` with `doClaim=true` claims gains; false can retain/stash gains. `claimAllCollGains` requires an eligible nonzero stashed gain. These declarations do not establish funded availability or guarantee a claimable balance.
