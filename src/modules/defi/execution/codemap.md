# DeFi execution planning

This leaf owns pure, versioned execution-language identity and the immutable
execution-plan contract. Scope hashing is deterministic; it has no database,
provider, or financial-policy responsibilities. The exact Enso v8 proposal binds
one payable `routeSingle((uint8,bytes),bytes)` root to the closed
`enso-static-weiroll-v1` scope and three existing v7 children. Runtime decoding,
plan commitment, root/child grant checks, and initial/final authorization remain
at the DeFi policy boundary. V8 source/admission/catalog wiring is locally
integrated but has not passed mandatory Gate 4; no current constructor/runtime,
funding, liquidity, or complete-workflow claim follows.
