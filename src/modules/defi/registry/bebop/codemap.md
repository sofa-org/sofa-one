# Bebop isolated registry fixture

`index.ts` exposes one source-qualified Ethereum BOP AMM router swap for isolated catalog/policy tests. It is deliberately inactive as a v7 source candidate, not imported by runtime manifests, not an admission, and never automatically granted. `index.spec.ts` pins ABI/function identity and tests exact-grant and calldata policy behavior. Scope is not Bebop RFQ or full routing support.
