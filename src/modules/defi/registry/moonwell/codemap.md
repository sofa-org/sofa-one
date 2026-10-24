# Moonwell registry fixture

Provides an explicitly invoked Base Moonwell fixed-function registry fragment and its policy tests. It is not imported by the production registry or runtime catalog. The three listed mTokens each declare five nonpayable calls; the Comptroller declares enterMarkets and exitMarket. Source provenance is pinned, while source/deployment correspondence, live market status, and funded execution are not established.

The capability surface intentionally excludes approvals, native ETH, repayBorrowBehalf, liquidations, and broad operator methods. Arguments remain caller-controlled under existing generic policy; protocol error-code returns must not be interpreted as transferred amounts or proof of successful protocol action.
