# DeFi capability coverage (simplified function-level model)

**Snapshot: 2026-10-03.** The model catalogs exact chain/address/function-selector/fixed-ABI capabilities and requires each API key to receive explicit grants. Production assembly contains 108 active definitions across seven mainnets: 88 action functions and 20 separately grantable canonical `approve(address,uint256)` functions. This includes 70 baseline definitions and 38 additions (36 actions, 2 approvals): 14 Aerodrome/Velodrome classic-router calls, 10 PancakeSwap V2 calls, 6 Morpho Blue calls, and 8 Lido calls (6 actions, 2 approvals). Oracle Gate 1 initial attempt 1/3 passed for scoped catalog admission and local authorization, with no material finding or re-review required. This is not deployment/publishing approval or proof of funded live UserOperation execution; authenticated browser verification has not been performed.

## Reviewed target inventory

| Family | Exact function surface | Definitions |
|---|---|---:|
| Original Uniswap V3 | `exactInputSingle`, original 8-field tuple (includes deadline), 4 deployments | 4 |
| Uniswap SwapRouter02 | `exactInputSingle`, Router02 7-field tuple (no deadline), 7 deployments | 7 |
| PancakeSwap V3 | `exactInputSingle`, 8-field tuple (includes deadline), BNB Chain | 1 |
| Aave V3 Pool | `supply`, `withdraw`, `borrow`, `repay` on 7 markets | 28 |
| Compound III Comet | `supply(address,uint256)`, `withdraw(address,uint256)` on 3 markets | 6 |
| Morpho Vault V2 | `deposit`, `withdraw`, `redeem` on 2 exact vaults | 6 |
| Aerodrome classic Router (Base) | 3 swaps and 4 direct LP methods | 7 |
| Velodrome classic Router (Optimism) | 3 swaps and 4 direct LP methods | 7 |
| PancakeSwap V2 Router (BNB Chain) | 6 swaps and 4 direct LP methods | 10 |
| Morpho Blue | `borrow`, `withdraw`, `withdrawCollateral` on Ethereum and Base | 6 |
| Lido actions | `submit`, wstETH `wrap`/`unwrap`; withdrawal requests (`requestWithdrawals`, `requestWithdrawalsWstETH`) and `claimWithdrawals` | 6 |
| ERC-20 approvals | `approve(address,uint256)` on 18 baseline token addresses plus stETH and wstETH | 20 |
| **Total** | **88 actions + 20 independent approvals; 7 mainnets** | **108** |

Baseline deployment addresses, ABI variants, and source references are documented in [catalog provenance](defi-research/simple-catalog-provenance.md); new DEX evidence is in [DEX expansion provenance](defi-research/expansion-dex-provenance.md), and Morpho Blue/Lido evidence is in [lending and staking expansion provenance](defi-research/expansion-lending-staking-provenance.md). Coverage is concrete rather than a claim about “most DeFi”: the catalog supports listed direct swaps/liquidity operations, selected Aave/Compound/Morpho borrow and withdrawal calls, and Lido staking/wrapping plus asynchronous withdrawal requests/claims. Morpho Blue `supply`, `supplyCollateral`, and `repay` callbacks are not cataloged, so those calls do not cover a full position-creation lifecycle. Lido withdrawal claims are asynchronous and depend on protocol finalization, not instant liquidity. Curve, Balancer, Sushi, Spark, Venus, Yearn, Pendle, bridges, derivatives, and other uncataloged protocols/functions remain out of scope.

## Grant and transaction semantics

- Grant authority is function-level and exact to chain, address, selector, and fixed ABI. A grant permits caller-chosen ABI arguments: assets, amounts, recipients, native value when the ABI is payable, borrow amount, minimum output, deadline, and other ABI parameters are not constrained by former platform financial caps or action templates. Protocol contracts retain their own revert/validation semantics.
- `approve(address,uint256)` is a separately and explicitly grantable function. Any spender and any `uint256` amount, including `type(uint256).max`, are permitted by this function grant. Approval is not auto-granted with an action, has no required matching action in the same request, and has no automatic cleanup/reset. A grant is not created merely by catalog admission.
- Existing capability IDs remain; their scope is intentionally broader under this approved model. Existing narrow grants do not receive the removed financial guardrails. Owners should review and, if the broader authority is not intended, revoke and explicitly re-grant appropriate capabilities. No schema migration is needed for this model change.
- Dashboard catalog and grant management remain IAM-only; grant edits retain step-up. Public transaction submission remains API-key-only. Default-deny (new keys receive no catalog grants), explicit grants, live pause and grant/revocation rechecks, identity, API-key permissions, freezes, session readiness, EOA isolation, generic Calibur atomicity, destination protection, billing, simulation, idempotency, and configured spend budgets with existing UTC-period/native-wei accounting remain independent gates. Openfort TEE remains the signing custody boundary; DeFi message/typed-data signing is disabled.
- Ordinary DeFi calls may still be rejected by configured API-key spend budgets, UTC-period accounting, destination protection, or billing-debt policy. These are independent existing controls, not protocol-specific financial caps. Structural transaction limits and the 10-interaction/100-grant limits remain. Broad executors/commands, permit, NFT, and other uncataloged authority are not added; unknown functions remain denied.

## Provenance and validation boundary

Admission provenance means an official address source and corresponding fixed function interface/version/date were identified. It is not a protocol safety audit, liquidity guarantee, implementation/runtime identity proof, or assurance a transaction succeeds. Only the exact cataloged address/function/ABI entries are admitted; no arbitrary deployment with a matching ABI is automatically included. Historical research artifacts and receipts retain their original pre-simplification context and must not be rewritten as evidence for the new model.

Family source admission and local authorization validation are not runtime or execution validation. Oracle Gate 1 initial attempt 1/3 passed for scoped catalog admission and local authorization, with no material finding and no re-review required; the earlier 3/3 attempt covered only the 70-capability baseline. Do not treat catalog admission as deployment/publishing approval, liquidity evidence, or proof of funded live UserOperation success. Authenticated browser verification remains unperformed. See the [research index](defi-research/README.md); historical research links and receipts retain their original scope and meaning.
