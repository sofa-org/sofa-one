# Beefy standard vault source review (Expansion 55, v5 candidate)

## Reviewed source boundary

This is a source-qualified, inactive candidate fixture—not a production-registry admission. It covers exactly two Base (8453) entries observed in the official Beefy vault API on 2026-10-04: `morpho-base-steakhouse-prime-eurc` at `0x01F1A592B0b757B2931bbcCf28227cdC1e892dde` (underlying EURC `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42`) and `aerodrome-weth-lcap` at `0x028baCa249B33d24FC32ac01d6531F6be0061c8E` (underlying LP `0xb8B1a52b1893F3369eDb63aeE516F2e8B7D45A53`). The response identified both as active `STANDARD` vaults and gave their earn contract addresses. The API was fetched 2026-10-04 08:04:36 GMT (HTTP 200, ETag `W/"4c6969-bDJQibIEUED8r3QxK1nbhcqQvis"`). This is mutable metadata, not current runtime-code or implementation verification.

The fixed client reference is [beefy-v2 commit `97385b9a832316d78a4c595319352726d5a322a7`](https://github.com/beefyfinance/beefy-v2/tree/97385b9a832316d78a4c595319352726d5a322a7). Its `StandardVaultType` binds `contractAddress` to `earnContractAddress` and uses `StandardVaultAbi`. That ABI declares exactly four functions: `deposit(uint256)`, `depositAll()`, `withdraw(uint256)`, and `withdrawAll()`. Each is nonpayable and has no outputs. This source/client mapping does not independently prove that either live address implements this ABI.

## Capabilities and limits

The candidate fixture defines eight independent exact grants: those four functions on each of the two addresses. `deposit` takes caller-chosen underlying-asset units; `withdraw` takes caller-chosen vault-share units. `depositAll` acts on the caller's underlying-asset balance; `withdrawAll` acts on the caller's vault-share balance. Amounts are not capped, and no spender, receiver, asset, slippage, liquidity, or outcome restriction is claimed. The underlying token allowance/funding is a separate caller responsibility; this family does not add or imply any approval grant. No generic ERC-4626, multicall, or native-deposit call is inferred.

There is no claim of funded execution, runtime code correspondence, current liquidity, audited safety, or future API status. In particular, these source declarations do not prove a vault's implementation, strategy, withdrawal capacity, or successful redemption. API-key grants remain explicit; fixture inclusion never assigns a grant. Production catalog generation/registration is outside this candidate's scope.

## Evidence

- [Official Beefy vault API](https://api.beefy.finance/vaults), snapshot metadata recorded in `data/defi-catalog/v5/sources/beefy.json`.
- [Pinned official Beefy v2 client](https://github.com/beefyfinance/beefy-v2/tree/97385b9a832316d78a4c595319352726d5a322a7), with the Standard vault ABI/type mapping.
