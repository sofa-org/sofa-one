# Offline DeFi catalog CLI

This CLI validates, deterministically assembles, and generates only repository-owned catalog snapshots. It performs no network/RPC calls and has no configurable output destination. Package catalog scripts select v6. Direct `cli.ts` use without `--input` retains its historical v1 compatibility default, explicit versioned inputs remain supported, and bare CLI `assemble` remains v2-compatible.

## Current v6 dated snapshot

The v6 source set contains 27 fixed source snapshots with 134 exact function bindings across 35 targets (31 Ethereum, 3 Optimism, 1 BNB). The generated production snapshot has 640 definitions (617 actions, 23 independent approvals) across seven aggregate chain IDs and 15 finite scopes; the 29 appended literal profiles select 134 new identities, for 62 profiles and 366 unique profile members. This preserves the complete 506-definition v5 snapshot and its 33-profile baseline; historical v4 remains 368 definitions / 12 profiles, and the earlier 368-definition / 12-profile engineering baseline is not rewritten. There are 27 of the planned 28 phase-2 source families; Kyber remains unresolved and excluded.

These are dated source/admission and exact-ABI records, not current runtime identity, deployment, liquidity, funded execution, complete workflow, or market-coverage proof. Gate 2 attempt 2 passed after R1 closure and material review; final independent validation passed. Attempt 1's nullable history-scope bypass remains historical and did not affect current generated definitions. Generation or profile metadata does not assign grants. No all-55-protocol or 90% coverage claim follows from these counts.

V5 has a strict `prepare-v5` inactive-candidate preview and exact admitted assembly, both selected by the fixed `data/defi-catalog/v5/assembly-plan.json`. Twenty explicit source files (no glob/self-discovery), each canonical source hash and every selected ABI identity are pinned in `admissions.json`; assembly merges onto immutable v4. Missing/mismatched snapshots, bindings, ABIs, or scope hashes fail closed. `prepare-v5` is read-only and reports candidates without admission. `assemble` writes only v5/catalog.json; v5 generate/check/diff use the same verified snapshot/admission set and fixed production output. This is local staging pending FIRST20 validation/review; it does not deploy or assign grants. Source status cannot self-admit functions.

The fixed FIRST20 cohort is Ambient, Aura, Beefy, Camelot, Convex, DODO, Dolomite, ether.fi, Euler, Fluid, Kelp, LFJ, Maverick, Moonwell, Pendle, QuickSwap, Renzo, Rocket Pool, Silo, and StakeWise. Fluid and Euler each have multiple versioned source families. Preview preserves 368 v4 definitions and returns 138 inactive candidates (506 total); admitted staging adds the same 138 exact methods, with no approvals, yielding 506 definitions and 15 scopes (the prior 14 plus Ambient). Ambient's Ethereum `userCmd(uint16,bytes)` root requires exact `ambient-coldpath-v1` scope/hash bindings and fixed indices; missing, altered, or generic scope use fails closed.

```sh
npm run defi:catalog:assemble
npm run defi:catalog:prepare-v5
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
  package assemble/generate/check/diff commands explicitly selected v5 at that
  staging checkpoint. Current package commands select v6. Gate 2 attempt 2 and
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

`--input` accepts only `data/defi-catalog/vN/catalog.json` paths resolving inside the repository's `data/defi-catalog/` source tree. Absolute paths, traversal, URLs, unknown flags, and output-path overrides are rejected. Direct CLI use defaults to the v1 input for compatibility. Current package assemble/generate/check/diff commands select v6; historical v1-v5 inputs remain separately selectable, and bare v2-compatible assembly remains available. The baseline remains the independent full 202-definition pre-migration fixture, and every old definition is retained exactly in the staged snapshots. V2-v5 historical inputs and their fixed admission validations remain unchanged; v6 validates its 27 fixed source snapshots, canonical hashes, exact family/chain/target/signature/full ABI/capability bindings, and records explicit admissions. Missing, extra, stale, malformed, or mismatched bindings fail closed. Source status flags alone never activate functions. Production output always targets the single repository-owned generated TypeScript module; generation does not rebind grants or silently upgrade an existing ID. Existing grants are unchanged and new IDs remain denied unless separately granted.

After generating v6, the production registry file reflects the selected local v6 snapshot. Historical v1-v5 source comparisons remain available through fixed inputs and `diff` mode; package catalog commands target v6.

The reproducible v2 catalog retains all 202 v1 definitions unchanged and adds 113 source-qualified function definitions (59 DEX and 54 lending/yield) under new stable IDs. The generated catalog has 315 definitions, zero approvals added, and a diff of 113 added with no removed, authority-changed, ABI-changed, or metadata-changed prior IDs. Admission records source ABI identity only; it is not financial validation, deployment proof, or a change to existing grants.
