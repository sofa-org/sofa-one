# M1 catalog and coverage tooling status

This note describes the implemented static catalog toolchain and the separately staged coverage data. **M1 Oracle Gate 1 passed on attempt 2/3; R1/R2 are closed and no further review is required. Parent integrated validation passed; the parent-owned local milestone commit is pending.** This is not a deployment, execution, or active-market coverage claim. The M1 tooling milestone and the final market-coverage objective are separate.

## Reproducible catalog source

The source-controlled catalog is [`data/defi-catalog/v1/catalog.json`](../../data/defi-catalog/v1/catalog.json), schema version 1. It contains the complete 202-definition catalog hierarchy and complete function metadata/ABI/provenance, pinned to manifest hash `0x43ec3be0b20a32457719d8edb17c8eaa40c93480921d6e7c86e9c2cacdec5897`: 179 action functions and 23 canonical approvals. The independent [`pre-migration-baseline.json`](../../data/defi-catalog/v1/pre-migration-baseline.json) fixture contains the full pre-switch 202-definition hierarchy, not an alias of the generated output. The strict validator checks the fixture hash and full prior-definition preservation; tests also compare the retained pre-generation family builders against all 108 definitions that predate the latest 94 additions.

The pure implementation lives in `src/modules/defi/catalog-tooling/`; its CLI is `scripts/defi-catalog/cli.ts`. From the repository root:

```sh
npm run defi:catalog:generate
npm run defi:catalog:check
npm run defi:catalog:diff
```

Generation is offline and deterministic. It validates the versioned JSON shape, rejects unsupported fields, validates the nested fixed function declarations and provenance with the existing manifest builder, sorts hierarchy consistently, and emits the static TypeScript fragment at `src/modules/defi/registry/generated/production-catalog.ts`. Production assembly uses that generated fragment and still runs the existing `buildReviewedManifest` validation/freezing path. The generated module has a type-only import; runtime catalog loading does not fetch sources or call RPC.

`check` fails if generated output is missing or stale. `diff` reports `added`, `removed`, `authorityChanged`, `abiChanged`, and `metadataChanged` separately. Authority comparison includes capability ID, type, chain, normalized target, function name, signature, ABI/hash, and status. ABI/signature changes are also shown in the compatibility `abiChanged` list. Display/provenance/policy-copy changes remain metadata-only. A changed or added capability never auto-rebinds an existing grant; owners must explicitly review exact capability IDs. No amount, spender, market, price, health-factor, or funding restriction was added by this tooling.

As checked for this M1 snapshot, the pinned input and generated output agree; the diff against the independent pre-migration fixture is empty in all five classes. The exact previous family builders remain only as regression fixtures; they are not dynamically merged into production or used as an auto-grant source.

## Coverage source limits

Coverage calculation is a separate offline tool in `src/modules/defi/coverage-tooling/`, invoked by `scripts/defi-coverage/cli.ts`. The deterministic `scripts/defi-coverage/normalize-baseline.ts` adapter consumes the frozen market snapshot, discovery classification, workflow baseline, and reviewed production manifest; it writes [`normalized-baseline.json`](../../data/defi-coverage/normalized-baseline.json), [`coverage-baseline-report.json`](../../data/defi-coverage/coverage-baseline-report.json), and [`normalization-evidence.json`](../../data/defi-coverage/normalization-evidence.json). `--check` recomputes and byte-compares all three. This is offline source/manifest normalization, not market discovery or proof that the source roster is complete. The workflow file is an independently sourced seed of 16 product candidates and 35 core-workflow records, not a market shortlist or active-product denominator; it records 172 product-assigned capability IDs plus seven Velodrome IDs at an observed but version-unassigned target. Whole-product completeness remains false/unknown where population or workflow evidence is missing.

The independent public discovery snapshot contains 8,476 raw roster rows. Its classification records 3,497 rows with a listed/matched target chain, 1,281 with unknown chain identity, and 3,698 with no target-chain evidence; the metric scrape has 1,324 metric IDs (1,317 roster matches, 7 unmatched), 2,159 positive 30-day observations, and 872 zero 30-day observations. These are not canonical products or proof of the frozen 90-day active denominator: UTC capture time is unknown, chain/product/category mappings are incomplete, and a 30-day zero is not 90-day inactivity. Capture is recorded as `observedAt: null`; the parent's artifact-existence check at `2026-10-03T16:59:58Z` is only an upper bound on file existence, not the source/API retrieval time. The local reported date `2026-10-04` is not converted to UTC.

The normalized report currently records zero positively evidenced canonical active-product rows, `observedActiveCoverageBps: null`, 8,476 unresolved raw-roster proxy records in conservative accounting, and `objectiveEstablished: false`. The zero does **not** mean that no active products exist; the 8,476 proxy rows are **not verified distinct protocols/products**. They remain unresolved rather than being silently excluded or treated as known active/inactive products. The normalized report has 57 workflow rows: 50 complete at mapped evidence scope and 7 unresolved/source-blocked, not 57 complete products. Its current fingerprint is `c3975ec3b6d45299318c84828d30b19c44b6a93aa4dd4364b8fb9adad0af3928`. Parent validation passed the backend build, 116 suites/2,308 tests (one opt-in PostgreSQL test skipped), structural scan, catalog check/diff, and byte-identical normalize/check replay. The final market-coverage objective remains unestablished; this is not a claim of no active products, verified unique proxy products, deployment, or funded execution.

## Gate and safety status

The earlier protocol-expansion/source-admission Oracle review concerns the catalog contents and remains distinct from the M1 reproducibility/coverage review. M1 Gate 1 passed on attempt 2/3 after R1/R2 closure; parent owns the pending local milestone commit. No final denominator, majority-coverage result, grant change, runtime policy change, mainnet execution, or deployment is asserted here.
