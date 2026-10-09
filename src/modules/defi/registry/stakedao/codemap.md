# StakeDAO CRV Depositor Fixture

An explicit active registry fragment for the two pinned Ethereum CRV Depositor user entrypoints, intended only for offline catalog/policy tests. The source candidate in `data/defi-catalog/v6/sources/stakedao.json` remains inactive; this fixture is not runtime wired or automatically granted.

- `index.ts` contains exact Sourcify ABI declarations and stable capability IDs for `deposit` and `depositAll`.
- `index.spec.ts` checks the source snapshot binding and exercises exact policy grants, call isolation, canonical ABI encoding, and caller-controlled parameters.

The SDCRV gauge proxy shell is not a selected target. See `docs/defi-research/expansion55-stakedao-v6.md` for source-role and workflow limitations.
