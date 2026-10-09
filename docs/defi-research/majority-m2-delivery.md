# M2 source-qualified catalog and coverage status

**Status: M2 Oracle Gate 2 passed on attempt 2/3; R1 is resolved, with no new material risks.** The initial Gate 2 review (attempt 1/3) was blocked on R1, the Compound V2 activity-source mismatch; the focused correction and independent re-review closed that finding. M1 remains committed as `11dc6b8`. Parent M2 local commit is authorized and upcoming; it has not yet been made. Parent will proceed to M3 after that commit. The broader 90% market objective remains unestablished.

## Catalog result

The static production catalog contains **315 active function definitions** across seven aggregate chain IDs: 292 actions and 23 independently grantable approvals. All 202 v1 baseline definitions are unchanged; the 113 additions are source-qualified functions:

| Source family | Exact definitions | Included scope |
|---|---:|---|
| Uniswap V3 NonfungiblePositionManager | 35 | Seven target rows, five lifecycle functions each |
| Balancer V2 Vault | 24 | Six target rows, four fixed swap/pool functions each |
| Aave V3 Pool | 12 | Three additional Pool targets, four lending functions each |
| Compound III Comet | 20 | Ten targets, `supply` and `withdraw` each |
| Compound V2 | 22 | Four CToken markets and Unitroller functions |
| **Added** | **113** | Function definitions, not protocol counts |

The v2 source JSON files are frozen inputs. A source function is active only through an explicit admission binding for the canonical source-file SHA-256 and exact family/version, chain, target, signature, and ABI hash. Without an exact admission, it remains an inactive candidate. The CLI/package workflow is offline and emits a deterministic static catalog; there is no runtime source fetch. Catalog admission is not a grant: no new capability IDs were copied into existing API-key grants, and the 23-approval inventory is unchanged.

These additions preserve caller-selected ABI arguments and the existing authorization model. They add no financial validators, transaction caps, approval pairing, or runtime authorization policy. In particular, Uniswap NPM's five functions are payable; Balancer `exitPool` is nonpayable while its other three admitted functions are payable. Compound V2 returns include protocol error codes, except for the distinct cETH native-value/void-return shapes. Source and ABI correspondence do not establish deployed runtime code, workflow success, liquidity, funded execution, or financial safety.

## Coverage and workflow status

The reconciled [M2 coverage report](../../data/defi-coverage/v2/coverage-report.json) and [normalized input](../../data/defi-coverage/v2/normalized-input.json) are bound to fingerprint `sha256:042fbbb49407776d9e3b257d908f3dbb52045d9a7`; the full [identity ledger](../../data/defi-coverage/v2/identity-crosswalk.json) retains the unchanged M1 raw-roster universe. The final report records three observed-active identities, four mapped canonical identities, one additional partial mapping, 8,472 unresolved proxy rows, and seven unmatched metric IDs. These are source-identity and evidence dispositions, not a canonical market denominator:

- All 8,476 raw roster rows and seven unmatched metric IDs remain retained; 8,472 rows remain unresolved proxy rows. These are not verified distinct products.
- Three observed-active DEX identity bridges (Uniswap V3, SushiSwap Classic V2, and Balancer V2) remain qualified. Four identities are mapped when Compound V2's canonical identity bridge is included; its activity remains unresolved. PancakeSwap V2 is one partial BNB-only bridge, with other expected-chain mappings unknown. The three observations do not imply that only three products are active in the market.
- The reconciled report retains 144 workflow rows and 59 exact function bindings. Those bindings are not 59 complete products or end-to-end workflows.
- The market-coverage objective remains **unestablished**. The unresolved roster rows are proxies, not verified distinct products, and must not be read as evidence that only three products are active or that the real market has no activity.

Positive 30-day DEX observations prove an occurrence within the enclosing 90-day window, not a 90-day total. The captured Compound V2 provider row is labeled `BORROW_INTEREST` and reports USD 86,839, but pinned `fees/compound.ts` revision `1029ba611a85d425d3a022d5f274fd3b9c6a29a0` reads `financialsDailySnapshot.dailyTotalRevenueUSD`. That captured component does not import or call `helpers/compoundV2.ts`, `getAllMarkets`, or `AccrueInterest`; the helper's event calculation is not evidence that the provider query executes it. Retain the provider fee value, but do not count it as eligible Compound V2 activity evidence or promote general fee data to activity. Identity stays bridged; activity is unresolved, not zero or inactive. Unknown, missing, or zero observations do not prove inactivity.

Direct function sources do not close workflow gaps. Token/asset populations, funding, destination-specific paths, and complete product/instance enumeration remain unresolved. NPM refund/unwrap/sweep/funding helpers, broad routers, callbacks, and approval populations are not added by implication. Other unadmitted protocol functions remain outside the catalog. No “all protocols complete” or majority-market-coverage claim is made.

## Validation and boundaries

Parent v2/M1/catalog CLI checks and full build/unit validation passed; the frozen binding/catalog baseline remains valid (117 suites, 2,321 tests; one opt-in PostgreSQL test skipped; 118 suites, 2,322 total). The focused R1 validation passed: four suites, 41 tests, 6.377 seconds. Whole-workspace whitespace checks passed. Independent byte-identity checks confirmed normalized M2 fingerprint `sha256:042fbbb49407776d9e3b257d908f3dbb52045d9a7dac90bf1347e9524f8796a7` and unchanged frozen M1 fingerprint `c3975ec3…af3928`; no head-project metric changed. Gate 2 passed on attempt 2/3 with R1 resolved and no new material risks. Parent owns the authorized local M2 commit and the transition to M3. The final 90% objective remains `objectiveEstablished: false`/unestablished; raw-roster identity, complete population, funding/workflow, callback/native-function gaps remain for later M3/M4 work. The 100-grant ceiling, 10-interaction limit, destination/billing controls, session/EOA policy, and signing-disabled status remain unchanged. No database, funds, dependencies, deployment, UI, or runtime authorization changes are part of this M2 catalog delivery.

See [DEX source evidence](majority-dex-v2.md), [lending/yield source evidence](majority-lending-yield-v2.md), [identity reconciliation](majority-identity-v2.md), [activity evidence](majority-activity-v2.md), [capability matrix](../defi-capability-matrix.md), and [catalog admissions](../../data/defi-catalog/v2/admissions.json).
