# Bancor V3 registry fixture

The directory contains an explicit, pure test-fixture builder for six exact Ethereum BancorNetwork user-proxy methods. It is not imported by the runtime registry, compiler plan, generated catalog, or production admission path. Its active fixture rows exist only so `DefiPolicyService` can exercise the exact reviewed interface; the raw v6 source snapshot remains inactive/candidate.

- `index.ts`: one exact chain-1 proxy and six fixed full-ABI declarations. Capability IDs are stable `bancor-v3:v3:1:<lowercase-target>:<operation>` values. It excludes alternate/arb trades, `depositFor`, flash-loan, and admin methods.
- `index.spec.ts`: checks the raw snapshot against every full ABI (including `internalType`), source-ref closure, exact IDs/selectors, policy grant isolation, canonical calldata, and payable/nonpayable semantics.
- The pinned interface, implementation comments, and owned deployment artifact are documented in [Bancor phase-2 source note](../../../../docs/defi-research/expansion55-bancor-v6.md).

The fixed `deposit(Token pool,uint256 tokenAmount)` uses the base-token/pool side and returns a pool-token amount; it is not a pool-token receipt input. `initWithdrawal(IPoolToken,uint256)` takes the receipt, returns a request ID, and starts the asynchronous withdrawal path. ID-based cancel/withdraw remain protocol-state/eligibility dependent. None of this evidence is a current runtime, liquidity, pool inventory, funded-execution, safety, or success certificate. ERC-20 approvals remain independent and no approval is included or automatically paired.
