# Lombard StakedLBTC Fixture

Explicit active test fixture for two nonpayable ordinary redemption methods, keyed to the Ethereum LBTC proxy. The source candidate under `data/defi-catalog/v6/sources/lombard.json` remains inactive; the fixture is not runtime wired or automatically granted.

- `index.ts` defines the exact implementation-source ABI declarations with the user-facing proxy as target.
- `index.spec.ts` validates full selected ABI hashes, source refs and capability IDs, then exercises exact `DefiPolicyService` grants, target/function/chain isolation and canonical bytes encoding.

The listed StakedLBTC implementation is ABI/source evidence only, not a grant target or current implementation-slot assertion. See `docs/defi-research/expansion55-lombard-v6.md` for flow and evidence boundaries.
