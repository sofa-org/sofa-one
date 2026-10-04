# Offline DeFi catalog CLI

This CLI validates, deterministically assembles, and generates only repository-owned catalog snapshots. It performs no network/RPC calls and has no configurable output destination. Package catalog scripts select v5. Direct `cli.ts` use without `--input` retains its historical v1 compatibility default, explicit v1/v2/v3/v4 inputs remain supported, and bare CLI `assemble` remains v2-compatible.

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
package assemble/generate/check/diff commands explicitly select v5. Parent
integration and the FIRST20 gate remain separate; catalog generation does not
change stored grants or establish deployment/funding/market coverage.

The recognized v4 stable family identities are limited to Curve 3pool,
PancakeSwap V3 Position Manager, and Yearn TokenizedStrategy v3.0.4. Yearn's
six IDs use canonical function-selector suffixes, so overloads remain distinct;
source-version/date/evidence refreshes do not silently rename those IDs. The
19 exact v4 source functions have explicit offline source/ABI admissions; only the
PancakeSwap `multicall(bytes[])` binding has an execution scope, fixed to its
eight same-target admitted children. This does not create automatic dependencies
or grants.

`--input` accepts only `data/defi-catalog/vN/catalog.json` paths resolving inside the repository's `data/defi-catalog/` source tree. Absolute paths, traversal, URLs, unknown flags, and output-path overrides are rejected. Direct CLI use defaults to the v1 input for compatibility. Package assemble/generate/check/diff select v5, while direct v1/v2/v3/v4 inputs and bare v2-compatible assembly remain available. The baseline remains the independent full 202-definition pre-migration fixture, and every old v4 definition is retained exactly in this staged candidate. V2/v3/v4 historical inputs and their fixed admission validations remain unchanged; v5 validates all twenty fixed source snapshots, canonical hashes, exact family/chain/target/signature/full ABI/capability bindings, and Ambient's scope hash. Missing, extra, stale, malformed, or mismatched bindings fail closed. Source status flags alone never activate functions. Production output always targets the single repository-owned generated TypeScript module; generation does not rebind grants or silently upgrade an existing ID. Existing grants are unchanged and new IDs remain denied unless separately granted.

After generating v5, the production registry file reflects the local staged v5 candidate. Historical v1/v2/v3/v4 source comparisons remain available through fixed inputs and `diff` mode; package catalog commands target v5.

The reproducible v2 catalog retains all 202 v1 definitions unchanged and adds 113 source-qualified function definitions (59 DEX and 54 lending/yield) under new stable IDs. The generated catalog has 315 definitions, zero approvals added, and a diff of 113 added with no removed, authority-changed, ABI-changed, or metadata-changed prior IDs. Admission records source ABI identity only; it is not financial validation, deployment proof, or a change to existing grants.
