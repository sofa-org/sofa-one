# Aave fork revert selector diagnosis

Research date: 2026-10-02. Read-only source/API inspection and local selector computation only; no RPC transaction, fork mutation, file outside this note, or installation.

## Exact match

The reverted transaction in [`fork-execution-results.md`](./fork-execution-results.md) is an Aave Ethereum Pool interaction: Pool proxy `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`, implementation `0x728a138a4823392c2efa55e028d434f526fe03cf`, chain 1 at fork block 26099551. The existing [deployed-source evidence](./deployed-source-evidence.md) establishes the implementation Sourcify `match` and exact primary source match to official `aave-dao/aave-v3-origin` commit [`8305565ae342f1773c42cd2e4593f175fe5968a0`](https://github.com/aave-dao/aave-v3-origin/tree/8305565ae342f1773c42cd2e4593f175fe5968a0). The official [Sourcify PoolInstance record](https://sourcify.dev/server/v2/contract/1/0x728a138a4823392c2efa55e028d434f526fe03cf?fields=all) has the linked-library compilation/source set; `Errors.sol`, `SupplyLogic.sol`, and `ValidationLogic.sol` are present there.

Computed using viem `toFunctionSelector('NotEnoughAvailableUserBalance()')`:

```text
NotEnoughAvailableUserBalance() -> 0x47bc4b2c
```

This matches the observed inner revert selector exactly. The selector is an official Aave source error, not just a 4byte-directory guess: pinned [`Errors.sol`](https://github.com/aave-dao/aave-v3-origin/blob/8305565ae342f1773c42cd2e4593f175fe5968a0/src/contracts/protocol/libraries/helpers/Errors.sol) declares `error NotEnoughAvailableUserBalance(); // 'User cannot withdraw more than the available balance'` (line 36 at this revision). It has **no arguments**.

## Crucial semantic mismatch: this is not an ordinary supply error

The same pinned source gives two call sites:

- [`ValidationLogic.validateWithdraw`](https://github.com/aave-dao/aave-v3-origin/blob/8305565ae342f1773c42cd2e4593f175fe5968a0/src/contracts/protocol/libraries/logic/ValidationLogic.sol): `require(scaledAmount <= scaledUserBalance, Errors.NotEnoughAvailableUserBalance());` This is an attempted withdrawal greater than the caller's scaled aToken position.
- [`LiquidationLogic`](https://github.com/aave-dao/aave-v3-origin/blob/8305565ae342f1773c42cd2e4593f175fe5968a0/src/contracts/protocol/libraries/logic/LiquidationLogic.sol): `require(scaledBalanceWriteOff <= userScaledBalance, Errors.NotEnoughAvailableUserBalance());` This is liquidation accounting attempting to write off more scaled aToken balance than the borrower has.

By contrast pinned [`SupplyLogic.executeSupply`](https://github.com/aave-dao/aave-v3-origin/blob/8305565ae342f1773c42cd2e4593f175fe5968a0/src/contracts/protocol/libraries/logic/SupplyLogic.sol) calls `ValidationLogic.validateSupply`; that function checks nonzero amount, reserve active/not-paused/not-frozen, valid `onBehalfOf`, and supply cap. It does **not** emit `NotEnoughAvailableUserBalance`. An ordinary Aave `supply(asset,amount,onBehalfOf,referralCode)` cannot reach `validateWithdraw` or liquidation. Thus the selector match diagnoses the error vocabulary, but it does **not** support the claim that this was the supply call's normal failure condition. Something about actual trace path/call data must be reconciled before retry. Do not paper over it by changing supply amount/cap state or force-enabling the reserve.

## Read-only diagnostics for fork fixer

The run result reports only the inner selector, not the exact failing trace frame. Read the existing local-only tx hash receipt and `debug_traceTransaction` call tree, preserving outer/inner frames and each frame's `to`, `input`, `output`, and error. Confirm which exact nested frame returns `0x47bc4b2c` and whether it is actually Aave Pool -> linked SupplyLogic/ValidationLogic, a token, or another call. Decode the recorded root `execute(BatchedCall)` input with the exact tuple ABI and enumerate each `(to,value,data)` selector/order; compare against intended `USDC.approve(AavePool,N)`, `Pool.supply(USDC,N,owner,0)`, `USDC.approve(AavePool,0)`. Separately inspect Aave Pool call selector: `supply(address,uint256,address,uint16)` is `0x617ba037`; `withdraw(address,uint256,address)` is `0x69328dec`. Confirm the Pool sees the intended asset, amount, beneficiary, referral, and `msg.sender` (owner). These are local-fork reads only.

At the same fork state/block, use `eth_call` simulations individually (no sends) against each intended call to identify the first isolated failure. Read owner `USDC.balanceOf`, `allowance(owner,pool)`, aToken `balanceOf(owner)`, Pool `getReserveData(USDC)` and reserve configuration/paused/frozen/active/supply-cap flags, and source/local Pool implementation + linked-library addresses/code. A direct `Pool.supply` eth_call from owner should succeed if the intended conditions are correct; if it instead returns this error, capture target and trace because that is inconsistent with the pinned normal supply path. For the Calibur-batched version, approvals execute with `msg.sender=Calibur owner` and the target `Pool.supply` likewise sees that owner. The existing script's outer batch is `revertOnFailure=true`, so any earlier/later failing call rolls back the approvals and supply.

After correcting the proven call/trace discrepancy, rerun only on a fresh local fork at the same pinned state and assert aToken balance rises, no debt balance changes, and final USDC allowance is zero. If the actual failing selector originates from `withdraw` or liquidation, do not count that as a supply test. If USDC reserve state is invalid (paused, frozen, inactive or cap-full), report that exact state and do not mutate reserve/config state to manufacture success; the already-reviewed WETH reserve is a separate candidate fixture only after its own same-block active/liquidity/asset checks.

4byte.directory lookup was used only as cross-reference and independently agrees on the text signature; source declaration plus viem selector calculation are the primary identification evidence.
