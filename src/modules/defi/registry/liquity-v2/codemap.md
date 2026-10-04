# Liquity V2 WETH candidate fixture

## Responsibility
Standalone Ethereum WETH-branch test fixture for seven BorrowerOperations and three StabilityPool functions. No production registry import or API-key grants.

## Files and authority
- `index.ts`: reviewed active test-only fragment with exact `liquity-v2:v2-weth:1:<lowercase-target>:<operation>` IDs.
- `index.spec.ts`: ten-function inactive-source correspondence and actual catalog/policy authorization matrix.
- `data/defi-catalog/v6/sources/liquity.json`: inactive candidates and pinned source/address provenance.
- `docs/defi-research/expansion55-liquity-v6.md`: scope and limitations.

## Boundaries
WETH branch only. Collateral/BOLD metadata does not imply token grants or approvals. No batch manager, zapper, permit, admin, general executor, alternate collateral branch or runtime readiness claim.
