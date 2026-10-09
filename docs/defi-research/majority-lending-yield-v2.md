# M2 lending / yield source fragment

This is a source-only fragment for the v2 catalog input. It adds no runtime rules, financial filters, automatic approvals, or grant/dependency policy. The source JSON is `data/defi-catalog/v2/sources/lending-yield.json`; it does not modify the frozen v1 baseline, v2 generated catalog, or production registry.

## Verification and count

The exact pinned official raw URLs are recorded in `sources[]`. At generation time, all 30 source-file fetches returned HTTP 200; a SHA-256 of each raw response is included in that source record's `evidence`. Deployment records were checked against the target addresses below; function names, argument types, mutability, and return shapes were checked against the pinned interface or ABI evidence. The fragment contains 54 fixed function records and no duplicate `(chainId, target, canonical signature)` identities:

| Family | Targets | Functions | Source basis |
| --- | ---: | ---: | --- |
| `compound-v2` | 5 | 22 | Pinned Compound Protocol mainnet deployment and ABI files plus CToken, CEther, and Comptroller interfaces |
| `compound-iii` | 10 | 20 | Pinned Comet `roots.json` and `configuration.json` per market plus `CometMainInterface.sol` |
| `aave-v3` | 3 | 12 | Pinned Aave address-book Pool constants plus pinned `IPool.sol`; lifecycle ABI copied from the existing v1 Aave Pool definitions |

### Compound V2 — Ethereum

Pinned official source commit: `compound-finance/compound-protocol@a3214f67b73310d547e00fc578e8355911c9d376`.

- cDAI: `0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643`
- cUSDC: `0x39AA39c021dfbaE8faC545936693aC917d5E7563`
- cUSDT: `0xf650C3d88D12dB855b8bf7D11Be6C55A4e07dCC9`
- cETH: `0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5`
- Unitroller: `0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B`

The three ERC-20 markets each expose `mint(uint256)`, `redeem(uint256)`, `redeemUnderlying(uint256)`, `borrow(uint256)`, and `repayBorrow(uint256)`, all nonpayable with the source ABI's `uint256` error-code return. cETH exposes the same five workflows; only `mint()` and `repayBorrow()` are payable and return no data. Unitroller contributes `enterMarkets(address[])` (returns `uint256[]`) and `exitMarket(address)` (returns `uint256`). No approval method is added.

### Compound III — ten exact markets

Pinned official source commit: `compound-finance/comet@f766f51583c23acc33b2a7824654ef2029a96804`. Each listed Comet address matched the `comet` field of that exact chain/market `roots.json`; the associated `configuration.json` and interface URL are also retained in the source records.

| Chain | Market | Comet |
| --- | --- | --- |
| Ethereum | USDT | `0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840` |
| Ethereum | WETH | `0xA17581A9E3356d9A858b789D68B4d866e593aE94` |
| Base | WETH | `0x46e6b214b524310239732D51387075E0e70970bf` |
| Arbitrum | USDT | `0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07` |
| Arbitrum | WETH | `0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486` |
| OP Mainnet | USDC | `0x2e44e174f7D53F0212823acC11C01A11d58c5bCB` |
| OP Mainnet | USDT | `0x995E394b8B2437aC8Ce61Ee0bC610D617962B214` |
| OP Mainnet | WETH | `0xE36A30D249f7761327fd973001A32010b521b6Fd` |
| Polygon | USDC | `0xF25212E676D1F7F89Cd72fFEe66158f541246445` |
| Polygon | USDT | `0xaeB318360f27748Acb200CE616E389A6C9409a07` |

Each target admits only `supply(address,uint256)` and `withdraw(address,uint256)`, nonpayable with no return data. This is generic fixed-ABI call coverage, not a filter on caller-controlled financial arguments. BNB Chain and Monad deployments remain unresolved; no address was propagated to them.

### Aave V3 — Ethereum Pools

Pinned address-book commit: `aave-dao/aave-address-book@f648e5dd3763467b836dfa35484ffe7024e6572a`. Each exact source file's `POOL` constant was checked (not `POOL_IMPL`):

- Lido market Pool: `0x4e033931ad43597d96D6bcc25c280717730B58B1`
- EtherFi market Pool: `0x0AA97c284e98396202b6A04024F5E2c65026F3c0`
- Horizon market Pool: `0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8`

Each Pool reuses the four existing v1 fixed interfaces from the pinned Aave V3 `IPool.sol` source: `supply(address,uint256,address,uint16)`, `withdraw(address,uint256,address)`, `borrow(address,uint256,uint256,uint16,address)`, and `repay(address,uint256,uint256,address)`. These generic functions preserve caller-selected ABI arguments and do not establish current liquidity, safety, market activity, or successful execution.

## Boundaries and unresolved entries

The `unresolved[]` records state where this fragment has no admitted source target; they do not assert that a deployment does not exist. In particular, no BNB Chain or Monad deployment is claimed. No Morpho Blue callback selectors, current Rocket Pool target, broad vault wildcard, approval, financial-argument cap, or automatic workflow dependency is added. This is static address/interface evidence only—not runtime authorization, funded execution, liquidity, or product-wide workflow-completeness evidence.
