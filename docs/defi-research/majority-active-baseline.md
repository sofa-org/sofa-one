# Major active DeFi market baseline (discovery snapshot)

Captured on local-reported date 2026-10-04 from DeFiLlama's public API; timezone and exact UTC capture time were not recorded. The parent verified these artifacts existed at 2026-10-03T16:59:58Z UTC, which is only an artifact-existence upper bound, not the capture time. This is an evidence snapshot for the seven-chain scope, **not** a claim that the present catalog achieves 90% coverage. No runtime authorization or catalog entries are approved by this research artifact. See the companion [frozen discovery classification](../../data/defi-coverage/discovery-classification.json) for denominators, statuses, and explicit unknowns.

## Data acquisition and reproducibility

The companion [`market-snapshot.json`](../../data/defi-coverage/market-snapshot.json) records the API response summaries, SHA-256 of each parsed response reserialized as compact UTF-8 JSON (not original HTTP bytes), URL, source record counts, protocol lineage fields, and per-chain metric rows. It also records a SHA-256 of that same serialization of the frozen `protocolUniverse` array. Sources are `https://api.llama.fi/protocols` and `https://api.llama.fi/overview/{dexs,fees,options}/{chain}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`. The API endpoint is official DeFiLlama public API (documentation: <https://defillama.com/docs/api>). Exact UTC API retrieval time was not recorded; the JSON uses null rather than infer a timestamp from local date/filesystem metadata. The parent-verified artifact-existence time is an upper bound only. The response body does not expose a consistent provider as-of timestamp; re-fetching later yields a new observation, not historical reproduction; original HTTP response bytes were not retained.

| Target chain | Provider chain key | DEX rows / API total30d USD | Fees rows / API total30d USD | Options rows / API total30d USD |
|---|---|---:|---:|---:|
| Ethereum | Ethereum | 170 / 43,233,704,967.47 | 621 / 351,047,096.40 | 8 / 2,201,726.01 |
| Base | Base | 184 / 29,425,232,941.57 | 483 / 68,511,080.45 | 9 / 961,030.56 |
| Arbitrum | Arbitrum | 151 / 6,054,208,142.19 | 393 / 21,485,778.78 | 15 / 273,074.10 |
| Optimism | OP Mainnet | 68 / 1,056,525,159.15 | 205 / 4,881,224.21 | 2 / null |
| Polygon | Polygon | 134 / 6,860,597,052.94 | 243 / 37,918,174.12 | 1 / 0 |
| BNB Chain | BSC | 181 / 35,700,195,161.21 | 337 / 113,351,218.24 | 1 / 0 |
| Monad | Monad | 60 / 3,752,549,066.81 | 134 / 6,460,162.07 | unavailable² |

¹ `null` is the provider's missing aggregate for the available Optimism options response; it is not numeric zero. The Optimism responses were collected after URL-encoding the provider's `OP Mainnet` key. ² Monad options API returned HTTP 500; this means unavailable/unknown, not zero. Snapshot fetch diagnostics preserve the initial failed unencoded Optimism attempts as well as Monad's options error.

API `total30d` is retained as returned; it is not asserted to be a uniform on-chain transaction count. DEX volume, fees, and options metrics have different methodologies and must not be summed as a single usage measure. API fields that are absent/null remain unknown; observed numeric zero is kept as zero.

## Universe and honest denominator

The source protocol endpoint returned 8,476 records, all retained as the frozen discovery roster; no TVL floor or top-N filter was applied. The three selected metric endpoints across seven chains yielded 1,324 distinct source IDs after ID-based union (1,317 IDs match the roster by string ID; 7 do not); there are 2,159 positive and 872 numeric-zero `total30d` metric observations. Those are metric observations, **not** unique active/inactive products. Among the roster, 3,497 rows list or match at least one target chain, 1,281 have unresolved chain identity, and 3,698 have no target-chain evidence in roster fields. These field-level groupings do not establish eligible-product counts. Metric families overlap, a record may be a child product or alias, and endpoint coverage is category-dependent. The snapshot preserves DeFiLlama IDs/slugs, parent protocol, linked protocols, source category and chain data to support later family/version reconciliation.

No arbitrary top-N or handpicked known-protocol list defines the denominator. **Activity means affirmative, category-compatible, product- and chain-attributed evidence within 90 days.** A positive 30-day observation is evidence that activity occurred within the enclosing 90-day interval; report its 30-day value separately and do not invent a 90-day total. Fees are not literal user transactions and require category-specific method validation. A numeric zero alone does not establish 90-day inactivity. TVL >= $1m is a priority-ranking signal only, never activity evidence or an exclusion rule. This capture did not obtain complete 90-day category-compatible activity, per-protocol per-chain TVL, or verified canonical product/deployment identities. Therefore active and inactive counts remain unclassified, all source roster rows remain conservatively unresolved for coverage, and no defensible universal 90% claim is possible. Missing data is unresolved, not inactive. Protocol identity must preserve parents and children separately unless evidence validates canonical product equivalence.

The current catalog's 202 exact function definitions across seven chains (179 actions, 23 approvals, per root `codemap.md`) cannot be compared to these market rows by protocol name. Coverage requires per-chain protocol-family mapping to verified contract deployments and its actual supported workflows; a protocol label is not full support.

## Activity evidence and next-source scope

DEX 30-day rows include substantial measured volume for Curve DEX and Uniswap V3 on Monad, and the API reports zero separately for some listed deployments. This illustrates why a listed deployment is not itself evidence of present activity, while an unavailable metric is not a zero. The snapshot retains the detailed rows for all reported products rather than elevating a hand-curated shortlist into the denominator.

Before adding any capability, a separate source-admission pass must verify official protocol deployment address, chain, version, canonical ABI/function signature, and source URL against official protocol documentation/repositories. This snapshot is market evidence only; it does not contain verified deployment admission, selector definitions, security review, or authorization. Complex routers, callbacks, arbitrary calldata and bridges require their own explicit risk treatment; never turn discovery into a wildcard allowlist.

## Limitations

- DeFiLlama is a third-party aggregator; method definitions differ by adapter and should be reviewed per category.
- The fees endpoint contains heterogeneous products and is not a universal activity proxy.
- The captured categories are only DEX, fees, and options. The broader protocol roster carries reported TVL metadata but this work did not normalize TVL per target chain or retrieve all required category metrics.
- Monad options was unavailable (HTTP 500); provider errors are preserved.
- Snapshot totals and row counts are endpoint observations at retrieval, not durable rankings, market shares, or proof of liquidity, safety, or successful execution.
- The frozen 8,476-row roster is a source-response cohort, not a proven complete market enumeration; canonical user-facing product identities remain unresolved. Unknowns stay in the conservative denominator until resolved, and category/workflow completeness must be reported separately.
