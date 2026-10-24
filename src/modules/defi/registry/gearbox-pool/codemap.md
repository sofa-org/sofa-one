# Gearbox Pool registry fixture

This folder contains a narrowly scoped, explicit active fixture for the Ethereum Gearbox Pool V3.10 USDC candidate. It exposes only the direct ERC-4626 deposit, mint, withdraw, and redeem selectors using the full function metadata from the pinned Gearbox SDK iPoolV310Abi. The fragment is consumed by focused offline policy tests only; it is not runtime wired, admitted to production, or automatically granted.

`index.ts` defines the four immutable capability identities and policy warnings. `index.spec.ts` binds them to the inactive v6 source snapshot and exercises exact grant, denial, target/chain/selector isolation, canonical calldata, and nonpayable value behavior.
