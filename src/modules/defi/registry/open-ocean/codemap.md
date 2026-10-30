# OpenOcean isolated registry fixture

`index.ts` exposes three source-qualified Ethereum proxy methods for bounded Uniswap-family route execution in isolated Catalog/Policy tests. The v7 source candidate is inactive; it is not admitted, runtime-wired, or automatically granted. `index.spec.ts` pins exact ABI identity and exercises exact-grant and canonical-calldata policy behavior. This is not complete OpenOcean routing or product coverage.
