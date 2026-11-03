# Simple catalog admission: official address and fixed-ABI provenance

Snapshot 2026-10-02. Scope is exactly the current registry's 70 definitions (52 action functions + 18 ERC-20 approval functions) on chain IDs 1, 8453, 42161, 10, 137, 56, 143. This is the deliberately simplified model: admit a definition when an official deployment/address source and the corresponding fixed official function ABI/signature are identified. Do **not** add requirements for live codehash/implementation/source exactness, funded forks, per-request feeds, price/financial constraints, deployment identity reads, or execution-evidence gates. This artifact does not change runtime, grant API keys, or make approval grants automatic. Token/private-key values were not inspected; there are no chain writes, funds, or transactions.

**Decision vocabulary:** `ADMIT` below means **ACTIVATE in the requested source/address/ABI catalog sense**: provenance meets this lane's threshold. It is not an audit or a statement of safety/availability. The only reason to mark a catalog row `INACTIVE` under this lane is inability to establish the official address or function interface. All 70 rows below are **ACTIVATE/ADMIT**; none are INACTIVE for older financial or execution-evidence reasons. Approval is an independent, separately-grantable function: arbitrary spender, any uint256 amount including `type(uint256).max`, no action dependency, no required matching funded action in the same transaction, and no mandatory cleanup/reset. **Never auto-grant** it. No broad multicall or new signing surface is added.

## Counts and call-surface result

| Family | Chain coverage | Action definitions | Fixed function surface | Admission |
|---|---|---:|---|---|
| Original Uniswap V3 SwapRouter | 1, 10, 137, 42161 | 4 | `exactInputSingle` with original 8-field tuple including `deadline` | ADMIT 4 |
| Uniswap SwapRouter02 | 1, 8453, 42161, 10, 137, 56, 143 | 7 | `exactInputSingle` with Router02 7-field tuple, no `deadline` | ADMIT 7 |
| PancakeSwap V3 SwapRouter | 56 | 1 | `exactInputSingle` with Pancake's 8-field tuple including `deadline` | ADMIT 1 |
| Aave V3 Pool | all 7 | 28 | `supply`, `withdraw`, `borrow`, `repay` | ADMIT 28 |
| Compound III Comet | 1, 8453, 42161 | 6 | `supply(address,uint256)`, `withdraw(address,uint256)` | ADMIT 6 |
| Morpho Vault V2 | 1, 8453 | 6 | `deposit`, `withdraw`, `redeem` | ADMIT 6 |
| ERC-20 approvals | token rows below | 18 | `approve(address,uint256)`; declared return varies by token (see variant notes) | ADMIT 18, each approval function separately and explicitly granted |
| **Total** | **7 chains** | **52 actions + 18 approvals** | **70 definitions** | **70 ADMIT** |

Address/interface provenance does not authorize implicit approvals, selectors outside this list, arbitrary command routing, or API-key auto-grants. Each approval is an independently grantable capability, not a hidden dependency of an action. User-approved policy restrictions are handled separately from this documentation admission decision and are not used to mislabel source-verified candidates as address/interface-unverified.

## DEX deployment-to-ABI map

### Original Uniswap V3 (4 action definitions)

The canonical router is `0xE592427A0AEce92De3Edee1F18E0157C05861564` on each listed chain. Official deployment source: [Uniswap v3-periphery `deploys.md`](https://github.com/Uniswap/v3-periphery/blob/v1.0.0/deploys.md), recorded snapshot date 2026-10-02; the official pinned source interface is [`ISwapRouter.sol` at v1.0.0](https://github.com/Uniswap/v3-periphery/blob/v1.0.0/contracts/interfaces/ISwapRouter.sol). Primary verified-source cross-check per `deployed-source-evidence.md`: Sourcify chain-1 record 1670957 and official source correspondence. Deployment address alone on Ethereum is not inferred for other chains; periphery's deployment list and the official docs deployment pages identify these chain deployments.

| Chain | Network | Router | Exact function admitted | Official address reference |
|---:|---|---|---|---|
| 1 | Ethereum | `0xE592427A0AEce92De3Edee1F18E0157C05861564` | `exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))` | pinned `deploys.md`; [official Ethereum V3 page](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-ethereum-deployments.mdx) |
| 10 | Optimism | same | same 8-field signature | pinned `deploys.md`; [official Optimism V3 page](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-optimism-deployments.mdx) |
| 137 | Polygon PoS | same | same 8-field signature | pinned `deploys.md`; [official Polygon V3 page](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-polygon-deployments.mdx) |
| 42161 | Arbitrum One | same | same 8-field signature | pinned `deploys.md`; [official Arbitrum V3 page](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-arbitrum-deployments.mdx) |

ExactInputSingle field order is `(tokenIn,tokenOut,fee,recipient,deadline,amountIn,amountOutMinimum,sqrtPriceLimitX96)`. Its pinned interface declares `external payable returns (uint256 amountOut)`. Do not reuse Router02's ABI.

### Uniswap SwapRouter02 (7 action definitions)

| Chain | Network | Router | Address source (official Uniswap docs commit `1c7597d73be0e9a3a4e44aa75b8fb212b40ea136`) |
|---:|---|---|---|
| 1 | Ethereum | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | [Ethereum deployment page](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-ethereum-deployments.mdx) |
| 8453 | Base | `0x2626664c2603336E57B271c5C0b26F421741e481` | [Base deployment page](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-base-deployments.mdx) |
| 42161 | Arbitrum One | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | [Arbitrum deployment page](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-arbitrum-deployments.mdx) |
| 10 | Optimism | same | [Optimism deployment page](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-optimism-deployments.mdx) |
| 137 | Polygon PoS | same | [Polygon deployment page](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-polygon-deployments.mdx) |
| 56 | BNB Chain | `0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2` | [BNB deployment page](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-bnb-deployments.mdx) |
| 143 | Monad | `0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900` | [Monad deployment page](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-monad-deployments.mdx) |

Fixed official interface: [`IV3SwapRouter.sol` at `Uniswap/swap-router-contracts@70bc2e40dfca294c1cea9bf67a4036732ee54303`](https://github.com/Uniswap/swap-router-contracts/blob/70bc2e40dfca294c1cea9bf67a4036732ee54303/contracts/interfaces/IV3SwapRouter.sol), signature `exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))`; 7 tuple fields `(tokenIn,tokenOut,fee,recipient,amountIn,amountOutMinimum,sqrtPriceLimitX96)`, no deadline. Source snapshot's interface commit date 2024-06-28. Interface function is `external payable returns (uint256 amountOut)`. ADMIT by address+ABI. Prior “no deadline” is not a source/address admission blocker under this simple model.

### PancakeSwap V3 (1 action definition)

| Chain | Router | Address source | Fixed ABI/signature | Decision |
|---:|---|---|---|---|
| 56 BNB | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` | Official [Pancake V3 `bscMainnet.json`](https://github.com/pancakeswap/pancake-v3-contracts/blob/main/deployments/bscMainnet.json), existing snapshot 2026-10-02 (upstream path is mutable `main`, so preserve retrieval date rather than pretend commit-pinned) | Official [`ISwapRouter` interface docs](https://github.com/pancakeswap/pancake-v3-contracts/blob/main/projects/v3-periphery/docs/interfaces/ISwapRouter.md), `exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))`; 8-field tuple includes `deadline`; `external payable returns (uint256 amountOut)` | **ADMIT** |

This is distinct from Uniswap Router02's seven-field tuple. Do not make ABI substitution based solely on shared V3 branding.

## Aave V3: 7 official markets × 4 canonical Pool functions

Addresses and the reserve token metadata below come from exact source modules at official [Aave address-book commit `17567521ae51088c85e01a6d8240f18b383bac2f`](https://github.com/aave-dao/aave-address-book/tree/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts). ABI comes from the canonical Pool interface [`IPool.sol` at Aave Origin commit `8305565ae342f1773c42cd2e4593f175fe5968a0`](https://github.com/aave-dao/aave-v3-origin/blob/8305565ae342f1773c42cd2e4593f175fe5968a0/src/contracts/interfaces/IPool.sol) and official [Pool docs](https://aave.com/docs/aave-v3/smart-contracts/pool). All seven deployments have official chain-specific address-book entries; each has the identical canonical ABI below. Address-book `POOL_IMPL` constants are listed as metadata but simple admission does not require implementation verification.

| Chain | Network | Official `POOL` | Pinned module |
|---:|---|---|---|
| 1 | Ethereum | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` | [AaveV3Ethereum.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3Ethereum.ts) |
| 8453 | Base | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | [AaveV3Base.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3Base.ts) |
| 42161 | Arbitrum One | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | [AaveV3Arbitrum.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3Arbitrum.ts) |
| 10 | Optimism | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | [AaveV3Optimism.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3Optimism.ts) |
| 137 | Polygon PoS | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | [AaveV3Polygon.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3Polygon.ts) |
| 56 | BNB Chain | `0x6807dc923806fE8Fd134338EABCA509979a7e0cB` | [AaveV3BNB.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3BNB.ts) |
| 143 | Monad | `0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef` | [AaveV3Monad.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3Monad.ts) |

Each chain admits these exact four declarations, 28 total, from pinned `IPool.sol`:

```solidity
supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode) external
withdraw(address asset,uint256 amount,address to) returns (uint256)
borrow(address asset,uint256 amount,uint256 interestRateMode,uint16 referralCode,address onBehalfOf) external
repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf) returns (uint256)
```

All four declarations are `external` and nonpayable by Solidity default. `supply` and `borrow` have no return values; `withdraw` and `repay` return `uint256`. These are canonical V3 Pool ABI methods, not chain-specific packed wrappers. Under this lane all four pass address/interface admission. No conclusion is made here about asset/borrow/health/financial policy.

## Compound III Comet: 3 official markets × 2 methods

Official pinned repository commit `f766f51583c23acc33b2a7824654ef2029a96804`. Exact market address is from each market's pinned `roots.json`; base token is from paired pinned `configuration.json`; ABI/interface is official [`CometMainInterface.sol`](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/contracts/CometMainInterface.sol) (and [Comet SPEC](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/SPEC.md)). Both methods are nonpayable in the interface.

| Chain | Comet address | Base token | Pinned official deployment/config refs | Admitted signatures |
|---:|---|---|---|---|
| 1 Ethereum | `0xc3d688B66703497DAA19211EEdff47f25384cdc3` | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | [roots.json](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/mainnet/usdc/roots.json), [configuration.json](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/mainnet/usdc/configuration.json) | `supply(address,uint256)`, `withdraw(address,uint256)` |
| 8453 Base | `0xb125E6687d4313864e53df431d5425969c15Eb2F` | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | [roots.json](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/base/usdc/roots.json), [configuration.json](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/base/usdc/configuration.json) | same two signatures |
| 42161 Arbitrum One | `0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf` | USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | [roots.json](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/arbitrum/usdc/roots.json), [configuration.json](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/arbitrum/usdc/configuration.json) | same two signatures |

The Arbitrum Comet base USDC (`0xaf88…`) is distinct from the Aave/DEX Arbitrum USDC asset (`0xFF97…`); retain distinct asset refs.

## Morpho Vault V2: two official API records × three methods

Official discovery and detail API: Morpho GraphQL [`vaultV2ByAddress`](https://api.morpho.org/graphql), documented at [Morpho vault API docs](https://docs.morpho.org/developers/api/morpho-vaults). ABI/function semantics from [Vault V2 concepts](https://docs.morpho.org/learn/concepts/vault-v2) and [VaultV2 API reference](https://docs.morpho.org/developers/earn/concepts/vault-v2). The API is mutable, not git-pinned. To make the exact provenance replayable, this lane made bounded read-only point lookups on 2026-10-02 using the query below; SHA-256 is over the literal response body bytes (not canonicalized JSON):

```graphql
query Vault($address: String!, $chainId: Int!) {
  vaultV2ByAddress(address: $address, chainId: $chainId) {
    address name symbol listed asset { address decimals }
    chain { id network } owner { address } curator { address }
    factory { address } type
  }
}
```

| Chain | Vault / name (`listed`) | Underlying address; decimals | Official API response SHA-256 | API-reported factory | Admission |
|---:|---|---|---|---|---|
| 1 Ethereum | `0x04422053aDDbc9bB2759b248B574e3FCA76Bc145` — Keyrock USDC / `kUSDC` (true) | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`; 6 | `8614743d67c968ef33525d64606c3650c3473e84416bb76ed2606d5f752c44c6` | `0xA1D94F746dEfa1928926b84fB2596c06926C0405` | **ADMIT** |
| 8453 Base | `0x050cE30b927Da55177A4914EC73480238BAD56f0` — Gauntlet USDC Prime / `gtusdcp` (true) | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; 6 | `d041f3f1fb58d2ee688def57fdaf1682abeedc36510228899e779c552c89a631` | `0x4501125508079A99ebBebCE205DeC9593C2b5857` | **ADMIT** |

Each exact vault address admits these functions (6 definitions total):

```solidity
deposit(uint256 assets,address onBehalf) returns (uint256 shares)
withdraw(uint256 assets,address receiver,address onBehalf) returns (uint256 shares)
redeem(uint256 shares,address receiver,address onBehalf) returns (uint256 assets)
```

All three functions are nonpayable in the documented Morpho Vault V2 interface. These exact names, parameter types/order, outputs, and mutability are from the Vault V2 API, not an inference from generic ERC-4626 similarity. Live API listing is mutable and not an endorsement; its exact captured responses plus official ABI docs meet this lane's *address/interface provenance* bar only. Existing APY, curator risk, adapters, implementation immutability, underlying live code, and financial rules are expressly outside this simple admission criterion.

## Eighteen asset rows and approval ABI provenance

Existing registry construction resolves these 18 distinct token addresses across the seven chains (Arbitrum has two distinct USDC addresses because Comet uses native USDC while Aave/DEX use USDC.e). Address provenance: exact Aave module rows at pinned address-book SHA above; Arbitrum native USDC additionally comes from Compound's pinned Arbitrum `configuration.json`. The token-specific addresses are not inferred from ticker or chain aliases.

| Chain | Symbol | Exact address | Official address source |
|---:|---|---|---|
| 1 | USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | Aave `AaveV3Ethereum.ts` |
| 1 | USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | Aave `AaveV3Ethereum.ts` |
| 1 | WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | Aave `AaveV3Ethereum.ts` |
| 8453 | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Aave `AaveV3Base.ts` |
| 8453 | WETH | `0x4200000000000000000000000000000000000006` | Aave `AaveV3Base.ts` |
| 42161 | USDC.e | `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8` | Aave `AaveV3Arbitrum.ts` |
| 42161 | USDT | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | Aave `AaveV3Arbitrum.ts` |
| 42161 | WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | Aave `AaveV3Arbitrum.ts` |
| 42161 | USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | Compound `arbitrum/usdc/configuration.json` at pinned Comet SHA |
| 10 | USDC | `0x7F5c764cBc14f9669B88837ca1490cCa17c31607` | Aave `AaveV3Optimism.ts` |
| 10 | USDT | `0x94b008aA00579c1307B0EF2c499aD98a8ce58e58` | Aave `AaveV3Optimism.ts` |
| 10 | WETH | `0x4200000000000000000000000000000000000006` | Aave `AaveV3Optimism.ts` |
| 137 | USDC | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | Aave `AaveV3Polygon.ts` |
| 137 | WETH | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` | Aave `AaveV3Polygon.ts` |
| 56 | USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | Aave `AaveV3BNB.ts` |
| 56 | USDT | `0x55d398326f99059fF775485246999027B3197955` | Aave `AaveV3BNB.ts` |
| 143 | USDC | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | Aave `AaveV3Monad.ts` |
| 143 | WETH | `0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242` | Aave `AaveV3Monad.ts` |

The standard fixed approval interface is `approve(address spender,uint256 amount) external returns (bool)`, nonpayable, from pinned [`IERC20.sol` at OpenZeppelin Contracts v5.0.2](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.0.2/contracts/token/ERC20/IERC20.sol). However, ERC-20 function output declarations vary in deployed token source and are not part of the selector or transaction calldata. For example, Ethereum USDT's official Tether [`TetherToken.sol`](https://github.com/tethercoin/USDT/blob/master/TetherToken.sol) `approve(address,uint256)` is `public` with **no return value** (source path mutable `master`, inspected 2026-10-02); Solidity's omitted mutability keyword means nonpayable. Its selector/calldata still matches `approve(address,uint256)`. Do not assert that every deployed token returns `bool`, and do not depend on decoding an `approve` return value.

| Token/source subset | ABI provenance and known output/mutability | Admission handling |
|---|---|---|
| Ethereum USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7` | Tether official `TetherToken.sol` declares `approve(address _spender,uint _value)` public, no returns; nonpayable by default. | ADMIT `approve(address,uint256)` calldata interface; use no-return-compatible call handling. |
| Other 17 listed token rows | Official Aave address-book or Compound config establishes exact token addresses; pinned IERC20 establishes the standard signature with bool output, nonpayable. These registry records do **not** independently prove each deployed implementation's output declaration. No token source/runtime scan was performed in this lane. | ADMIT selector/function interface; do not claim all 17 deployed ABI output declarations were verified. If a particular token's official interface source reports a variant, map its return convention without changing selector or making return decoding required. |

Approval is an independent explicit function, not a dependency derived from action grants. It allows any spender address and any uint256 amount (including unlimited `type(uint256).max`) as an independently grantable capability; it does not require a funded action, same-batch match, allowance cleanup, or zero-reset. No approval is automatically granted by admitting any action/token, and there is no amount/spender limit in this provenance artifact.

## ACTIVATE / INACTIVE reconciliation for the 70 rows

| Rows | Count | Address/interface provenance | This lane result |
|---|---:|---|---|
| Original V3 `exactInputSingle` | 4 | official deploys/docs + official v1.0.0 `ISwapRouter` | **ADMIT all 4** |
| SwapRouter02 `exactInputSingle` | 7 | official per-chain Uniswap docs commit + pinned official IV3 interface commit | **ADMIT all 7** |
| Pancake V3 `exactInputSingle` | 1 | official BNB deployment artifact and official ISwapRouter docs snapshot 2026-10-02 | **ADMIT** |
| Aave supply/withdraw/borrow/repay | 28 | seven pinned official address-book modules + pinned official IPool interface | **ADMIT all 28** |
| Compound Comet supply/withdraw | 6 | three pinned official roots/config pairs + pinned Comet interface | **ADMIT all 6** |
| Morpho V2 deposit/withdraw/redeem | 6 | two official point-query records (response hashes above) + official Vault V2 call ABI | **ADMIT all 6** |
| ERC-20 `approve` | 18 | 18 official address-book/config addresses + ERC20 selector/interface; Ethereum USDT no-return variant explicitly mapped | **ADMIT all 18**; each approval is independently grantable |
| **Total** | **70** | Address and function interface established | **No source/address-based inactive rows** |

The former runtime-hash/proxy implementation, live price, no-deadline, borrowing/withdrawal semantics, vault adapter/liquidity, and funded-execution requirements are not reintroduced as hidden catalog admission blockers. Marking any of these rows `INACTIVE` for such old financial/evidence criteria would contradict this explicitly requested simple-model source lane. User grants remain independent decisions; specifically, granting an action never auto-grants `approve`, and granting `approve` never requires granting or including an action.

## Mapping notes for registry port

- Existing DEX action counts are 4 original V3 + 7 Router02 + 1 Pancake. Keep three ABI definitions exactly as above: original V3 8 tuple; Router02 7 tuple; Pancake 8 tuple.
- Existing lending counts are 7 Aave markets × 4 = 28 plus 3 Comet markets × 2 = 6. Do not add missing networks for Compound or Morpho.
- Existing vault counts are exactly the two API candidates × 3 = 6. Current source provides exact address and ABI provenance; do not generalize to arbitrary ERC-4626 addresses.
- Eighteen approval capabilities correspond to the 18 distinct official token addresses listed above. The Arbitrum Comet USDC address is a distinct eighteenth asset; it is not a ticker-based substitute for USDC.e. Approval function grant is independent of action grant and batch composition.
- `ReviewedDeployment.abiHash` may be generated using the registry's actual documented `reviewedAbiHash(abi)` convention; no separate source-file hash should be substituted. Source version/commit/API snapshot is the admission provenance. Runtime code hashes are intentionally not required by this model.
- ERC20 approval is itself an independently grantable authority: arbitrary spender, unlimited amount permitted, no action dependency or cleanup requirement. Do not auto-grant it. Do not add permit/Permit2/multicall/signing paths.
