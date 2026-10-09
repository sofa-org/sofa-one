# M4 offline catalog refresh audit

## Purpose and boundary

`src/modules/defi/catalog-tooling/refresh-audit.ts` compares fully parsed static catalog documents and reports whether a proposal is unchanged, needs explicit review, or reuses/changing existing authority under the same ID and is blocked. It reuses the strict catalog parser and reviewed-manifest/scope validation. It does not regenerate, publish, write, mutate grants, fetch network data, or establish market coverage. The CLI accepts only repository-owned fixed `data/defi-catalog/v1..v4/catalog.json` paths; it has no URL, traversal, symlink, output-path, or write mode. `--check-current` derives the selected version from the actual `package.json` `defi:catalog:check` command using a strict fixed v1-v4 selector; it never chooses v4 just because a v4 file exists. Pure audit functions accept object fixtures for adversarial tests; CLI input remains path constrained.

```sh
# Self-check the current v4 catalog and its twelve literal production profiles
npx ts-node scripts/defi-catalog/refresh-audit-cli.ts --check-current

# Reconcile preserved v2 authority against the v3 candidate
npx ts-node scripts/defi-catalog/refresh-audit-cli.ts \
  --current data/defi-catalog/v2/catalog.json \
  --proposed data/defi-catalog/v3/catalog.json

# Explicitly compare the immutable v3 baseline with a v4 candidate
npx ts-node scripts/defi-catalog/refresh-audit-cli.ts \
  --current data/defi-catalog/v3/catalog.json \
  --proposed data/defi-catalog/v4/catalog.json
```

The CLI prints a deterministic JSON audit report only. `VALID_NO_CHANGE` is a clean self-check; `REVIEW_REQUIRED` prints classifications for human review and exits 2; `BLOCKED` also exits 2 for same-ID executable authority changes. Malformed data, invalid profile contracts, and invalid paths fail closed. None of these modes silently permits publishing.

## Compared authority and classifications

Both catalogs pass the existing complete strict schema/parser and manifest validator before comparison. Matching IDs compare normalized chain, lowercase target, type, function name, signature, canonical fixed-ABI hash, active/inactive status, and execution-scope hash when present. Thus a fixed-scope change is authority-changing even if the ABI is unchanged. Existing IDs with changed executable identity/status are `BLOCKED` and require a new ID plus explicit admission/review; metadata cannot downgrade this classification. Removed and inactivated IDs are separately reported for review; saved unknown/revoked grants are not aliased, auto-revoked, or migrated to a replacement ID. If an added ID reuses an existing executable identity, the alias is called out for explicit review. Additions require independent source admission/baseline checks and never inherit old user/API-key grants. Source references, provenance dates, descriptions, labels, and warnings are classified as metadata/source-copy changes; they do not alter executable identity or block a refresh on their own. Source/compiler admission remains a separate review boundary.

The report is a refresh classification, not an independent proof that a new source record is admissible. It intentionally cannot activate candidates or suppress the existing compiler/admission checks. It does not query stored grants: preservation is achieved by reporting old IDs as removed/inactivated and never emitting an old-to-new grant mapping. When a catalog overlaps the published profile set, an unknown member, bad chain inventory, or forged fingerprint fails closed rather than silently dropping membership.

## Versioned profile checks

The v3 profile baseline is an immutable nine-profile/75-member JSON fixture extracted from reviewed commit `e453acde073554d31d4e1ceb46f429c2191e1dfa`, pinned to the original TypeScript source SHA-256 in fixture provenance. It is not copied from the live production profile export, which can change as new versions are published. Service-compatible fingerprints cover profile ID/version and sorted concrete member IDs with type, chain, normalized address, signature, ABI hash, and optional scope hash. Validation checks exact member existence, verified fixed-ABI identity, canonical member ordering, chain inventory, uniqueness, and fingerprint. Profile copy and function provenance dates are excluded from authority; pause/availability overlays do not drop members. A same-ID/version profile must retain exactly its reviewed membership and fingerprinted authority. Membership or authority changes under that version are rejected and require a new explicit version. New versions and removals are reported for explicit review/user preview; no profile is automatically selected or granted. A catalog status change remains catalog authority review/block even though profile membership and fingerprint are not narrowed by an availability overlay.

## Current fixed-catalog reconciliation

Current production v4 has 368 active definitions, 14 finite execution scopes, and 12 literal profiles with 94 unique IDs. `--check-current` follows the package's explicit v4 selector and validates the current catalog plus pinned v3 profile baseline; old v3 profile records remain immutable. Comparing fixed v3 to v4 reports 19 appended IDs, zero removals, zero same-ID authority/ABI changes, zero metadata changes to preserved IDs, and no old-ID aliases. The three new profiles require explicit versioned preview and never assign grants. The typed independent audit separately verifies current v4 and its profile set; see [M4 independent audit](majority-m4-independent-audit.md). This reconciliation does not prove market coverage or deployment.

## Validation and limits

Focused refresh-audit tests, catalog generation/profile tests, independent production authorization cases, typed CLI checks, parent full unit/build validation, and final independent audit/review suites passed. Oracle Gate 4 is FINAL PASS on attempt 3/3 with R1/R2/R3 closed; this does not change the market objective `FALSE`/null-denominator result, close source-provider evidence gaps, certify complete products/workflows, or assert funded/mainnet execution or financial safety. The M4 partial delivery remains locally uncommitted; no commit hash is claimed.
