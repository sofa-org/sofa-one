# SushiSwap V2 registry

## Responsibility
Source-backed fixed-function capability fragment for SushiSwap V2 classic routers on six explicitly listed chains. It grants only ten direct swap/liquidity function definitions per chain; it does not add approvals or constrain caller-selected financial arguments.

## Files and boundaries
- `index.ts` builds the six-chain fragment from the pinned official SDK deployment rows and the ten fixed ABI definitions.
- `index.spec.ts` verifies exact methods, chain/contract-separated identities, ABI shapes, and grant-aware authorization behavior.

Monad, permit, fee-on-transfer, quote/view, multicall, RouteProcessor, Universal Router, and generic execution functions are excluded.
