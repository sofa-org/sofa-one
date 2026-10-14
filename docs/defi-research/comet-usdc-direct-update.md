# Compound Comet USDC direct production addition

Inspection date: 2026-10-05. This is a source-qualified, parent-approved two-method data update for the existing Ethereum USDC Comet (`0xc3d688b66703497daa19211eedff47f25384cdc3`), not deployment verification.

## Pinned evidence

The official `compound-finance/comet` repository was inspected at commit `f766f51583c23acc33b2a7824654ef2029a96804` (repository tree last-modified 2026-10-02; this must not be mistaken for a publication date). The implementation is `contracts/CometWithExtendedAssetList.sol` (blob `3490e984d133789aa1afe2e8f7e37a11d2512398`), the interface is `contracts/CometMainInterface.sol` (blob `5347b22f73d010017a1162579d1fd8bad13f8328`), and the deployment role record is `deployments/mainnet/usdc/roots.json` (blob `8cdf987c178cd0ba8af8286a4089b70c11bbcf24`). Their pinned GitHub URLs and evidence are captured in the source JSON.

## Selected declarations

Two ordinary, direct selectors are modeled from the Solidity interface declarations, not generated compiler artifacts:

* `supplyTo(address,address,uint256)` — selector `0x4232cd63`; `dst: address`, `asset: address`, `amount: uint256`; nonpayable; no outputs.
* `withdrawTo(address,address,uint256)` — selector `0xc3b35a7e`; `to: address`, `asset: address`, `amount: uint256`; nonpayable; no outputs.

In both cases the caller supplies the recipient, asset, and amount. The implementation passes the caller as the source/account and forwards the chosen destination/recipient into the corresponding internal path (`supplyTo`, implementation lines 718–720; `withdrawTo`, lines 940–942). The shared internal paths enforce pause/permission checks and support the base asset or collateral (lines 737–749 and 959–971). Supplying the base asset can repay negative principal before increasing supply, per protocol semantics. A base-asset withdrawal may borrow according to protocol behavior; this is not represented as a separate borrow selector. These calls do not imply bounded amounts, recipient restrictions, allowance handling, or success guarantees: amounts are caller-selected `uint256` values, and token/protocol behavior may revert or have other effects.

## Scope and limitations

The versioned v9 baseline has the existing Comet contract with supply/withdraw signatures but lacks these direct `supplyTo`/`withdrawTo` selectors. The source snapshot remains inactive; the two exact plan-bound admissions add the definitions to the generated production registry. This does not grant API-key permissions. Do not infer an approval pairing, default grant, new profile, adapter, or workflow from this addition. No current proxy/runtime identity, funded execution, balances, liquidity, full workflow, or financial-safety claim is made.

The first strict generic-source preview identified schema mismatches: each selected source function must itself declare `status: inactive`, and its source references must match the full contract/admission reference set. The source entries now carry that explicit inactive status and all three references (implementation, interface, and USDC mainnet role); the interface-only `sourceId` fields were removed and the plan's canonical source digest was repinned. The corrected plan passed parent-owned preview and temporary CLI lifecycle checks before production assembly.

The versioned v9 snapshot remains 673 definitions (650 actions, 23 approvals), 16 scopes, and 69 profiles. Following explicit parent approval and exact plan assembly, the generated production registry contains 675 definitions (652 actions, 23 approvals); scopes and profiles remain 16 and 69. Final joined validation passed: 191 suites / 2,765 tests passed with one gated PostgreSQL suite/test skipped (not database proof), build and default/historical catalog checks passed, and deterministic assembly preserved every v9 function and profile. No DB, RPC, funded, on-chain, or runtime-identity validation was performed. This exact data update does not make the broader 55-protocol or 90%-coverage objective complete.
