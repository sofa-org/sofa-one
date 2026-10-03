# Offline DeFi catalog CLI

This CLI validates, deterministically assembles, and generates only repository-owned catalog snapshots. It performs no network/RPC calls and has no configurable output destination. The package catalog scripts select v2; direct `cli.ts` use without `--input` retains the v1 compatibility default. `assemble` reads only the two fixed v2 source snapshots and their explicit admission bindings, then writes the fixed v2 catalog:

```sh
npm run defi:catalog:assemble
npm run defi:catalog:diff
npm run defi:catalog:generate
npm run defi:catalog:check
# Direct comparison with the preserved v1 catalog:
npx ts-node --transpile-only scripts/defi-catalog/cli.ts diff --input data/defi-catalog/v1/catalog.json
```

`--input` accepts only `data/defi-catalog/vN/catalog.json` paths resolving inside the repository's `data/defi-catalog/` source tree. Absolute paths, traversal, URLs, unknown flags, and output-path overrides are rejected. Direct CLI use defaults to the v1 input for compatibility, while the package generate/check/diff scripts explicitly select v2; checking v1 against the production output after M2 generation is expected to report that output as stale. The baseline remains the independent full 202-definition pre-migration fixture at `data/defi-catalog/v1/pre-migration-baseline.json`; every original definition, including all metadata, must remain exactly unchanged under its existing ID. `assemble` strictly validates the frozen DEX and lending/yield inputs, including chain-scoped unresolved rows; it uses fixed explicit family-ID versions rather than source snapshot dates for new IDs. Each active source function must exactly match a per-function family/chain/target/signature/ABI-hash binding under the canonical source JSON SHA-256 in `data/defi-catalog/v2/admissions.json`. Missing, extra, stale, malformed, or mismatched bindings fail closed. Without admissions, source-derived functions are inactive candidates; source status flags alone never activate them. Production output always targets `src/modules/defi/registry/generated/production-catalog.ts`; generation does not rebind grants or silently upgrade an existing ID. Existing API-key grants are unchanged and new IDs remain denied unless separately granted.

The reproducible v2 catalog retains all 202 v1 definitions unchanged and adds 113 source-qualified function definitions (59 DEX and 54 lending/yield) under new stable IDs. The generated catalog has 315 definitions, zero approvals added, and a diff of 113 added with no removed, authority-changed, ABI-changed, or metadata-changed prior IDs. Admission records source ABI identity only; it is not financial validation, deployment proof, or a change to existing grants.
