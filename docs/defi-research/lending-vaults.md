# Lending and yield-vault activation research

Research snapshot: 2026-10-02. GitHub API commit lookup and pinned raw module retrieval performed 2026-10-02 (UTC date; no time-of-day recorded). This is an official-registry evidence note, not activation or independent explorer/code validation. Do not infer live liquidity or safety from registry data.

## Recommendation

Use Aave V3 as the broad family; the seven requested module files and common assets are extracted below at pinned revision. Compound III USDC Comet is additionally evidenced on Ethereum, Base, and Arbitrum. Yield-vault inclusion remains unresolved: this pass did not establish official current vault registry deployments, so no vault is claimed as vetted or implementable. Do not copy these addresses directly into production; parent independent explorer/code validation remains pending.

## Aave V3

Official source: [Aave V3 Pool docs](https://aave.com/docs/aave-v3/smart-contracts/pool), [address-book repository](https://github.com/aave-dao/aave-address-book). Resolve `main` via GitHub API `GET https://api.github.com/repos/aave-dao/aave-address-book/commits/main`; captured commit **17567521ae51088c85e01a6d8240f18b383bac2f**. Each immutable source URL in the table is the exact module used; `POOL_IMPL` is the address-book constant and not independent proxy implementation verification.

### Pinned Aave V3 manifest

`absent` means no exact symbol entry in that module, not proof no economically similar token exists. Address/decimals are the official address-book's asset metadata, not independently queried token contract values. BNB token metadata's 18 decimals are preserved exactly (do not assume stablecoin decimals are always six).

| Chain | chainId | `POOL` | `POOL_IMPL` | USDC (address; decimals) | USDT (address; decimals) | WETH (address; decimals) | Immutable evidence |
|---|---:|---|---|---|---|---|---|
| Ethereum | 1 | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` | `0x728a138A4823392C2EFA55e028d434F526fE03CF` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`; 6 | `0xdAC17F958D2ee523a2206206994597C13D831ec7`; 6 | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`; 18 | [AaveV3Ethereum.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3Ethereum.ts) |
| Base | 8453 | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | `0xA4AbC5FcBA6D0d7E3D144d6dbF6cb6128599dFdB` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; 6 | absent | `0x4200000000000000000000000000000000000006`; 18 | [AaveV3Base.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3Base.ts) |
| Arbitrum One | 42161 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0xF05Fd3cC911b4c5E36e53c00354F645E22922C9A` | `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8`; 6 | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9`; 6 | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`; 18 | [AaveV3Arbitrum.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3Arbitrum.ts) |
| Optimism | 10 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0x66185E53343336d4FaeA5317d1Fcca103Dd4088D` | `0x7F5c764cBc14f9669B88837ca1490cCa17c31607`; 6 | `0x94b008aA00579c1307B0EF2c499aD98a8ce58e58`; 6 | `0x4200000000000000000000000000000000000006`; 18 | [AaveV3Optimism.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3Optimism.ts) |
| Polygon | 137 | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0x6030dB989D47cD74FC17bB6F4FcD3A8B29FEe57e` | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`; 6 | absent (module includes `USDT0`, not `USDT`) | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619`; 18 | [AaveV3Polygon.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3Polygon.ts) |
| BNB Chain | 56 | `0x6807dc923806fE8Fd134338EABCA509979a7e0cB` | `0x5e2B0FcC5b9734C7Ec0A03401ee9e6805F783B6d` | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`; 18 | `0x55d398326f99059fF775485246999027B3197955`; 18 | absent | [AaveV3BNB.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3BNB.ts) |
| Monad | 143 | `0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef` | `0x9539531EA4f6563A66421a7449506152609985be` | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`; 6 | absent | `0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242`; 18 | [AaveV3Monad.ts](https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/AaveV3Monad.ts) |

### Narrow call surface (fixed target: chain-specific official `POOL`)

Only use canonical Pool ABI methods, not L2 packed wrappers, adapters, routers, arbitrary calls, or multicall.

| Selector/function | Fixed arguments and policy |
|---|---|
| `supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)` | `asset` exact reviewed underlying; positive bounded `amount`; `onBehalfOf = execution owner`; referral `0`. Approval only exact finite amount and only to the Pool. |
| `withdraw(address asset,uint256 amount,address to) returns (uint256)` | Reviewed underlying; positive amount; `to = execution owner`; constrain amount to known position/balance; no arbitrary recipient. |
| `borrow(address asset,uint256 amount,uint256 interestRateMode,uint16 referralCode,address onBehalfOf)` | Borrow high-risk and separately gated. `interestRateMode=2`, referral `0`, `onBehalfOf=execution owner`; positive bounded amount. No delegation or third-party borrower. Require collateral/risk policy; never imply solvency from calldata validation. |
| `repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf) returns (uint256)` | Reviewed underlying; `interestRateMode=2`, `onBehalfOf=execution owner`; bounded positive explicit amount. Explicitly reject `uint256.max` in the initial policy: Aave documents max as full-debt repayment only when not repaying for a third party, but the owner-only policy can avoid sentinel ambiguity. |

For all four: prohibit arbitrary `onBehalfOf` and `to`; verify asset is a reserve on the exact chain and has verified token code/decimals; no arbitrary bytes/callback fields exist in these signatures. These calls can still lose funds or create liquidation risk. Borrowing should default disabled absent explicit product/high-risk governance approval.

## Compound III (USDC Comet)

Official Compound repo: [compound-finance/comet](https://github.com/compound-finance/comet). GitHub API resolved branch `main` to **f766f51583c23acc33b2a7824654ef2029a96804** on 2026-10-02. Pinned official market files: [Ethereum roots](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/mainnet/usdc/roots.json), [Ethereum config](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/mainnet/usdc/configuration.json), [Base roots](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/base/usdc/roots.json), [Base config](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/base/usdc/configuration.json), [Arbitrum roots](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/arbitrum/usdc/roots.json), [Arbitrum config](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/arbitrum/usdc/configuration.json).

| Chain | Comet | Base token (`configuration.json`) | Evidence |
|---|---|---|---|
| Ethereum (1) | `0xc3d688B66703497DAA19211EEdff47f25384cdc3` | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (6 decimals per market config) | pinned roots/config links above |
| Base (8453) | `0xb125E6687d4313864e53df431d5425969c15Eb2F` | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | pinned roots/config links above |
| Arbitrum One (42161) | `0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf` | USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | pinned roots/config links above |

This is three chains only; other requested networks remain unsubstantiated for Compound in this note. Context7 official Comet docs identify `supply(address,uint256)` and `withdraw(address,uint256)` semantics and `baseToken()` interface. Important: a Comet account's base-token balance is signed; withdrawing base beyond supplied balance is a borrow, subject to collateral/liquidity checks. Therefore withdraw is not universally a withdrawal-only capability. Initial safe scope must constrain base withdraw to no-debt/no-negative resulting account balance, or expose it as separately gated borrow-risk behavior. Do not call arbitrary `withdrawFrom` or destination variants; use owner-as-caller, no third-party account operations. Approval finite and exact for supply. No unlimited approval.

Official docs: [Comet SPEC](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/SPEC.md) and [Comet main interface](https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/contracts/CometMainInterface.sol). This verifies repository-configured addresses, not current live code or market activity; parent explorer/code validation pending.

## Asset provenance and coverage gaps

Pinned Aave entries above show USDC/USDT/WETH availability and metadata; this is registry provenance only. Verify token contract code/decimals and market reserve state independently before activation. Monad USDC/WETH are the exact Monad module entries; no USDT entry exists there. Never substitute a token from another network based on ticker.

No candidate deployment was marked inactive based only on repository configuration. Registry presence does not prove active reserves, deployable code, liquidity, or market usability. Parent's independent read-only deployment validation remains outstanding. No fork tests or transaction simulations were run.

## Excluded candidates / unresolved

- **Compound V3 (Comet):** included for three proven official USDC markets above; no evidence here for remaining four chains.
- **Morpho Blue:** direct supply/withdraw/borrow/repay includes market identifiers and owner/receiver parameters; market whitelist must be reviewed, never accept arbitrary market params or callbacks. No complete official verified chain/market matrix established here. Do not expose callback/leverage flows; require empty callback bytes if ever reviewed.
- **ERC-4626/Morpho/Yearn vaults:** no exact vault deployments with verified underlying, chain coverage, and official current deployment references established. ERC-4626 selector compatibility is not evidence that an arbitrary vault is safe. No vault activation recommendation.

## Source notes

- Official Aave docs provide `supply`, `borrow`, and `repay` signatures. They specify `onBehalfOf`, inactive referral code (`0`), variable borrow mode (`2`), credit-delegation requirement if borrower differs from caller, and max-repay caveat.
- Official address-book docs list module coverage and describe `POOL`, `CHAIN_ID`, and reserve metadata. Registry is maintained code; use immutable Git SHA URLs and independent explorer source/code confirmation in final provenance.
