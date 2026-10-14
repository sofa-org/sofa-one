# Ethena sUSDe registry fixture

`index.ts` describes a single Ethereum sUSDe V2 test fixture with seven ordinary fixed selectors from its exact-match Sourcify ABI: deposit, mint, cooldownAssets, cooldownShares, unstake, withdraw, and redeem. The fixture is not runtime wired, production admitted, or automatically granted. Sourcify exact-match source semantics are recorded without inferring an upstream Git commit or current contract mode.

`index.spec.ts` checks the inactive raw candidate's exact ABI/hash/source identity and runs each fixed function through the actual DeFi policy service. Conditional cooldown-mode availability and protocol blacklist behavior are documented, not platform argument restrictions.
