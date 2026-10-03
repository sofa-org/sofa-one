# DeFi capability coverage (simplified function-level model)

**Snapshot: 2026-10-02.** The approved model catalogs exact chain/address/function-selector/fixed-ABI capabilities and requires each API key to receive explicit grants. The assembled catalog has 70 active definitions across seven mainnets: 52 actions and 18 independent ERC-20 `approve` functions. Oracle Gate 1 attempt 3 passed 3/3 after closing user-configured spend-budget findings. This is not deployment/publishing approval or proof of a funded live UserOperation; authenticated browser verification has not been performed.

## Reviewed target inventory

| Family | Exact function surface | Definitions |
|---|---|---:|
| Original Uniswap V3 | `exactInputSingle`, original 8-field tuple (includes deadline), 4 deployments | 4 |
| Uniswap SwapRouter02 | `exactInputSingle`, Router02 7-field tuple (no deadline), 7 deployments | 7 |
| PancakeSwap V3 | `exactInputSingle`, 8-field tuple (includes deadline), BNB Chain | 1 |
| Aave V3 Pool | `supply`, `withdraw`, `borrow`, `repay` on 7 markets | 28 |
| Compound III Comet | `supply(address,uint256)`, `withdraw(address,uint256)` on 3 markets | 6 |
| Morpho Vault V2 | `deposit`, `withdraw`, `redeem` on 2 exact vaults | 6 |
| ERC-20 | `approve(address,uint256)` on 18 exact token addresses | 18 |
| **Total** | **52 actions + 18 approvals; 7 mainnets** | **70** |

Deployment addresses, exact ABI variants, source references, and asset rows are documented in [catalog provenance](defi-research/simple-catalog-provenance.md). In particular, Arbitrum native USDC for Comet and USDC.e used by other entries are distinct. This inventory covers these seven protocol/version groups only; it does not claim coverage of most DeFi protocols. Aerodrome, Curve, Balancer, Lido, Pendle, Yearn, arbitrary pools/vaults, and other functions are not cataloged.

## Grant and transaction semantics

- Grant authority is function-level and exact to chain, address, selector, and fixed ABI. A grant permits caller-chosen ABI arguments: assets, amounts, recipients, native value when the ABI is payable, borrow amount, minimum output, deadline, and other ABI parameters are not constrained by former platform financial caps or action templates. Protocol contracts retain their own revert/validation semantics.
- `approve(address,uint256)` is a separately and explicitly grantable function. Any spender and any `uint256` amount, including `type(uint256).max`, are permitted by this function grant. Approval is not auto-granted with an action, has no required matching action in the same request, and has no automatic cleanup/reset. A grant is not created merely by catalog admission.
- Existing capability IDs remain; their scope is intentionally broader under this approved model. Existing narrow grants do not receive the removed financial guardrails. Owners should review and, if the broader authority is not intended, revoke and explicitly re-grant appropriate capabilities. No schema migration is needed for this model change.
- Dashboard catalog and grant management remain IAM-only; grant edits retain step-up. Public transaction submission remains API-key-only. Default-deny, explicit grants, pause/revocation, live acceptance rechecks, identity, API-key permissions, freezes, session readiness, EOA isolation, generic Calibur atomicity, destination protection, billing, simulation, idempotency, signing-disabled behavior, and user-configured key spend limits remain independent gates.
- Ordinary DeFi calls may still be rejected for destination-protected users or billing-debt policy. These are independent existing checks, not hidden DeFi financial review. Structural transaction limits and the 10-interaction/100-grant limits remain. Broad executors/commands, permit, NFT, and other uncataloged authority are not added; unknown functions remain denied.

## Provenance and validation boundary

Admission provenance means an official address source and corresponding fixed function interface/version/date were identified. It is not a protocol safety audit, liquidity guarantee, implementation/runtime identity proof, or assurance a transaction succeeds. Only the exact cataloged address/function/ABI entries are admitted; no arbitrary deployment with a matching ABI is automatically included. Historical research artifacts and receipts retain their original pre-simplification context and must not be rewritten as evidence for the new model.

Source assembly and validation for this catalog are complete; Oracle Gate 1 attempt 3 passed 3/3. Do not treat this as deployment/publishing approval or a claim of funded live UserOperation success. Authenticated browser verification remains unperformed. See [research index](defi-research/README.md) and [provenance inventory](defi-research/simple-catalog-provenance.md) for source details; historical research links there remain historical evidence.
