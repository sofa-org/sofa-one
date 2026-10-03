# M3 v3 scoped workflow progress

This report is a deterministic offline projection of the committed v3 candidate catalog and workflow-extension ABI snapshot. It is a target-specific execution-scope/workflow progress report, not a revised market denominator or a whole-product support certificate.

## Scope and current projection

- The direct v3 catalog contains 349 fixed functions: the 315 M2 capability identities/ABIs remain unchanged and 34 new function records are bound to the v3 ABI source snapshot.
- The source-extension snapshot has 69 ABI rows. Thirty-five are repeated M2 NPM rows for self-contained deployment records; they are not new authority.
- Seven exact Uniswap V3 position-manager targets each have nine required function roles: the five existing lifecycle functions plus `refundETH`, `unwrapWETH9`, `sweepToken`, and `multicall`. Each wrapper binds the exact eight current same-chain/same-target child IDs and ABI hashes. Only the finite one-level rule is represented; recursive calls, Permit/NFT operator methods, unknown selectors, and arbitrary target changes are not in the bundle.
- Two Morpho Blue source targets each bind `supply`, `supplyCollateral`, and `repay` to the closed empty-callback-data scope. `data` must be exactly `0x`; nonempty callback behavior remains unsupported. These six target-bound functions are lineage-only progress, not a canonical raw-provider `4025` mapping, market-instance claim, or fee/activity assertion.
- The calculator reports nine complete rows at their exact target scope and seven related NPM rows missing for the still-unenumerated population. Product/instance completeness remains incomplete.

## Frozen market/activity evidence

The normalized v3 input retains the M2 UTC observation time `2026-10-03T19:11:22Z`, all 144 M2 workflow definitions and 59 capability references, the 8,476-row source ledger, 8,472 unresolved proxy rows, seven unmatched metric IDs, and three positively observed canonical products. M2's Compound V2 `BORROW_INTEREST` fee record remains provider financial data with `qualifiesAsUserActivity: false`; no helper/event label requalifies it. The 30-day source metrics are not transformed into 90-day totals.

The v3 report fingerprint currently is `sha256:c3f276857105f6759b1f1734a02176d4a13335fc9133913bbae9092ac39059ea`. Its activity/identity counts match the M2 frozen input; target workflow progress does not promote any market identity or alter activity weights. `objectiveEstablished` remains false. This output is not evidence of all-chain/product workflow completion, liquidity, financial safety, live execution, or funded transactions.

## Reproduction

From repository root:

```sh
npx ts-node scripts/defi-coverage/v3-cli.ts
npx ts-node scripts/defi-coverage/v3-cli.ts --check
```

The command has fixed paths, reads only committed JSON snapshots, and performs no network/RPC calls or clock reads. It writes/checks only the four v3 outputs. M1/M2 input files, raw activity snapshots, crosswalks, catalog compiler inputs, generated catalog files, runtime grants, and permission bundles are not modified.
