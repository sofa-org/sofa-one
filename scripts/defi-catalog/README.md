# DeFi catalog workflow

The current catalog source is `data/defi-catalog/catalog.json`. The offline CLI validates this reviewed input and deterministically generates the static TypeScript module consumed by the runtime. Runtime authorization does not discover or load source snapshots or plans.

## Lean admission path

Use a contract-first inventory: **chain and exact deployed address → matching ABI → function inventory → capability records → existing catalog workflow**. Establish the chain/address from a reliable deployment source and bind the ABI to that deployment using a reliable ABI source. Where a proxy is involved, match the proxy address and the applicable implementation/interface; record the relevant implementation identity when available. These are inventory evidence, not proof of current runtime bytecode identity, funding, or executable behavior.

Enumerate ABI `function` entries as the callable interface surface. ABI entries do not say whether a function was declared `public` or `external`; either appears as a function. Internal/private functions are not part of this ABI surface. Do not create function capabilities for constructors, `fallback`, or `receive`. Retain `view`/`pure` mutability metadata, without implying that a read endpoint exists. Identify functions by their full canonical signature, not name alone: include canonical tuple component types and array suffixes (for example, `f((address,uint256)[],uint8)`). Overloads are supported when their selectors differ; the manifest rejects selector collisions, not repeated function names.

The capability identity remains the existing chain + exact address + full canonical signature, bound to the fixed ABI fragment and existing catalog ID/schema. Inventory is not automatic activation: ordinary entries can be recorded without requiring full-workflow, market-coverage, liquidity, funding, or financial-safety research as admission prerequisites. Keep security-sensitive functions and opaque multicall/executor surfaces unactivated unless they fit the existing independently required execution controls; give every unactivated entry a specific reason. This is not a new per-function financial-review process.

The current generator consumes per-function records in `catalog.json`; it does **not** import and enumerate an entire ABI. Whole-ABI enumeration is a small future tooling step, not implemented here. It should produce/review the same existing records and IDs rather than add a schema, DSL, service, or runtime discovery path. Do not write API-key grants automatically. In `capabilityMode: all`, active, unpaused reviewed capabilities may be used subject to all independent gates; `custom` uses the exact configured IDs and `custom` with `[]` denies catalog capabilities. Catalog updates do not trigger automatic grant writes or imply that every new function requires an explicit regrant in `all` mode.

From the repository root:

```sh
npm run defi:catalog:generate
npm run defi:catalog:check
npm run defi:catalog:diff
```

`generate` updates the generated runtime module; `check` validates that it matches the catalog; `diff` reports catalog changes. These commands are offline and make no network, RPC, or database calls. Catalog entries are function metadata, not API-key grants. Profiles are reviewed metadata groupings only: they do not grant capabilities, expand effective permissions, or prove a complete workflow.

Catalog admission records deployment-source and ABI-binding evidence. It does not establish deployed runtime identity, funding, balances, liquidity, successful execution, complete workflows, or financial safety. Preserve canonical ABI decoding, authorization, pause checks, final rechecks, and signing/execution boundaries; catalog membership does not bypass any independent control.
