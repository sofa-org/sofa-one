# Venus registry

Defines 27 exact, source-verified Venus BNB Chain (56) function capabilities: five actions per four ERC-20 vTokens and native vBNB, plus `enterMarkets`/`exitMarket` on the official Unitroller proxy. The fragment lists only capability-bearing contracts; it is not a market inventory or runtime evidence.

All grants are exact function identities at exact addresses. Native vBNB `mint()` and `repayBorrow()` are payable no-argument calls; ERC-20 methods return protocol error codes, not share/amount results. Metadata warns that EVM transaction success may coexist with nonzero Venus error codes and that borrowing carries debt/liquidation/market risk. It introduces no financial authorization checks, approvals, market wildcards, or execution changes.
