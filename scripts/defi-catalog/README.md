# DeFi catalog workflow

The current catalog source is `data/defi-catalog/catalog.json`. Offline tooling validates this reviewed input and deterministically generates the static TypeScript module consumed by the runtime. Runtime authorization does not discover or load source snapshots or plans.

## Lean admission path

Use a contract-first inventory: **chain and exact deployed address → matching ABI → function inventory → capability records → existing catalog workflow**. Establish the chain/address from a reliable deployment source and bind the ABI to that deployment using a reliable ABI source. Where a proxy is involved, match the proxy address and the applicable implementation/interface; record the relevant implementation identity when available. These are inventory evidence, not proof of current runtime bytecode identity, funding, or executable behavior.

Enumerate ABI `function` entries as the callable interface surface. ABI entries do not say whether a function was declared `public` or `external`; either appears as a function. Internal/private functions are not part of this ABI surface. Do not create function capabilities for constructors, `fallback`, or `receive`. Retain `view`/`pure` mutability metadata, without implying that a read endpoint exists. Identify functions by their full canonical signature, not name alone: include canonical tuple component types and array suffixes (for example, `f((address,uint256)[],uint8)`). Overloads are supported when their selectors differ; the manifest rejects selector collisions, not repeated function names.

The capability identity remains the existing chain + exact address + full canonical signature, bound to the fixed ABI fragment and existing catalog ID/schema. Inventory is not automatic activation: ordinary entries can be recorded without requiring full-workflow, market-coverage, liquidity, funding, or financial-safety research as admission prerequisites. Keep security-sensitive functions and opaque multicall/executor surfaces unactivated unless they fit the existing independently required execution controls; give every unactivated entry a specific reason. This is not a new per-function financial-review process.

The inventory helper emits schema-v1 per-function records for manual review; it does not import into or write `catalog.json`. It requires explicit chain, address, protocol, deployment evidence and ABI evidence. Both evidence records carry `sourceRef`, `verifiedAt`, `chainId`, and `address`, and must match the supplied deployment identity. Input is a local JSON file with those fields and the ABI array; run `npm run defi:catalog:inventory -- path/to/input.json`. The helper makes no network/RPC/database calls and writes only drafts to stdout. Drafts and their hierarchy are inactive, provenance is `candidate`, and each function has an explicit review reason. Review/edit selected records and merge them into `data/defi-catalog/catalog.json` manually; never activate an ABI wholesale or write API-key grants. In `capabilityMode: all`, active, unpaused reviewed capabilities may be used subject to all independent gates; `custom` uses exact configured IDs and `custom` with `[]` denies catalog capabilities.

Minimal draft → review → generate/check workflow, from the repository root:

```sh
npm run defi:catalog:generate
npm run defi:catalog:check
```

Optionally run `npm run defi:catalog:diff` to review catalog changes. `generate` updates the generated runtime module; `check` validates that it matches the catalog. Review the diff, generated output and each record before admission. Catalog entries are function metadata, not API-key grants. Profiles are reviewed metadata groupings only.

These commands are offline and make no network, RPC, or database calls. Profiles do not grant capabilities, expand effective permissions, or prove a complete workflow.

Catalog admission records deployment-source and ABI-binding evidence. It does not establish deployed runtime identity, funding, balances, liquidity, successful execution, complete workflows, or financial safety. Preserve canonical ABI decoding, authorization, pause checks, final rechecks, and signing/execution boundaries; catalog membership does not bypass any independent control.
