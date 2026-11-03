# Chainlink price-feed provenance (research only)

Retrieved 2026-10-02. Scope is only Chainlink USD push-feed candidates for reviewed, non-borrowing, deadline-bounded spot swaps and the two L2 sequencer feeds. This is source research, not live RPC/explorer verification or activation approval. Parent review must verify chain ID, proxy code, decimals/description/round data, token identity (including canonical WETH), proxy implementation and feed still live before use. Fail closed if missing/invalid/stale or chain/feed has changed. No transactions sent.

## Official registry results

Source of feed metadata: [Chainlink Price Feed Contract Addresses](https://docs.chain.link/data-feeds/price-feeds/addresses), official docs page. It includes pair proxy, feed decimals, heartbeat, deviation threshold, and network metadata. Live page fetched 2026-10-02; its GitHub docs content is generated/updated and no immutable registry revision was exposed in the page. Do not silently treat these live values as immutable. Recorded thresholds are percentage deviation (not bps); heartbeat is seconds. Select the standard path (not similarly named SVR/shared-SVR or other feeds) where duplicates occur.

| Chain ID / network | Pair | Proxy | Feed decimals | Heartbeat s | Deviation % | Official entry / notes |
|---|---|---|---:|---:|---:|---|
| 1 Ethereum | USDC/USD | `0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6` | 8 | 82800 | 0.25 | [`USDC/USD`](https://data.chain.link/feeds/ethereum/mainnet/usdc-usd) |
| 1 Ethereum | USDT/USD | `0x3E7d1eAB13ad0104d2750B8863b489D65364e32D` | 8 | 86400 | 0.25 | [`USDT/USD`](https://data.chain.link/feeds/ethereum/mainnet/usdt-usd) |
| 1 Ethereum | ETH/USD | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | 8 | 3600 | 0.5 | [`ETH/USD`](https://data.chain.link/feeds/ethereum/mainnet/eth-usd) |
| 10 Optimism | USDC/USD | `0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3` | 8 | 86400 | 0.1 | [`USDC/USD`](https://data.chain.link/feeds/optimism/mainnet/usdc-usd) |
| 10 Optimism | USDT/USD | `0xECef79E109e997bCA29c1c0897ec9d7b03647F5E` | 8 | 86400 | 0.1 | [`USDT/USD`](https://data.chain.link/feeds/optimism/mainnet/usdt-usd) |
| 10 Optimism | ETH/USD | `0x13e3Ee699D1909E989722E753853AE30b17e08c5` | 8 | 1200 | 0.15 | [`ETH/USD`](https://data.chain.link/feeds/optimism/mainnet/eth-usd) |
| 42161 Arbitrum | USDC/USD | `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3` | 8 | 255 | 0.1 | [`USDC/USD`](https://data.chain.link/feeds/arbitrum/mainnet/usdc-usd); standard feed, not `usdc-usd-svr` |
| 42161 Arbitrum | USDT/USD | `0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7` | 8 | 255 | 0.1 | [`USDT/USD`](https://data.chain.link/feeds/arbitrum/mainnet/usdt-usd); standard feed, not shared-SVR/SVR |
| 42161 Arbitrum | ETH/USD | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` | 8 | 1755 | 0.05 | [`ETH/USD`](https://data.chain.link/feeds/arbitrum/mainnet/eth-usd); standard feed, not SVR |
| 137 Polygon PoS | USDC/USD | **Not established from the current official address registry retrieval** | — | — | — | Older/common Polygon references found in nonofficial repos are not adequate provenance for activation. |
| 137 Polygon PoS | USDT/USD | **Not established from the current official address registry retrieval** | — | — | — | Same: do not promote historic address-book references without current Chainlink official listing and verification. |
| 137 Polygon PoS | ETH/USD | **Not established from the current official address registry retrieval** | — | — | — | Exact supported asset/address relationship not established. |
| 56 BNB Chain | USDC/USD | **No official current listing established** | — | — | — | Unsupported absent additional official evidence. |
| 56 BNB Chain | USDT/USD | **No official current listing established** | — | — | — | Unsupported absent additional official evidence. |
| 56 BNB Chain | ETH/USD | **No official current listing established** | — | — | — | Do not substitute BNB/USD or infer wrapped-ETH price. |

Some data.chain.link URLs above are presentation links to the current official feed page, not versioned snapshots. The matching official docs entry page is the registry URL above. The list included multiple Arbitrum entries for `USDC/USD`, `USDT/USD`, `ETH/USD`; the selected standard feed is the entry whose path is `usdc-usd`, `usdt-usd`, `eth-usd`, excluding optional SVR products. ETH/USD prices ETH, not arbitrary WETH-like assets. Only a separately verified canonical wrapped-native token can inherit ETH/USD valuation; verify token address, chain and wrapper redemption semantics independently. Never price arbitrary bridged/wrapped/derivative assets as ETH by ticker.

### L2 sequencer uptime feeds

Official [Chainlink L2 Sequencer Feeds](https://docs.chain.link/data-feeds/l2-sequencer-feeds) page, retrieved 2026-10-02 (live, unpinned):

| Chain ID | Network | Sequencer uptime proxy |
|---:|---|---|
| 10 | OP Mainnet | `0x371EAD81c9102C9BF4874A9075FFFf170F2Ee389` |
| 42161 | Arbitrum Mainnet | `0xFdB631F5EE196F0ed6FAa767959853A9F217697D` |

The official example checks `latestRoundData()` and interprets `answer == 0` as sequencer up and `answer == 1` as down; reject any other value. On recovery, require `block.timestamp - startedAt > 3600` seconds (docs constant `GRACE_PERIOD_TIME = 3600`; equality is still inside grace). Also reject future `startedAt` / underflow. Run this guard before using L2 price data or executing a swap.

## ABI / read policy (official Chainlink interface)

Use the proxy, not a cached underlying aggregator. Official interface: [`AggregatorV3Interface.sol`](https://github.com/smartcontractkit/chainlink/blob/contracts-v1.3.0/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol) (tag `contracts-v1.3.0`). Read-only selectors:

```solidity
function decimals() external view returns (uint8);
function description() external view returns (string memory);
function latestRoundData() external view returns (
  uint80 roundId,
  int256 answer,
  uint256 startedAt,
  uint256 updatedAt,
  uint80 answeredInRound
);
```

`latestRoundData` is view and returns round id, signed answer, startedAt, updatedAt and answeredInRound. Chainlink docs mark `answeredInRound` deprecated (previously used for multi-round answers); do not rely on it as a freshness substitute. Require answer > 0, `updatedAt != 0`, timestamp not in the future, and age within locally enforced bound. Heartbeat is an expected maximum update interval, not a guarantee that every delayed update arrives exactly on it. Use fail-closed operational cap `min(feedHeartbeat + boundedGrace, productStalenessCap)`; choose and document `boundedGrace` in implementation review, never use unbounded stale answers. Verify on-chain `decimals()` equals registry value. `description()` should match expected pair; exact string formatting may vary, so compare a normalized expected label only after on-chain verification.

## Independent quote / max 1% price protection

Do not assume USDC/USD or USDT/USD equals 1.0. Independently read the actual input-token/USD and output-token/USD feed values. Let feed answers be positive integers `Ain`, `Aout` with decimals `din`, `dout`, token raw input amount `q` with decimals `tin`, and output-token decimals `tout`. The accepted exact-input policy requires `amountOutMinimum >= ceil(q * Ain * 10^(dout + tout) * 9900 / (Aout * 10^(din + tin) * 10000))`. Perform one exact integer/rational calculation, rounding upward only at the final bound; do not truncate an intermediate normalized price or expected output. A stricter caller minimum is acceptable. Exact-output is not in the selected delivery scope. Ensure a narrow future contract deadline, positive amounts and answers, validated decimal ranges, and a nonzero denominator. This protects against the accepted oracle reference snapshot, not subsequent oracle changes or all market risks. No market-spot fallback and no peg hardcoding.

## Explicit support limits / pending evidence

- Current official-list retrieval established 9 standard feeds for Ethereum, Optimism and Arbitrum. Polygon PoS and BNB Chain are **unsupported by this artifact** pending current official registry evidence; do not fill their rows from community registries or old code examples.
- No feed was found/assumed for base-token aliases, bridged USDC/USDT, native assets, or anything other than listed pair descriptions. Pair-specific feed identity and all live properties need read-only on-chain verification.
- Registry metadata is a live source and can change; re-review any address/heartbeat/deviation change. Activating only selected feeds does not resolve immutable provenance: preserve a snapshot/revision in the implementation decision.

## Official sources

- [Price Feed Contract Addresses](https://docs.chain.link/data-feeds/price-feeds/addresses) (main official registry; live, unpinned; retrieved 2026-10-02)
- [Data Feeds API reference](https://docs.chain.link/data-feeds/api-reference) (`AggregatorV3Interface` API)
- [Chainlink interface source, contracts-v1.3.0](https://github.com/smartcontractkit/chainlink/blob/contracts-v1.3.0/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol)
- [L2 sequencer uptime feed docs](https://docs.chain.link/data-feeds/l2-sequencer-feeds) (addresses and 3600s grace example; live, unpinned; retrieved 2026-10-02)
- [Data feeds architecture: heartbeat and deviation](https://docs.chain.link/architecture-overview/architecture-decentralized-model)
- [Data feed monitoring / staleness](https://docs.chain.link/data-feeds/using-data-feeds#checking-for-stale-data)
