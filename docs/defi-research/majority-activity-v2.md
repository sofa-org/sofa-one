# M2 market activity evidence — DeFiLlama seven-chain snapshot

This is an actual public-data supplement to the immutable M1 universe, not a fresh universe, catalog admission, or coverage claim. M1's 8,476-row protocol roster remains the input universe (SHA-256 of its canonical `protocolUniverse` JSON: `7fc3a4de44a3eebc1354aa57736cb72b48b21321c766d3c9a31e9eeea47c9b24`, as recorded by M1). This capture did not narrow candidates by TVL, activity, catalog status, or chain-list presence.

## Acquisition provenance

Captured directly from DeFiLlama public API endpoints for DEX volume and fees on Ethereum, Base, Arbitrum, OP Mainnet, Polygon, BSC, and Monad. The UTC time `2026-10-03T19:11:22Z` was read from the system clock immediately before the sequential HTTP requests began. It is the **capture-start** time, not a timestamp supplied by DeFiLlama and not an assertion that all requests were simultaneous. All 14 requests returned HTTP 200. No historical API or RPC query was used.

[`activity-snapshot.json`](../../data/defi-coverage/v2/activity-snapshot.json) contains each complete parsed response body, exact source URL, status, returned chain key, record count, returned 30-day aggregate, and a SHA-256 of the response reserialized as compact UTF-8 JSON with `ensure_ascii=False` (not a hash of raw HTTP bytes). It also preserves source IDs, slugs, provider categories, explicit parent/linked-protocol values, chain-attributed measurements, null/zero values, and source IDs absent from the frozen M1 roster. This makes response-to-row association reproducible without relying on names. Re-fetching the URLs produces a new observation, not historical reproduction.

| Chain | API key | DEX rows; API `total30d` USD | Positive DEX 30d rows | Fees rows; API `total30d` USD | Positive fees 30d rows |
|---|---|---:|---:|---:|---:|
| Ethereum | Ethereum | 170; 43,233,704,967.47 | 109 | 621; 351,047,096.40 | 441 |
| Base | Base | 184; 29,425,232,941.57 | 130 | 483; 68,511,080.45 | 332 |
| Arbitrum | Arbitrum | 151; 6,054,208,142.19 | 83 | 393; 21,485,778.78 | 220 |
| Optimism | OP Mainnet | 68; 1,056,525,159.15 | 33 | 205; 4,881,224.21 | 115 |
| Polygon | Polygon | 134; 6,860,597,052.94 | 88 | 243; 37,918,174.12 | 135 |
| BNB Chain | BSC | 181; 35,700,195,161.21 | 128 | 337; 113,351,218.24 | 208 |
| Monad | Monad | 60; 3,752,549,066.81 | 32 | 134; 6,460,162.07 | 92 |

Across endpoints this yields **603 positive DEX observations** and **1,543 positive fee observations**; these are category-chain rows, not distinct protocols or products. There are 1,310 distinct source IDs across this v2 metric capture, with 7 metric-source rows absent from the frozen M1 roster (retained in full in `metricSourceIdsUnmatchedM1Universe`). Per-endpoint counts of positive, numeric-zero, null/missing and IDs matching M1 are recorded in the data file. DEX volume is the relevant usage observation here. Fees are retained as a separate proxy, not equated to transaction counts or used alone to assert end-user activity.

## What the observation does and does not establish

A positive 30-day DEX volume observed at this capture is affirmative evidence of some activity inside the enclosing 90-day window. It is **not** a 90-day total, an extrapolated value, or evidence that the same product is active on every chain in its roster. A numeric 30-day zero does not establish inactivity over 90 days; absent/null data and request failures remain unknown. No complete 90-day zeros or historical totals were collected.

Source records preserve explicit DeFiLlama IDs and relationships. Those fields do not, by themselves, establish a canonical user-facing product, deployment/version, or complete chain population. No name-only alias merging or parent/child deduplication was performed. M1 roster rows remain frozen; v2 metric rows matched against them by exact source ID only. “Existing catalog support” and “complete workflow support” are not inferred from product names or activity data and remain unresolved in this source lane.

## Illustrative chain/product observations (not a top-N denominator)

Examples below are actual positive 30-day DEX-volume rows from the embedded provider responses. The source ID, chain, value, and parent field are carried unchanged; parent is not counted as a substitute for a child product. They illustrate where source verification and workflow mapping should prioritize next. They are not a complete candidate list or protocol safety/deployment review.

| Provider product / source ID | Chain | DEX volume, 30d USD | Explicit provider parent | Catalog/workflow status in this evidence lane |
|---|---|---:|---|---|
| Uniswap V4 / `5690` | Ethereum | 14,346,347,285 | `parent#uniswap` | Not assessed |
| Uniswap V3 / `2198` | Base | 5,432,824,008 | `parent#uniswap` | Not assessed per-chain/workflow |
| Aerodrome Slipstream / `4524` | Base | 13,880,095,964 | `parent#aerodrome` | Not assessed per-chain/workflow |
| PancakeSwap AMM V3 / `2769` | BNB Chain | 16,022,814,564 | `parent#pancakeswap` | Not assessed per-chain/workflow |
| PancakeSwap Infinity / `6133` | BNB Chain | 7,213,520,794 | `parent#pancakeswap` | Not assessed |
| Velodrome V3 / `4249` | Optimism | 495,293,634 | `parent#velodrome` | Not assessed per-chain/workflow |
| Kuru CLOB / `7029` | Monad | 2,290,915,350 | `parent#kuru` | Not assessed |
| Curve DEX / `3` | Ethereum | 3,023,388,751 | `parent#curve-finance` | Not assessed |
| Fluid DEX / `5317` | Ethereum | 3,280,568,213 | `parent#fluid` | Not assessed |

These observations support prioritizing DEX source-admission research (including distinct Uniswap/Pancake versions and concentrated-liquidity products), not automatic function additions. Lending, yield/vault, staking/restaking, bridge, and derivatives source-specific activity measures were not collected in this bounded pass and remain unknown rather than inactive. M1's workflow table and exact catalog definitions remain separate evidence and must be reconciled before any “supported” label or coverage ratio.

## Limitations and next M2 research step

- DeFiLlama is a third-party aggregator; methodology/category semantics should be checked against each adapter before interpreting a metric.
- DEX totals represent reported volume; fees are not literal user-level activity. Values are retained in their native API category and window; do not sum unlike metrics.
- Seven source IDs in the v2 endpoints are not matched to M1 by exact ID; they remain included, not discarded. No name-based matching is asserted.
- Protocol records/parent links do not verify official contract addresses, ABI selectors, deployment instances, or full core workflows. Those require a separate official-source admission pass.
- The seven-chain activity sample is not a proof the upstream roster exhaustively enumerates the market. No global 90% claim is warranted while product identity, chain coverage, category metrics, and workflow completeness remain unresolved.
