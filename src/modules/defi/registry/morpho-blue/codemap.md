# Morpho Blue registry

`buildMorphoBlueRegistry()` provides three fixed, source-verified direct methods—`borrow`, `withdraw`, and `withdrawCollateral`—on Ethereum and Base (six definitions total). The MarketParams tuple follows official component order; callers select all ABI arguments. Callback-bearing `supply`, `supplyCollateral`, and `repay` functions are excluded, so these capabilities do not cover complete position creation. No financial/market validators.
