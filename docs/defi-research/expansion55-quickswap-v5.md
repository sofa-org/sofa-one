# QuickSwap V2 Polygon source candidate (v5)

This is prepared offline source evidence, **not currently production-supported**: it has not been admitted into the catalog or assembled into the production registry. It does not assert deployment bytecode identity, pool population, liquidity, execution success, or financial safety.

The official QuickSwap contracts-and-addresses documentation identifies the Polygon PoS V2 router as `0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff` and factory as `0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32`. The factory is source information only, not an authorization target. The ABI declarations are based on the QuickSwap-periphery repository's pinned `IUniswapV2Router01.sol` and `IUniswapV2Router02.sol` interfaces at commit `522a94168b0814d0776d834119df377f03898807`; Router02 extends Router01. Snapshot date: 2026-10-04.

Scope is precisely six ordinary swap methods and four liquidity methods: `swapExactTokensForTokens`, `swapTokensForExactTokens`, `swapExactETHForTokens`, `swapTokensForExactETH`, `swapExactTokensForETH`, `swapETHForExactTokens`, `addLiquidity`, `addLiquidityETH`, `removeLiquidity`, and `removeLiquidityETH`. The three ETH-input methods (`swapExactETHForTokens`, `swapETHForExactTokens`, `addLiquidityETH`) are payable; the other seven are nonpayable. No permit, fee-on-transfer, multicall, quote/read-only method, or executor is included. This bounded function set is not a claim to support all of QuickSwap, V3, or the complete pool population.

Every API key must explicitly grant an exact capability ID. Allowances remain independent: this family does not add or imply token approvals. No protocol-specific amount, recipient, path, slippage, or deadline constraints are provided.
