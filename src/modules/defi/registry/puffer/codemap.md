# Puffer registry fixture

## Responsibility
Standalone Ethereum test fixture for seven source-qualified Puffer calls. It is not imported by runtime production registry and grants no API-key capabilities.

## Files and authority
- `index.ts`: reviewed active test fragment using listed implementation V5 ABI and stable `puffer:v5-snapshot:1:<proxy>:<operation>` identifiers.
- `index.spec.ts`: raw inactive-source correspondence plus exact policy authorization, grant isolation, ABI canonicality and payability tests.
- `data/defi-catalog/v6/sources/puffer.json`: inactive source candidates and four-key dated provenance records.
- `docs/defi-research/expansion55-puffer-v6.md`: source scope and limitations.

## Boundaries
No production wiring/admission or automatic grants. The stable identifier denotes this fixed source snapshot, not a live deployed-version assertion. The async withdrawal finalizer role is not treated as an ordinary-user claim path.
