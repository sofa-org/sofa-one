# iZUMi Ethereum fixed-function source candidate (v6)

This bounded candidate uses the pinned official `izumiFinance/iZiSwap-periphery` source revision `69d6e509779306ecf05c878cc64e4a74b082ecd3` (HEAD observed by the source researcher on 2026-10-04). Its `scripts/deployed.js` configuration lists these Ethereum roles:

| Role | Address |
| --- | --- |
| Swap | `0x2db0AFD0045F3518c77eC6591a542e326Befd3D7` |
| LiquidityManager | `0x19b683A2F45012318d9B2aE1280d68d3eC54D663` |

The deployment script does not record a deployment block or timestamp. The source-role configuration is not a current runtime identity, deployment-date, or funded-execution claim. The selected declarations come from the same revision's `contracts/interfaces/ISwap.sol` and `contracts/interfaces/ILiquidityManager.sol`; source snapshots preserve the entire ABI tuple objects, component names, and `internalType` metadata.

Exactly five methods are included:

| Target | Method and fixed ABI | Mutability and declared returns |
| --- | --- | --- |
| Swap | `swapAmount((bytes path,address recipient,uint128 amount,uint256 minAcquired,uint256 deadline) params)`; tuple `internalType: struct ISwap.SwapAmountParams` | Payable; `(uint256 cost,uint256 acquire)` |
| LiquidityManager | `mint((address miner,address tokenX,address tokenY,uint24 fee,int24 pl,int24 pr,uint128 xLim,uint128 yLim,uint128 amountXMin,uint128 amountYMin,uint256 deadline) mintParam)`; tuple `internalType: struct ILiquidityManager.MintParam` | Payable; `(uint256 lid,uint128 liquidity,uint256 amountX,uint256 amountY)` |
| LiquidityManager | `addLiquidity((uint256 lid,uint128 xLim,uint128 yLim,uint128 amountXMin,uint128 amountYMin,uint256 deadline) addLiquidityParam)`; tuple `internalType: struct ILiquidityManager.AddLiquidityParam` | Payable; `(uint128 liquidityDelta,uint256 amountX,uint256 amountY)` |
| LiquidityManager | `decLiquidity(uint256 lid,uint128 liquidDelta,uint256 amountXMin,uint256 amountYMin,uint256 deadline)` | Nonpayable; `(uint256 amountX,uint256 amountY)` |
| LiquidityManager | `collect(address recipient,uint256 lid,uint128 amountXLim,uint128 amountYLim)` | Payable; `(uint256 amountX,uint256 amountY)` |

The `swapAmount` path is protocol-encoded token/fee/token routing data (the fixture test uses a structurally encoded single-hop sample); arbitrary byte strings do not thereby establish pool existence, liquidity, or callback safety. Protocol path routing and pool/NFT callback behavior are not arbitrary wallet-child execution. This fixture adds no generic executor, permit, multicall, or callback-method authority.

Caller-selected ABI-valid path, tokens, miner, recipient, fee, price range, amounts, limits, deadlines, and payable value remain uncapped by this platform. NFT ownership, approvals, route/pool eligibility, and liquidity remain independent protocol prerequisites, not automatic grants or validation constraints. The stable permission templates are `izumi:v1:1:<lowercase-target>:swap-amount`, `:mint`, `:add-liquidity`, `:dec-liquidity`, and `:collect`; the family source revision `periphery@69d6e509` is metadata, not a permission-version wildcard.

`data/defi-catalog/v6/sources/izumi.json` is an inactive candidate snapshot. `buildIZumiRegistry()` is an explicit active fragment only for the isolated Catalog/Policy tests; it is not runtime-wired or granted to users. These five functions do not establish complete markets/workflows, current runtime identity, pool availability, liquidity, funded execution, or full iZUMi support.
