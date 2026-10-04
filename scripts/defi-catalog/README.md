# Offline DeFi catalog CLI

This CLI validates, deterministically assembles, and generates only repository-owned catalog snapshots. It performs no network/RPC calls and has no configurable output destination. Current package catalog scripts and bare `assemble` select v9; explicit `:v8`, `:v7`, `:v6`, and `:v5` workflows remain available. `prepare-v9` is a strict read-only preview and does not apply admissions or write a catalog/module.

## Accepted v8 integration — Gate 4 attempt 2 PASS (2026-10-05)

V8 assembles one explicitly admitted Enso `routeSingle((uint8,bytes),bytes)` root over immutable v7 (668 definitions / 15 scopes / 67 complete profiles), producing 669 definitions (646 actions, 23 approvals), 16 scopes, and 68 profiles / 395 selected IDs. The root-only literal profile selects only the root, not its three independently grantable children; profiles remain metadata, not grants or a complete workflow. Exact source path/digest, root ABI/identity, and non-null `enso-static-weiroll-v1` scope/hash bind exactly three existing scope-free v7 children. Admission requires matching source path/hash and every root ABI/scope field; there is no generic scoped-family admission route. The raw Enso source snapshot remains inactive; the separate explicit admission makes the generated root active. `prepare-v8` remains read-only and reports the candidate inactive without applying admission. The isolated Enso registry builder is used only by tests and is not imported into production; production receives the root through the generated catalog.

**Gate 4 attempt 1 of 3 failed on sole P1 R1; attempt 2 PASS after R1 closeout.** The decoder now structurally preflights inner command/state counts, offsets, canonical contiguous tails, bounded payloads, and padding before invoking the inner ABI decoder. Durable adversarial tests prove hostile array counts and malformed offsets reject before that decoder. The original 64,516-byte/1,000-state amplification reproduction now rejects in 4.47 ms at approximately 256 MiB process heap, rather than expanding nested arrays (historical attempt-1 measurement: 1,888 ms / approximately 971 MiB RSS). Independent attempt 2 reviewed 16 adversarial cases and passed; it noted a nonblocking durable-coverage improvement opportunity for additional two-element alias/overlap/head/maximum-length variants, not an unresolved authority defect. The generated root retains inherited candidate `inactiveReason` text; this remains non-blocking provenance/copy metadata and was not normalized. Final post-R1 Jest validation passed 184 suites / 2,709 tests, with one opt-in PostgreSQL suite/test skipped; log: `/private/var/folders/d5/bq_4hlms3xb3f03m4w9y582h0000gp/T/opencode/v8-r1-full-jest-final.log`. The skip is not database concurrency proof. Build and default v8, explicit v7/v6/v5, deterministic admission-aware generation and frozen preservation checks passed. No claim of current constructor/runtime identity, funded execution, liquidity, complete workflows, financial safety, all 55 protocols, or 90% market coverage follows.

## Accepted v9 sDAI production integration — Gate 5 attempt 1 PASS

V9 adds exactly four explicit admissions for the no-referral sDAI `deposit`, `mint`, `withdraw`, and `redeem` declarations on Ethereum at `0x83f20f44975d03b1b09e64809b757c47f942beea`. The reviewed source snapshot remains inactive; the fixed admission binds its canonical digest, three declared source references, exact full ABI hashes, selectors, stable IDs and null/null scope pair. These ordinary nonpayable functions do not gain financial caps, paired DAI approval, automatic grants, or a runtime identity/liquidity/funding assertion. The generated catalog and runtime TypeScript module are static artifacts; runtime does not discover source snapshots.

The v9 catalog is assembled over the complete immutable v8 catalog: 673 definitions (650 actions, 23 approvals), 16 unchanged scope hashes, and 69 profiles / 399 unique IDs, including one new four-member sDAI profile. All 669 prior v8 function objects and 68 full profile objects/order/members/fingerprints remain unchanged. Gate 5 attempt 1 passed with zero material findings. Final validation passed 186 suites / 2,725 tests, with one gated PostgreSQL pause-concurrency test skipped because its environment gates were unset; this is not DB proof. Admission and profile selection do not assign grants, establish current runtime identity, prove financial safety or full workflows, or complete the 55-protocol / 90% market objective.

`prepare-v9` remains inactive/read-only and reports the four source candidates without applying admissions. `assemble --input data/defi-catalog/v9/catalog.json` applies only the four explicit reviewed admissions, making the exact four production entries active; there is no automatic family admission. V8/v7/v6/v5 catalog check and generation remain available through fixed explicit selectors.

## Accepted v7 baseline (historical immutable baseline)

The accepted v7 catalog has 668 definitions (645 actions, 23 independent approvals), 15 scopes, and 67 literal profiles / 394 unique selected IDs. It preserves all 640 v6 definitions, all prior scopes, and the complete 62-profile baseline including order/fingerprints, then adds 28 source-qualified methods across five bounded aggregator selections. Gate 3 attempt 2 passed after Oracle code-scope closeout and final read-only validation: 180 suites/2,679 tests passed, with one PostgreSQL pause-concurrency suite/test skipped because `DATABASE_URL` was unavailable (not DB proof). Build, v7 and explicit v6/v5 checks, deterministic admission-aware assembly, production catalog/module byte comparison, and inactive `prepare-v7` checks passed. Profiles remain metadata, not grants; source qualification does not establish runtime identity, liquidity, funded execution, or full workflows. Odos/Kyber opaque executor gaps, existing-protocol literal extensions, 55-protocol support, and 90% market coverage remain unresolved.

## Historical v6 dated snapshot

The v6 source set contains 27 fixed source snapshots with 134 exact function bindings across 35 targets (31 Ethereum, 3 Optimism, 1 BNB). The generated production snapshot has 640 definitions (617 actions, 23 independent approvals) across seven aggregate chain IDs and 15 finite scopes; the 29 appended literal profiles select 134 new identities, for 62 profiles and 366 unique profile members. This preserves the complete 506-definition v5 snapshot and its 33-profile baseline; historical v4 remains 368 definitions / 12 profiles, and the earlier 368-definition / 12-profile engineering baseline is not rewritten. There are 27 of the planned 28 phase-2 source families; Kyber remains unresolved and excluded.

These are dated source/admission and exact-ABI records, not current runtime identity, deployment, liquidity, funded execution, complete workflow, or market-coverage proof. Gate 2 attempt 2 passed after R1 closure and material review; final independent validation passed. Attempt 1's nullable history-scope bypass remains historical and did not affect current generated definitions. Generation or profile metadata does not assign grants. No all-55-protocol or 90% coverage claim follows from these counts.

V5 has a strict `prepare-v5` inactive-candidate preview and exact admitted assembly, both selected by the fixed `data/defi-catalog/v5/assembly-plan.json`. Twenty explicit source files (no glob/self-discovery), each canonical source hash and every selected ABI identity are pinned in `admissions.json`; assembly merges onto immutable v4. Missing/mismatched snapshots, bindings, ABIs, or scope hashes fail closed. `prepare-v5` is read-only and reports candidates without admission. `assemble` writes only v5/catalog.json; v5 generate/check/diff use the same verified snapshot/admission set and fixed production output. This is local staging pending FIRST20 validation/review; it does not deploy or assign grants. Source status cannot self-admit functions.

The fixed FIRST20 cohort is Ambient, Aura, Beefy, Camelot, Convex, DODO, Dolomite, ether.fi, Euler, Fluid, Kelp, LFJ, Maverick, Moonwell, Pendle, QuickSwap, Renzo, Rocket Pool, Silo, and StakeWise. Fluid and Euler each have multiple versioned source families. Preview preserves 368 v4 definitions and returns 138 inactive candidates (506 total); admitted staging adds the same 138 exact methods, with no approvals, yielding 506 definitions and 15 scopes (the prior 14 plus Ambient). Ambient's Ethereum `userCmd(uint16,bytes)` root requires exact `ambient-coldpath-v1` scope/hash bindings and fixed indices; missing, altered, or generic scope use fails closed.

```sh
npm run defi:catalog:assemble
  npm run defi:catalog:prepare-v8
  npm run defi:catalog:prepare-v9
npm run defi:catalog:prepare-v5
npm run defi:catalog:check:v7
npx ts-node --transpile-only scripts/defi-catalog/cli.ts assemble --input data/defi-catalog/v3/catalog.json
npm run defi:catalog:diff
npm run defi:catalog:generate
npm run defi:catalog:check
# Direct historical comparison with the preserved v1 catalog:
npx ts-node --transpile-only scripts/defi-catalog/cli.ts diff --input data/defi-catalog/v1/catalog.json
```

The v3 file retains all 315 v2 definitions unchanged and adds 34 definitions from 69 source ABI records (35 repeat existing NPM definitions); 13 new functions carry explicit, hash-bound finite execution scopes. `generate/check/diff --input ...v3/catalog.json` target the published v3 production fragment and compare its additions against v2. Source/admission facts and execution cautions are recorded in `docs/defi-research/majority-catalog-v3.md`.

For v3, `diff --input data/defi-catalog/v3/catalog.json` compares against the fixed v2 catalog. `generate` writes only the fixed generated production registry file; the source catalog and production file remain separate reviewed artifacts.

The v4 source/admission group remains fixed and explicit for historical reproducibility. `assemble --input
data/defi-catalog/v4/catalog.json` reads exactly the two v4 snapshots and their
admissions, merges onto v3, and writes only `data/defi-catalog/v4/catalog.json`.
It fails closed when source or admission bindings are missing or invalid.
`diff --input data/defi-catalog/v4/catalog.json` compares against v3 and should
report 19 additions with no removals, same-ID authority/ABI changes, or prior
metadata changes. V4 `generate` writes only the fixed production TypeScript
  registry; v4 `check` checks that registry against the selected v4 catalog. The
  package assemble/generate/check/diff commands select v9; explicit `:v8`, `:v7`, `:v6`, and `:v5` workflows remain. Gate 2 attempt 2 and
  final independent validation passed; catalog generation does not
change stored grants or establish deployment/funding/market coverage.

The recognized v4 stable family identities are limited to Curve 3pool,
PancakeSwap V3 Position Manager, and Yearn TokenizedStrategy v3.0.4. Yearn's
six IDs use canonical function-selector suffixes, so overloads remain distinct;
source-version/date/evidence refreshes do not silently rename those IDs. The
19 exact v4 source functions have explicit offline source/ABI admissions; only the
PancakeSwap `multicall(bytes[])` binding has an execution scope, fixed to its
eight same-target admitted children. This does not create automatic dependencies
or grants.

`--input` accepts only `data/defi-catalog/vN/catalog.json` paths resolving inside the repository's `data/defi-catalog/` source tree. Absolute paths, traversal, URLs, unknown flags, and output-path overrides are rejected. Current package assemble/generate/check/diff commands select v9; explicit `:v8`, `:v7`, `:v6`, and `:v5` workflows remain separately selectable. V9 pins one source digest and four exact scope-free ABI identities over v8; v8 pins the Enso root and mandatory scope over v7; v7 preserves the 640-definition v6 baseline and adds 28 ordinary methods. Runtime imports only the generated TypeScript module, not source files or fixture builders. Existing grants are unchanged; new IDs are not automatically granted. Admission does not prove deployment identity, funded execution, financial safety, or live operation.

Production generation reflects the selected local v9 snapshot. Historical v1-v8 source comparisons remain available through fixed inputs and `diff` mode; explicit versioned workflows preserve historical baselines.

The reproducible v2 catalog retains all 202 v1 definitions unchanged and adds 113 source-qualified function definitions (59 DEX and 54 lending/yield) under new stable IDs. The generated catalog has 315 definitions, zero approvals added, and a diff of 113 added with no removed, authority-changed, ABI-changed, or metadata-changed prior IDs. Admission records source ABI identity only; it is not financial validation, deployment proof, or a change to existing grants.
