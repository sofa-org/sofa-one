# DeFi catalog workflow

The current catalog source is `data/defi-catalog/catalog.json`. The offline CLI validates this reviewed input and deterministically generates the static TypeScript module consumed by the runtime. Runtime authorization does not discover or load source snapshots or plans.

From the repository root:

```sh
npm run defi:catalog:generate
npm run defi:catalog:check
npm run defi:catalog:diff
```

`generate` updates the generated runtime module; `check` validates that it matches the catalog; `diff` reports catalog changes. These commands are offline and make no network, RPC, or database calls. Catalog entries are function metadata, not API-key grants. Profiles are reviewed metadata groupings only: they do not grant capabilities, expand effective permissions, or prove a complete workflow.

Catalog admission records source and ABI identity. It does not establish deployed runtime identity, funding, balances, liquidity, successful execution, complete workflows, or financial safety. Existing authorization, grant, pause, and execution controls remain independent and must not be weakened based on catalog membership.
