# DEX expansion provenance and admission matrix

Research snapshot: 2026-10-03. Lane: official exact deployment + fixed official interface only, matching `simple-catalog-provenance.md`; not runtime audit, codehash verification, liquidity/execution proof, or financial policy. Caller retains control of assets, amounts, recipient, minimum output and native payment where method is payable. ERC-20 approval remains a distinct, explicit grant (arbitrary spender and uint256 amount including max); never auto-grant. Existing grant IDs are preserved. No RPC, chain writes, funds, dependency changes, or code changes were performed. This bounded follow-up covers only Aerodrome Base classic Router, Velodrome Optimism classic Router, and PancakeSwap V2 BNB Router.

## Existing coverage; do not duplicate

The current catalog already covers original Uniswap V3 `exactInputSingle` on 1/10/137/42161, Uniswap SwapRouter02 `exactInputSingle` on all seven supported chains, and PancakeSwap V3 `exactInputSingle` on 56. Its tuple distinction is material: original V3 and Pancake V3 use the eight-field deadline tuple; Router02 uses the seven-field tuple without deadline. This expansion does not duplicate those rows. Existing approval tokens are the 18 in the baseline provenance document; do not add duplicates or infer approval assets from tickers.

## Decision summary

| Candidate family | Candidate scope | Result in this evidence pass | Reason / next evidence required |
|---|---|---|---|
| Aerodrome (Base) | Classic Router direct swaps and direct LP methods | **ADMIT source/address/interface** | Official source-address manifest and official `IRouter` source captured below. Excludes zaps and arbitrary command surface. |
| Velodrome (Optimism) | Classic V2 Router direct swaps and direct LP methods | **ADMIT source/address/interface** | Official Optimism deployment-address file and official `IRouter` source captured below. Excludes zaps and arbitrary command surface. |
| PancakeSwap V2 | BNB Chain Router direct swaps and direct LP methods | **ADMIT source/address/interface** | Official PancakeSwap documentation links the BSC Router address; official periphery contract and interfaces establish the exact direct-call surface. |

These rows meet only the source-lane threshold; parent integration and validation remain separate. No approval capability is admitted or automatically granted here.

## Exact-source findings (retrieved 2026-10-03)

The official GitHub commit endpoints establish Aerodrome revision `1ba30815bba620f7e9faa34769ffd00c214c9b82` and Velodrome revision `b3065d8b6702b14b094f9f6046b752cc9f78c43b`; these are commit identifiers, distinct from their tree identifiers recorded below. Aerodrome's Base deployment output maps `Router` to `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`. Velodrome's Optimism deployment JSON maps `Router` to `0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858`. Both official `IRouter` sources define `Route` as `(address from,address to,bool stable,address factory)`. Neither interface is interchangeable with canonical Uniswap V2's `address[] path` ABI.

### Copy-ready direct-call ABI fragments

All rows below apply at **Aerodrome Base chain 8453 router `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`** and **Velodrome Optimism chain 10 router `0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858`**, each independently address-sourced above. They have identical selector signatures in the fetched official sources. Solidity omitted mutability means `nonpayable`; only `addLiquidityETH` and `swapExactETHForTokens` are payable.

```json
[
 {"type":"function","name":"swapExactTokensForTokens","stateMutability":"nonpayable","inputs":[{"name":"amountIn","type":"uint256"},{"name":"amountOutMin","type":"uint256"},{"name":"routes","type":"tuple[]","components":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"stable","type":"bool"},{"name":"factory","type":"address"}]},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amounts","type":"uint256[]"}]},
 {"type":"function","name":"swapExactETHForTokens","stateMutability":"payable","inputs":[{"name":"amountOutMin","type":"uint256"},{"name":"routes","type":"tuple[]","components":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"stable","type":"bool"},{"name":"factory","type":"address"}]},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amounts","type":"uint256[]"}]},
 {"type":"function","name":"swapExactTokensForETH","stateMutability":"nonpayable","inputs":[{"name":"amountIn","type":"uint256"},{"name":"amountOutMin","type":"uint256"},{"name":"routes","type":"tuple[]","components":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"stable","type":"bool"},{"name":"factory","type":"address"}]},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amounts","type":"uint256[]"}]},
 {"type":"function","name":"addLiquidity","stateMutability":"nonpayable","inputs":[{"name":"tokenA","type":"address"},{"name":"tokenB","type":"address"},{"name":"stable","type":"bool"},{"name":"amountADesired","type":"uint256"},{"name":"amountBDesired","type":"uint256"},{"name":"amountAMin","type":"uint256"},{"name":"amountBMin","type":"uint256"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amountA","type":"uint256"},{"name":"amountB","type":"uint256"},{"name":"liquidity","type":"uint256"}]},
 {"type":"function","name":"addLiquidityETH","stateMutability":"payable","inputs":[{"name":"token","type":"address"},{"name":"stable","type":"bool"},{"name":"amountTokenDesired","type":"uint256"},{"name":"amountTokenMin","type":"uint256"},{"name":"amountETHMin","type":"uint256"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amountToken","type":"uint256"},{"name":"amountETH","type":"uint256"},{"name":"liquidity","type":"uint256"}]},
 {"type":"function","name":"removeLiquidity","stateMutability":"nonpayable","inputs":[{"name":"tokenA","type":"address"},{"name":"tokenB","type":"address"},{"name":"stable","type":"bool"},{"name":"liquidity","type":"uint256"},{"name":"amountAMin","type":"uint256"},{"name":"amountBMin","type":"uint256"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amountA","type":"uint256"},{"name":"amountB","type":"uint256"}]},
 {"type":"function","name":"removeLiquidityETH","stateMutability":"nonpayable","inputs":[{"name":"token","type":"address"},{"name":"stable","type":"bool"},{"name":"liquidity","type":"uint256"},{"name":"amountTokenMin","type":"uint256"},{"name":"amountETHMin","type":"uint256"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amountToken","type":"uint256"},{"name":"amountETH","type":"uint256"}]}
]
```

The direct calls intentionally retain caller-chosen routes/factories/stable flag, amounts, minimums, recipient, deadline and (on payable methods) value. They do not constitute a financial-parameter safety claim. Separate approval rows, if the parent chooses to add them, must remain explicit and independently granted. Do not include `UNSAFE_swapExactTokensForTokens`, `zapIn`, `zapOut`, any `*WithPermit*`, broad multicall or generic executor methods in this candidate set.

### PancakeSwap V2 BNB Router direct-call rows

Official PancakeSwap documentation links the BscScan Router address `0x10ED43C718714eb63d5aA57B78B54704E256024E`; chain ID 56 is BNB Chain. This is official documentation's linked deployment address, not address inference from the source constructor. Official periphery `PancakeRouter.sol` implements `IPancakeRouter02`, which inherits `IPancakeRouter01`. The ten fixed direct methods below are source-supported at that exact documented address; nonpayable unless marked payable:

| Signature | Mutability | Outputs |
|---|---|---|
| `swapExactTokensForTokens(uint256,uint256,address[],address,uint256)` | nonpayable | `uint256[] amounts` |
| `swapTokensForExactTokens(uint256,uint256,address[],address,uint256)` | nonpayable | `uint256[] amounts` |
| `swapExactETHForTokens(uint256,address[],address,uint256)` | payable | `uint256[] amounts` |
| `swapTokensForExactETH(uint256,uint256,address[],address,uint256)` | nonpayable | `uint256[] amounts` |
| `swapExactTokensForETH(uint256,uint256,address[],address,uint256)` | nonpayable | `uint256[] amounts` |
| `swapETHForExactTokens(uint256,address[],address,uint256)` | payable | `uint256[] amounts` |
| `addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)` | nonpayable | `uint256 amountA, uint256 amountB, uint256 liquidity` |
| `addLiquidityETH(address,uint256,uint256,uint256,address,uint256)` | payable | `uint256 amountToken, uint256 amountETH, uint256 liquidity` |
| `removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)` | nonpayable | `uint256 amountA, uint256 amountB` |
| `removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)` | nonpayable | `uint256 amountToken, uint256 amountETH` |

The complete candidate set is ten methods: six swaps and four add/remove-liquidity functions. The ordinary V2 `address[] path` is a caller-provided route through the protocol's own pair factory, not an unrestricted arbitrary-call payload. Do not include permit variants or multicall.

```json
[
 {"type":"function","name":"swapExactTokensForTokens","stateMutability":"nonpayable","inputs":[{"name":"amountIn","type":"uint256"},{"name":"amountOutMin","type":"uint256"},{"name":"path","type":"address[]"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amounts","type":"uint256[]"}]},
 {"type":"function","name":"swapTokensForExactTokens","stateMutability":"nonpayable","inputs":[{"name":"amountOut","type":"uint256"},{"name":"amountInMax","type":"uint256"},{"name":"path","type":"address[]"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amounts","type":"uint256[]"}]},
 {"type":"function","name":"swapExactETHForTokens","stateMutability":"payable","inputs":[{"name":"amountOutMin","type":"uint256"},{"name":"path","type":"address[]"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amounts","type":"uint256[]"}]},
 {"type":"function","name":"swapTokensForExactETH","stateMutability":"nonpayable","inputs":[{"name":"amountOut","type":"uint256"},{"name":"amountInMax","type":"uint256"},{"name":"path","type":"address[]"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amounts","type":"uint256[]"}]},
 {"type":"function","name":"swapExactTokensForETH","stateMutability":"nonpayable","inputs":[{"name":"amountIn","type":"uint256"},{"name":"amountOutMin","type":"uint256"},{"name":"path","type":"address[]"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amounts","type":"uint256[]"}]},
 {"type":"function","name":"swapETHForExactTokens","stateMutability":"payable","inputs":[{"name":"amountOut","type":"uint256"},{"name":"path","type":"address[]"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amounts","type":"uint256[]"}]},
 {"type":"function","name":"addLiquidity","stateMutability":"nonpayable","inputs":[{"name":"tokenA","type":"address"},{"name":"tokenB","type":"address"},{"name":"amountADesired","type":"uint256"},{"name":"amountBDesired","type":"uint256"},{"name":"amountAMin","type":"uint256"},{"name":"amountBMin","type":"uint256"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amountA","type":"uint256"},{"name":"amountB","type":"uint256"},{"name":"liquidity","type":"uint256"}]},
 {"type":"function","name":"addLiquidityETH","stateMutability":"payable","inputs":[{"name":"token","type":"address"},{"name":"amountTokenDesired","type":"uint256"},{"name":"amountTokenMin","type":"uint256"},{"name":"amountETHMin","type":"uint256"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amountToken","type":"uint256"},{"name":"amountETH","type":"uint256"},{"name":"liquidity","type":"uint256"}]},
 {"type":"function","name":"removeLiquidity","stateMutability":"nonpayable","inputs":[{"name":"tokenA","type":"address"},{"name":"tokenB","type":"address"},{"name":"liquidity","type":"uint256"},{"name":"amountAMin","type":"uint256"},{"name":"amountBMin","type":"uint256"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amountA","type":"uint256"},{"name":"amountB","type":"uint256"}]},
 {"type":"function","name":"removeLiquidityETH","stateMutability":"nonpayable","inputs":[{"name":"token","type":"address"},{"name":"liquidity","type":"uint256"},{"name":"amountTokenMin","type":"uint256"},{"name":"amountETHMin","type":"uint256"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"name":"amountToken","type":"uint256"},{"name":"amountETH","type":"uint256"}]}
]
```

### Official source URLs and captured identifiers

- Aerodrome official GitHub API commit endpoint [`commits/main`](https://api.github.com/repos/aerodrome-finance/contracts/commits/main) returned commit SHA `1ba30815bba620f7e9faa34769ffd00c214c9b82` (2025-12-18); its distinct tree SHA is `7fb339f61f598959786f81d3667f0df4865608be`. The pinned official Base deployment output [`DeployCore-Base.json`](https://github.com/aerodrome-finance/contracts/blob/1ba30815bba620f7e9faa34769ffd00c214c9b82/script/constants/output/DeployCore-Base.json) maps `Router` to `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`; the pinned official [`IRouter.sol`](https://github.com/aerodrome-finance/contracts/blob/1ba30815bba620f7e9faa34769ffd00c214c9b82/contracts/interfaces/IRouter.sol) defines the fixed interface. Both links use the **commit SHA**, not the distinct tree SHA.
- Velodrome official GitHub API commit endpoint [`commits/main`](https://api.github.com/repos/velodrome-finance/contracts/commits/main) returned commit SHA `b3065d8b6702b14b094f9f6046b752cc9f78c43b` (2025-12-18); distinct tree SHA `591ca27c6702b8335c0719507883ebc49a5edb68`. The current deployment-address and `IRouter.sol` links are mutable branch links; commit-pinned equivalents are [`deployment-addresses/optimism.json`](https://github.com/velodrome-finance/contracts/blob/b3065d8b6702b14b094f9f6046b752cc9f78c43b/deployment-addresses/optimism.json) and [`contracts/interfaces/IRouter.sol`](https://github.com/velodrome-finance/contracts/blob/b3065d8b6702b14b094f9f6046b752cc9f78c43b/contracts/interfaces/IRouter.sol).
- Pancake official docs [full documentation capture](https://docs.pancakeswap.finance/llms-full.txt), retrieved 2026-10-03, links its `bscscan.com/address/0x10ED43C718714eb63d5aA57B78B54704E256024E` contract entry. Official periphery at commit `d769a6d136b74fde82502ec2f9334acc1afc0732`: [`PancakeRouter.sol`](https://github.com/pancakeswap/pancake-swap-periphery/blob/d769a6d136b74fde82502ec2f9334acc1afc0732/contracts/PancakeRouter.sol), [`IPancakeRouter01.sol`](https://github.com/pancakeswap/pancake-swap-periphery/blob/d769a6d136b74fde82502ec2f9334acc1afc0732/contracts/interfaces/IPancakeRouter01.sol), and [`IPancakeRouter02.sol`](https://github.com/pancakeswap/pancake-swap-periphery/blob/d769a6d136b74fde82502ec2f9334acc1afc0732/contracts/interfaces/IPancakeRouter02.sol). The exact docs page attempted (`/products/pancakeswap-exchange/pancakeswap-v2/contracts/router-v2`) returned Page Not Found; full official corpus does contain the linked address. The standard methods and mutability above are derived from official source, not BscScan ABI labels.

## Excluded surfaces and admission boundary

Admit only methods with a fixed, individually nameable ABI at an exact chain/address, after pairing official deployment and interface sources. Direct pool/router swap and direct add/remove-liquidity methods may be considered where exact ABI provenance is captured. Use exact tuple member order, types, outputs and mutability from the interface. Record `payable` accurately; native-value payment remains caller-controlled.

Exclude generic executor commands, arbitrary `multicall`, router `execute(bytes,bytes[])`, unrestricted arbitrary-call helpers, Permit2/permit signatures, and methods whose `bytes`/`userData` payload is an unbounded command language unless a separately consented capability model is specified. Balancer methods that accept `userData`, invoke hooks, or otherwise route arbitrary downstream calls cannot be described as merely a fixed bounded swap based on top-level selector alone. This is a scope boundary, not a claim that every such protocol method is unsafe.

Curve is not a family wildcard: each proposed pool needs an exact official chain deployment and its actual interface. Do not blend `int128` and `uint256` index signatures, overloads, or pool generations. Likewise, distinguish Aerodrome classic router from Slipstream and Velodrome classic router from Slipstream. Never infer that a repeated-looking address applies on another chain.

## Required row format for follow-up

For each proposed active method, retain one row per `(chainId, contract address, exact signature)` and provide:

| Field | Required content |
|---|---|
| Chain | Numeric chain ID and network name |
| Protocol / deployment generation | Exact product (e.g. classic vs Slipstream; V2 vs V3) |
| Contract | Exact checksummed address and official per-chain deployment source |
| Function | Canonical signature, parameter order/types, outputs, `stateMutability`, and any tuple component names/order |
| ABI evidence | Pinned official ABI/interface source (commit/tag preferred), or captured official deployment ABI JSON and snapshot date |
| Source capture | Retrieval date (2026-10-03 for this pass); mutable source must be labeled mutable |
| Scope disposition | Direct fixed method admitted, evidence missing, or excluded generic executor surface, with reason |

Recommended source evidence is project-owned official deployment manifests/address books and project-owned interface/ABI JSON. Block explorer labels, aggregators, token lists, SDK defaults, UI configs, and address reuse assumptions are leads only, not admission evidence. A future source-admitted row still does not prove runtime code identity, liquidity, successful execution, or financial suitability.

## Sources reviewed / baseline

- Existing exact coverage, address rows and ABI sources: [`simple-catalog-provenance.md`](./simple-catalog-provenance.md), snapshot 2026-10-02. In particular, its Uniswap and Pancake V3 deployment tables and pinned interface references govern duplicate detection and tuple distinctions.
- Architecture and method-level boundaries: [`src/modules/defi/codemap.md`](../../src/modules/defi/codemap.md).
- Candidate list and simplified scope are tracked in an ignored local progress note and are not a public provenance artifact.

This pass establishes two official chain-specific classic Router address/interface pairs (**seven** direct rows per chain; 14 total) and ten PancakeSwap V2 direct rows (six swap methods plus four LP methods). This supersedes the earlier inaccurate “12 direct rows per chain” and Pancake address-blocked statements above. These admissions are provenance-only and do not certify runtime code identity, live liquidity, execution success, or suitability.
