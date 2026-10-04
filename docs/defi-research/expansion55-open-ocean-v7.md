# Expansion 55 — OpenOcean v7 candidate

**Evidence reviewed:** 2026-10-04. Inactive test-only raw candidate; no admissions, generated catalog, runtime/profile wiring, or grants. Baseline `74bb052640` remains 15 finite scopes and 62 profiles.

## Bounded identity and exact selections

Ethereum proxy `0x6352a56caadc4f1e25cd6c75970fa768a3304e64`. This is the proxy, not implementation `0xE29B6B6E96beFE1e9C6f948BcB5A3f71058bDA9B`. Three exact payable functions copied as full ABI objects from `openocean-implementation-abi.json`:

| Function | Selector | Function ABI hash |
|---|---|---|
| `callUniswap(address,uint256,uint256,bytes32[])` | `0x8980041a` | `0xc7ec253d9ee59a49d06c1942f2995ffccd21cd50b125fdf83971ad46ad3b47e6` |
| `callUniswapTo(address,uint256,uint256,bytes32[],address)` | `0x6b58f2f0` | `0x7de60cbecd83a62e79134c59d2406f26e9c811cbc919cc9052b7f0a42b36b898` |
| `uniswapV3SwapTo(address,uint256,uint256,uint256[])` | `0xbc80f1a8` | `0x5172af3b624cb6351564e15c7c097ab72071588a5b94a553b0f9a1420a610c0e` |

All return `uint256 returnAmount`. V2 source token is `contract IERC20`; `callUniswapTo` recipient is `address payable`. V3 recipient is `address payable`, route words are `uint256[]`. These exact ABI objects, including internal types, are stored in the candidate source file.

## Evidence and exclusions

- Exact ABI and verified implementation source were captured from the [implementation explorer page](https://etherscan.io/address/0xE29B6B6E96beFE1e9C6f948BcB5A3f71058bDA9B#code), HTTP 200, 2026-10-04T17:39:27Z. The local extraction report/source index name the flattened source; candidate provenance records the resolved explorer URL and artifact SHA-256.
- The reviewed OpenOceanExchange source has V2 entry `1787–1804` and helpers `1806–2019` for fixed reserve/pair swap, empty callbacks, and fixed wrap/transfer. V3 entry `3420–3427`, helper `3429–3547`, `makeSwap` `3624–3645` use fixed swap-router encoding and payer callback `3550–3622` with canonical factory/pool and fixed token payment. The selected entrypoints do not reach `makeCalls` or `_permit`.
- Official docs [Contracts](https://docs.openocean.finance/docs/contracts), HTTP 200, provide proxy-role context. The official `OpenOceanExchangeV2` repository is pinned at `76c0a5a1a5b93a08c0c9ac8d6643c6b3a7b9e77e` (2025-11-24); README describes proxy and interfaces/`IOpenOceanCaller.sol` is interface evidence only.
- Explorer proxy/implementation association is dated metadata, not proof of current EIP-1967 slot, runtime bytecode, or deployment identity. Full implementation ABI is not a proxy runtime assertion.

Only these three methods are included. `simpleSwap`, `swap`, `swapGmxV2` (caller-selected `makeCalls`), permit variants, and callback/arbitrary-call surfaces are excluded; exclusion does not imply blanket rejection of arbitrary bytes elsewhere. Routes/pool words and financial parameters remain caller-controlled without amount, recipient, token, feed, or pair restrictions. Pool packed-word semantics and distribution are not independently proven; positive-slippage distribution is hardcoded to `0x8dd9433e6F86a035bB318A6f74AD2d3Ac6731861`, and returned `returnAmount` is not necessarily net recipient proceeds. The inherited methods have no protocol `whenNotPaused`; independent platform pause remains applicable. No claim is made about pool liquidity, financial safety, current runtime, or funded execution.
