# M4 Independent Offline Audit

## Current result: source/catalog verification valid; market objective blocked

This fixed-path offline verifier now audits the **explicit production V4 catalog input** and retains the immutable V3 baseline as a separate comparison. Current verification is 368 active functions, 19 new source-qualified function rows, 14 finite scopes, and 12 literal profiles. It preserves the full 349-function V3 catalog and compares the original nine V3 profile records against the immutable fixture at `src/modules/defi/catalog-tooling/__fixtures__/v3-bundle-baseline.json` (fixture SHA-256 `f5f06ce93f46bf2ddf8554da6b9efb7db9b1a8175cd19b40dc69c454f873a607`; source commit `e453acde073554d31d4e1ceb46f429c2191e1dfa`). The current profiles are 94 unique IDs across 12 literal profiles; old profile metadata, memberships, and fingerprints remain identical.

Gate 4 is **FINAL PASS on attempt 3/3**; R1/R2/R3 are closed. Attempt 2/3 was blocked on V3 catalog-addition closure: source/admission rows could be bijective while an actual catalog addition remained unadmitted. The aggregate and admission closure now require zero unadmitted additions and exact V3 addition/source binding; a hash-consistent, unique 69-binding substitution regression verifies that this cannot be masked by valid V4 source checks. Final report fingerprint: `9eb8472b1a99248f0d74629b8f5e95041d03ad5c0101518a7c7b9c25a517b815`. This is an engineering-gate pass only; market coverage remains false, denominator null, and no 90% completion is claimed. Catalog/compiler/runtime/grant/financial scope is unchanged.

It independently reads raw V1/V2/V3/V4 catalog and evidence files, recomputes raw and canonical digests, selectors, ABI hashes and scope hashes, validates V3 and V4 admissions as exact source→admission→catalog bijections (including unique paths and binding identities), and verifies static profile membership/fingerprints against catalog identity. Whole-product support counts distinct canonical active products only when every independently expected chain has unique complete observations/instances and every defined core workflow has an exact nonempty supported claim bound to its required catalog functions. Market denominator closure is a separate evidence decision; once closed, the 90% ratio denominator is distinct active products, not all canonical/inactive products or raw roster rows. Raw-to-canonical count differences require explicit complete crosswalk evidence, never numeric coincidence. The verifier does not import or call catalog generators, coverage adapters/calculators, production registry builders, runtime policy, API, or database code. The current audit report/evidence are `data/defi-coverage/v4/independent-audit.json` and `audit-evidence.json`.

## Independently verified V4 batch

- V4 contains 368 active catalog functions and preserves every prior V3 function object unchanged (349); the 19 additions each match one exact source ABI and one V4 admission binding.
- Two source snapshots are hash-bound to admissions: `ordinary-protocols.json` (Curve 3pool: 4 Ethereum functions; PancakeSwap V3 Position Manager: 9 BNB Chain functions) and `yearn.json` (one historical-version TokenizedStrategy target: 6 Ethereum functions). All 19 source/capability entries match chain, target, signature, ABI hash and catalog ID; date-only `retrievedAtUtc` values are not presented as precise capture times.
- The Curve entries are the exact fixed-array/signed-index, nonpayable functions with empty outputs. PancakeSwap's nine functions are payable; its new `multicall(bytes[])` scope binds exactly eight same-target children, with no recursion or wildcard. Yearn's six nonpayable entries retain both 3- and 4-argument withdraw/redeem overloads.
- Scope count is 14: the prior 13 are unchanged, with one additional PancakeSwap multicall scope. The nine original V3 profiles validate from the pinned fixture; all 12 current profiles independently validate exact membership, chain, function identity, fingerprint and no duplicate members. The three added literal profiles cover only their admitted function IDs; profile preview is not a grant assignment.
- V4 reports three target-scoped function sets (Curve 4, PancakeSwap 9, Yearn 6) as function availability only. It does not promote protocol names into canonical market identities or activity claims and does not call these complete product workflows.

## Market evidence remains separate and incomplete

The raw market roster remains 8,476 source rows with SHA-256 `7fc3a4de44a3eebc1354aa57736cb72b48b21321c766d3c9a31e9eeea47c9b24`. The current known M2 activity capture is `2026-10-03T19:11:22Z`; the old M1 roster capture UTC remains unknown. The independent verifier counts 603 positive 30-day DEX observations across 349 unique raw IDs, but only 3 are mapped to canonical active products. Raw activity IDs are not 349 verified distinct products. The M3 normalized coverage-unit status view is separately reported as 3 active and 3 unresolved IDs, intersection 2, union 4; lineage-only rows are excluded.

At the roster-source-ID level, the unresolved proxy set has 8,472 IDs. Adding distinct unresolved coverage observations `114`, `119`, and `2611` gives an unresolved set of 8,475. Its intersection with the 349 observed positive-DEX source IDs is 348 (346 unresolved proxies plus `119` and `2611`); the union is 8,476 by inclusion-exclusion and is checked against the raw roster. Thus the report's 3/8,475/8,476 fields are not treated as disjoint addition: the report's active value is the mapped canonical-product count, while raw positive activity has 349 source IDs. The independent set cardinalities match the report numerically, but no report formula is reconstructed or used as audit authority. Seven unmatched metric IDs are not extra roster rows.

The synthetic goal tests exercise 10 active products with 9 supported (90%) even when the raw and canonical population count is 100, and a documented deduplication case with 100 raw rows to 90 canonical products. Neither equivalence nor objective closure is inferred from matching counts alone. A closed identity/activity census with zero active products has no coverage denominator and cannot pass vacuously.

Compound V2 source ID 114 remains identity-only; its captured `BORROW_INTEREST` fee method is unqualified as user activity. Six fee response-body digests remain discrepant and are not used to establish active use. Positive 30-day volume supports occurrence inside an enclosing 90-day window, not a 90-day total; zero/missing/unqualified values are unknown, not inactivity. The audit objective stays `false`, `marketDenominator` stays `null`, and fully supported whole-product count remains 0. No roster row, source proxy, or identity was removed to improve a ratio.

The V4 catalog batch is not a market-coverage completion. Product-chain enumerations, identity crosswalks, full core workflows, and product-instance populations are still incomplete. The Yearn record is a historical candidate; the bounded 2026-10-04 00:26Z yDaemon request returned HTTP 200 but did not contain that address, so current membership is unresolved and no retirement conclusion is drawn. No deployment-bytecode/runtime identity, state, liquidity, funded execution, user operation, or financial safety is proven. Existing financial-argument freedoms and independent approvals remain unchanged.

## Reproduction

```sh
# Default follows the explicit production catalog selection: V4.
npx ts-node scripts/defi-coverage/audit-cli.ts
npx ts-node scripts/defi-coverage/audit-cli.ts --check
npx ts-node scripts/defi-coverage/audit-cli.ts --check --assert-goal  # expected exit 2

# Explicit historical V3 baseline mode (349 functions; never auto-selected).
npx ts-node scripts/defi-coverage/audit-cli.ts --catalog-version v3
```

`--catalog-version` accepts only `v3` or `v4`; paths and output paths are fixed. V3 mode emits an explicitly historical 349-function report, not a claim about current production V4. `--as-of YYYY-MM-DDTHH:mm:ssZ` sets a deterministic verifier cutoff; it is not inferred as a provider capture time, and `--check` reuses the artifact's recorded cutoff. No HTTP/RPC, wall-clock reads, database changes, package/dependency changes, or grants are involved. Tests also include a synthetic fully closed 9/10 fixture that proves the generic 90% threshold can pass; it is not current market evidence.
