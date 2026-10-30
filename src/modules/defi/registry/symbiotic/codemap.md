# Symbiotic registry fixture

`index.ts` contains a standalone source-qualified test fixture for one Ethereum Symbiotic vault. It exposes only the five ordinary nonpayable methods from the pinned IVault interface: deposit, withdraw, redeem, claim, and claimBatch. This fixture is not wired into runtime production policy or a production catalog and grants no user/API key access.

`index.spec.ts` binds the raw inactive v6 source snapshot to the exact fixture ABI and capability identity, then exercises fixed-function policy authorization and canonical ABI behavior. Protocol whitelist/capacity/epoch/claim requirements are documented but are not platform financial filters.
