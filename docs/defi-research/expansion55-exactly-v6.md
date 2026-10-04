# Exactly OP Mainnet fixed-market source candidate (v6)

This is a bounded, inactive source candidate and a separate explicit active test fixture—not a production registry integration, recommendation, automatic grant, or funded workflow certification. The official [Exactly smart-contract address guide](https://docs.exact.ly/guides/smart-contract-addresses.md) lists these OP Mainnet deployments:

| Role | Address |
| --- | --- |
| Market USDC | `0x6926B434CCe9b5b7966aE1BfEef6D0A7DCF3A8bb` |
| Market WETH | `0xc4d4500326981eacD020e20A81b1c479c161c7EF` |
| Auditor | `0xaEb62e6F27BC103702E7BC879AE98bceA56f027E` |

The selected declarations are source-bound to Exactly protocol commit `4b5fec78f02825d34b15276292fef804607e375e` (`contracts/Market.sol`, `contracts/Auditor.sol`). Market imports Solmate `src/mixins/ERC4626.sol` from the upstream `transmissions11/solmate` v7 tag. The v7 raw source URL is recorded in the source snapshot and declares inherited `deposit(assets,receiver) -> shares` and `mint(shares,receiver) -> assets`. A mechanical `git ls-remote` check did not return the v7 tag object; the tag is used as cited, without claiming an independently resolved commit SHA. No upstream code was executed or installed.

The fixture contains exactly these ten nonpayable methods on each selected Market:

| Method | Inputs | Declared outputs |
| --- | --- | --- |
| `deposit` | `uint256 assets, address receiver` | `uint256 shares` |
| `mint` | `uint256 shares, address receiver` | `uint256 assets` |
| `withdraw` | `uint256 assets, address receiver, address owner` | `uint256 shares` |
| `redeem` | `uint256 shares, address receiver, address owner` | `uint256 assets` |
| `borrow` | `uint256 assets, address receiver, address borrower` | `uint256 borrowShares` |
| `repay` | `uint256 assets, address borrower` | `uint256 actualRepay, uint256 borrowShares` |
| `depositAtMaturity` | `uint256 maturity, uint256 assets, uint256 minAssetsRequired, address receiver` | `uint256 positionAssets` |
| `borrowAtMaturity` | `uint256 maturity, uint256 assets, uint256 maxAssets, address receiver, address borrower` | `uint256 assetsOwed` |
| `withdrawAtMaturity` | `uint256 maturity, uint256 positionAssets, uint256 minAssetsRequired, address receiver, address owner` | `uint256 assetsDiscounted` |
| `repayAtMaturity` | `uint256 maturity, uint256 positionAssets, uint256 maxAssets, address borrower` | `uint256 actualRepayAssets` |

The Auditor fixture adds only nonpayable `enterMarket(address market)` and `exitMarket(address market)`, both with no outputs; the source ABI identifies the argument as `contract Market`. Return declarations are preserved as protocol units and are not treated as protocol error codes.

Every ABI-valid amount, maturity, minimum/maximum, receiver, owner, borrower, and market argument remains caller-controlled and uncapped by this platform. Exactly's own market configuration, allowance/funding, solvency, and available liquidity are intrinsic prerequisites; they are not safety promises or admission tests. Token approvals remain independent, are not included here, and are never automatically paired. The fixture's stable IDs (`exactly:v1:10:<lowercase-target>:<hyphenated-method>`) are exact function permission templates, not production admission or grants.

The two fixed Markets and one Auditor are a small address-qualified subset only. This does not establish current market status, live runtime identity, liquidity, economic success, funded execution, whole-protocol coverage, or a complete user workflow. The raw snapshot is `data/defi-catalog/v6/sources/exactly.json` and remains inactive; only `buildExactlyRegistry()` exposes an active fragment to its isolated tests.
