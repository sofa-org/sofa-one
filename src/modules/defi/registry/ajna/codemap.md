# Ajna ERC20 Pool Fixture

An isolated active registry fragment for six exact-chain-1 operations on one observed rETH/DAI Ajna ERC20 pool. The v6 source candidate remains inactive; this fragment is used only for offline Catalog/Policy tests and is not runtime wired or automatically granted.

- `index.ts` defines the six fixed source-bound nonpayable ABI functions and pool-target capability IDs.
- `index.spec.ts` asserts source ABI/hash/ID/reference fidelity and exercises actual policy grant, isolation, canonical ABI, and native-value checks.

The factory is discovery evidence and is not a call target. Other markets, liquidation/auction flows, flash loans, multicalls, transfer approvals, and admin functions are excluded. See `docs/defi-research/expansion55-ajna-v6.md` for the bounded observation and evidence limits.
