# SparkLend registry

Defines the four verified Ethereum SparkLend Pool capability ABIs (`supply`, `withdraw`, `borrow`, `repay`) at the official Pool target. The fragment contains only chain, contract, and fixed function policies; it does not assert implementation identity, market listing, liquidity, or transaction success. ABI arguments remain caller-controlled subject to ABI decoding and the shared DeFi policy's exact grant and nonpayable checks. `index.spec.ts` exercises the fragment through the actual reviewed-manifest, catalog, and policy path.
