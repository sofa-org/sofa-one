# Offline DeFi catalog CLI

This CLI validates, deterministically assembles, and generates only repository-owned catalog snapshots. It performs no network/RPC calls and has no configurable output destination. The package catalog scripts select v4. Direct `cli.ts` use without `--input` retains its historical v1 compatibility default, and explicit v1/v2/v3 inputs remain supported. Bare CLI `assemble` remains v2-compatible; package `defi:catalog:assemble` explicitly selects v4. V3 assembly reads only the frozen workflow-extension source and exact per-function admission/scope bindings, merges onto v2, and writes `data/defi-catalog/v3/catalog.json`:

```sh
npm run defi:catalog:assemble
npx ts-node --transpile-only scripts/defi-catalog/cli.ts assemble --input data/defi-catalog/v3/catalog.json
npm run defi:catalog:diff
npm run defi:catalog:generate
npm run defi:catalog:check
# Direct historical comparison with the preserved v1 catalog:
npx ts-node --transpile-only scripts/defi-catalog/cli.ts diff --input data/defi-catalog/v1/catalog.json
```

The v3 file retains all 315 v2 definitions unchanged and adds 34 definitions from 69 source ABI records (35 repeat existing NPM definitions); 13 new functions carry explicit, hash-bound finite execution scopes. `generate/check/diff --input ...v3/catalog.json` target the published v3 production fragment and compare its additions against v2. Source/admission facts and execution cautions are recorded in `docs/defi-research/majority-catalog-v3.md`.

For v3, `diff --input data/defi-catalog/v3/catalog.json` compares against the fixed v2 catalog. `generate` writes only the fixed generated production registry file; the source catalog and production file remain separate reviewed artifacts.

The v4 source/admission group is fixed and explicit. `assemble --input
data/defi-catalog/v4/catalog.json` reads exactly the two v4 snapshots and their
admissions, merges onto v3, and writes only `data/defi-catalog/v4/catalog.json`.
It fails closed when source or admission bindings are missing or invalid.
`diff --input data/defi-catalog/v4/catalog.json` compares against v3 and should
report 19 additions with no removals, same-ID authority/ABI changes, or prior
metadata changes. V4 `generate` writes only the fixed production TypeScript
registry; v4 `check` checks that registry against the selected v4 catalog. The
package assemble/generate/check/diff commands explicitly select v4. Parent
integration and the final v4 gate remain separate; catalog generation does not
change stored grants or establish deployment/funding/market coverage.

The recognized v4 stable family identities are limited to Curve 3pool,
PancakeSwap V3 Position Manager, and Yearn TokenizedStrategy v3.0.4. Yearn's
six IDs use canonical function-selector suffixes, so overloads remain distinct;
source-version/date/evidence refreshes do not silently rename those IDs. The
19 exact source functions have explicit offline source/ABI admissions; only the
PancakeSwap `multicall(bytes[])` binding has an execution scope, fixed to its
eight same-target admitted children. This does not create automatic dependencies
or grants.

`--input` accepts only `data/defi-catalog/vN/catalog.json` paths resolving inside the repository's `data/defi-catalog/` source tree. Absolute paths, traversal, URLs, unknown flags, and output-path overrides are rejected. Direct CLI use defaults to the v1 input for compatibility. Package assemble/generate/check/diff select v4, while direct v1/v2/v3 inputs and bare v2-compatible assembly remain available. The baseline remains the independent full 202-definition pre-migration fixture at `data/defi-catalog/v1/pre-migration-baseline.json`; every original definition must remain unchanged under its existing ID. V2 assembly strictly validates its frozen DEX and lending/yield inputs; v3 assembly validates its frozen workflow-extension source and hash-bound scopes; v4 assembly validates both fixed source snapshots, exact canonical source hashes, family/chain/target/signature/ABI identities, and the explicit Pancake scope hash. Missing, extra, stale, malformed, or mismatched bindings fail closed. Source status flags alone never activate functions. Production output always targets `src/modules/defi/registry/generated/production-catalog.ts`; generation does not rebind grants or silently upgrade an existing ID. Existing grants are unchanged and new IDs remain denied unless separately granted.

After generating v4, the production registry file reflects v4. Therefore a historical `check --input data/defi-catalog/v3/catalog.json` naturally compares v3 output to the current v4 production file and reports stale; do not present it as a successful current-production check or overwrite production with a historical generation. Use package `defi:catalog:check` for v4. Historical v1/v2/v3 source comparisons remain available through their fixed input paths and `diff` mode.

The reproducible v2 catalog retains all 202 v1 definitions unchanged and adds 113 source-qualified function definitions (59 DEX and 54 lending/yield) under new stable IDs. The generated catalog has 315 definitions, zero approvals added, and a diff of 113 added with no removed, authority-changed, ABI-changed, or metadata-changed prior IDs. Admission records source ABI identity only; it is not financial validation, deployment proof, or a change to existing grants.
