# DODO V2 fixture registry

This is an explicit source-qualified test fixture for three direct DODOV2Proxy swap methods on Base (8453). It is not imported into production admission and the raw v5 source remains inactive. The fixed ABI excludes generic target/bytes calls, but caller-selected pair routes and all financial arguments remain unrestricted; pair semantics, native-value meaning, bool meaning and route grammar were not independently reviewed. Token approvals remain separate. No funded execution, liquidity, pool eligibility, protocol safety, or complete-coverage claim is made.
