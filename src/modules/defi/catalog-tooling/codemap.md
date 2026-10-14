# DeFi catalog tooling

The catalog tooling validates the single reviewed input at `data/defi-catalog/catalog.json` and generates/checks/diffs the deterministic static runtime module. It is offline; runtime imports the generated module and never discovers source snapshots or plans. Catalog functions do not grant API-key capabilities, and profile metadata does not grant permissions. Catalog/source review does not establish deployed runtime identity, funding, balances, liquidity, complete workflows, or financial safety.

The generator strictly validates catalog data, canonical ABI identity, source references, execution scopes, and explicit reviewed admissions. It produces deterministic static output. Historical research documents may describe prior snapshots but are not part of the current maintenance workflow. Neither admission nor generated catalog membership assigns grants or validates financial arguments, deployment/runtime identity, funding, or customer execution readiness.
