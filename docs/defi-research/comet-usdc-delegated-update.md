# Compound Comet USDC delegated selectors

Inspection date: 2026-10-05. This source-qualified ordinary-method update records two additional ABI declarations for Ethereum Comet USDC at `0xc3d688b66703497daa19211eedff47f25384cdc3`. It does not certify deployed/runtime identity or financial state.

## Pinned source evidence

The official `compound-finance/comet` source is pinned at commit `f766f51583c23acc33b2a7824654ef2029a96804`: implementation `contracts/CometWithExtendedAssetList.sol` (blob `3490e984d133789aa1afe2e8f7e37a11d2512396`), interface `contracts/CometMainInterface.sol` (blob `5347b22f73d010017a1162579d1fd8bad13f8328`), and the `deployments/mainnet/usdc/roots.json` role record (blob `8cdf987c178cd0ba8af8286a4089b70c11bbcf24`). Exact pinned URLs, source refs, and inactive ABI entries are in `data/defi-catalog/updates/comet-usdc-delegated/sources/compound-comet.json`.

## Declarations and semantics

* `supplyFrom(address,address,address,uint256)` — selector `0x90323177`; `from`, `dst`, `asset`, `amount`; nonpayable, no outputs; full ABI hash `0x2020844e720825b6535b604bbce504a6c09b7559bebcaea5e59ffdeab1bd06c8`.
* `withdrawFrom(address,address,address,uint256)` — selector `0x26441318`; `src`, `to`, `asset`, `amount`; nonpayable, no outputs; full ABI hash `0x0348abeab1659c7f632296771445107e1f2ef6f40085865cf627fca8c21c5462`.

These identities are modeled from Solidity declarations, not compiler output. In the pinned implementation, `supplyFrom` passes caller identity and selected arguments to `supplyInternal` (lines 729–731); `withdrawFrom` similarly calls `withdrawInternal` (951–953). Shared internal paths enforce pause and `hasPermission(from|src,msg.sender)` and use fixed base-asset/collateral branches (737–749, 959–971). A separate Comet delegation may be required; this platform catalog does not create it or impose a self/from/src constraint. Arguments remain caller-selected and are not financially capped here. Protocol checks/reverts remain, and base-asset withdrawals may borrow. This does not prove delegation state, current proxy/runtime identity, liquidity, funded execution, complete workflows, or financial safety.

## Static catalog result

The versioned v9 catalog remains unchanged at 673 definitions. The current pinned generic update is based on the prior saved Comet-direct catalog and adds only these two ordinary selectors; the generated production registry is 677 definitions (654 actions, 23 approvals), with 16 unchanged scopes and 69 unchanged profiles / 399 selected IDs. Both source functions remain marked inactive; the two exact plan admissions are the only activations. No profile selection, API-key grant, automatic delegation, approval pairing, financial restriction, runtime behavior, or broader coverage milestone is implied.
