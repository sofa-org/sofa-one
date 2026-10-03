# Offline DeFi catalog CLI

This CLI validates, deterministically assembles, and generates only repository-owned catalog snapshots. It performs no network/RPC calls and has no configurable output destination. The package catalog scripts select v3. Direct `cli.ts` use without `--input` retains its historical v1 compatibility default, and explicit v1/v2 input paths remain supported. Bare CLI `assemble` remains v2-compatible; package `defi:catalog:assemble` explicitly selects v3. V3 assembly reads only the frozen workflow-extension source and exact per-function admission/scope bindings, merges onto v2, and writes `data/defi-catalog/v3/catalog.json`:

```sh
npm run defi:catalog:assemble
npx ts-node --transpile-only scripts/defi-catalog/cli.ts assemble --input data/defi-catalog/v3/catalog.json
npm run defi:catalog:diff
npm run defi:catalog:generate
npm run defi:catalog:check
# Direct comparison with the preserved v1 catalog:
npx ts-node --transpile-only scripts/defi-catalog/cli.ts diff --input data/defi-catalog/v1/catalog.json
```

The v3 file retains all 315 v2 definitions unchanged and adds 34 definitions from 69 source ABI records (35 repeat existing NPM definitions); 13 new functions carry explicit, hash-bound finite execution scopes. `generate/check/diff --input ...v3/catalog.json` target the published v3 production fragment and compare its additions against v2. Source/admission facts and execution cautions are recorded in `docs/defi-research/majority-catalog-v3.md`.

For v3, `diff --input data/defi-catalog/v3/catalog.json` compares against the fixed v2 catalog. `generate` writes only the fixed generated production registry file; the source catalog and production file remain separate reviewed artifacts.

`--input` accepts only `data/defi-catalog/vN/catalog.json` paths resolving inside the repository's `data/defi-catalog/` source tree. Absolute paths, traversal, URLs, unknown flags, and output-path overrides are rejected. Direct CLI use defaults to the v1 input for compatibility. The package assemble/generate/check/diff scripts explicitly select v3, while direct v1/v2 inputs and bare v2-compatible assembly remain available. The baseline remains the independent full 202-definition pre-migration fixture at `data/defi-catalog/v1/pre-migration-baseline.json`; every original definition, including all metadata, must remain exactly unchanged under its existing ID. V2 assembly strictly validates its frozen DEX and lending/yield inputs and exact admission bindings. V3 assembly strictly validates the frozen workflow extension and binds its canonical source JSON digest plus each family/chain/target/signature/ABI identity; 13 finite execution scopes have separate mandatory scope-hash bindings. Missing, extra, stale, malformed, or mismatched bindings fail closed. Without explicit admissions, source-derived functions remain inactive candidates; source status flags alone never activate them. Production output always targets `src/modules/defi/registry/generated/production-catalog.ts`; generation does not rebind grants or silently upgrade an existing ID. Existing API-key grants are unchanged and new IDs remain denied unless separately granted.

The reproducible v2 catalog retains all 202 v1 definitions unchanged and adds 113 source-qualified function definitions (59 DEX and 54 lending/yield) under new stable IDs. The generated catalog has 315 definitions, zero approvals added, and a diff of 113 added with no removed, authority-changed, ABI-changed, or metadata-changed prior IDs. Admission records source ABI identity only; it is not financial validation, deployment proof, or a change to existing grants.
