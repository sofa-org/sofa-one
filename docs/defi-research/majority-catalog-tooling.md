# M1 catalog and coverage tooling status

This note preserves historical M1 coverage evidence. Historical versioned full catalogs and their assembly plans have been removed; this note is not an operational catalog workflow or a deployment, execution, or active-market coverage claim.

## Reproducible catalog source

The only current source of truth is [`data/defi-catalog/catalog.json`](../../data/defi-catalog/catalog.json). Source evidence retained for historical research is under [`data/defi-catalog/sources/`](../../data/defi-catalog/sources/); it is not an alternate runtime input.

The pure implementation lives in `src/modules/defi/catalog-tooling/`; its CLI is `scripts/defi-catalog/cli.ts`. From the repository root:

```sh
npm run defi:catalog:generate
npm run defi:catalog:check
npm run defi:catalog:diff
```

Generation is offline and deterministic. It validates the catalog shape, rejects unsupported fields, validates nested function declarations and provenance with the manifest builder, sorts hierarchy consistently, and emits `src/modules/defi/registry/generated/production-catalog.ts`. Production assembly still runs the existing `buildReviewedManifest` validation/freezing path. Runtime catalog loading does not fetch sources or call RPC.

`check` fails if generated output is missing or stale. `diff` reports `added`, `removed`, `authorityChanged`, `abiChanged`, and `metadataChanged` separately. A changed or added capability never auto-rebinds an existing grant; owners must explicitly review exact capability IDs. Catalog membership does not assign grants or establish runtime identity, funding, balances, liquidity, or financial safety.

The previous M1 snapshot assertions above are historical evidence only; the current workflow compares the sole input with its generated runtime module.

## Coverage source limits

Coverage data and reports retained under `data/defi-coverage/` are historical research artifacts; the removed snapshot-specific coverage adapters are not part of catalog maintenance.

The independent public discovery snapshot contains 8,476 raw roster rows. Its classification records 3,497 rows with a listed/matched target chain, 1,281 with unknown chain identity, and 3,698 with no target-chain evidence; the metric scrape has 1,324 metric IDs (1,317 roster matches, 7 unmatched), 2,159 positive 30-day observations, and 872 zero 30-day observations. These are not canonical products or proof of the frozen 90-day active denominator: UTC capture time is unknown, chain/product/category mappings are incomplete, and a 30-day zero is not 90-day inactivity. Capture is recorded as `observedAt: null`; the parent's artifact-existence check at `2026-10-03T16:59:58Z` is only an upper bound on file existence, not the source/API retrieval time. The local reported date `2026-10-04` is not converted to UTC.

The normalized report currently records zero positively evidenced canonical active-product rows, `observedActiveCoverageBps: null`, 8,476 unresolved raw-roster proxy records in conservative accounting, and `objectiveEstablished: false`. The zero does **not** mean that no active products exist; the 8,476 proxy rows are **not verified distinct protocols/products**. They remain unresolved rather than being silently excluded or treated as known active/inactive products. The normalized report has 57 workflow rows: 50 complete at mapped evidence scope and 7 unresolved/source-blocked, not 57 complete products. Its current fingerprint is `c3975ec3b6d45299318c84828d30b19c44b6a93aa4dd4364b8fb9adad0af3928`. Parent validation passed the backend build, 116 suites/2,308 tests (one opt-in PostgreSQL test skipped), structural scan, catalog check/diff, and byte-identical normalize/check replay. The final market-coverage objective remains unestablished; this is not a claim of no active products, verified unique proxy products, deployment, or funded execution.

## Gate and safety status

The earlier protocol-expansion/source-admission Oracle review concerns the catalog contents and remains distinct from the M1 reproducibility/coverage review. M1 Gate 1 passed on attempt 2/3 after R1/R2 closure; parent owns the pending local milestone commit. No final denominator, majority-coverage result, grant change, runtime policy change, mainnet execution, or deployment is asserted here.
