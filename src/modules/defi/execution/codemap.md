# DeFi execution planning

This leaf owns pure, versioned execution-language identity, bounded wire
preflight and the immutable execution-plan contract. It has no database,
provider or financial-safety responsibilities.

- `scope.ts` normalizes and hashes the exact scope contract, validates finite
  root/child bindings and pins the admitted registered-adapter identities.
- `planner.ts` bounds canonical array/tuple payloads before ABI decoding and
  shares the ten-call-node and aggregate-calldata limits across a request.
- `financial-multicall-signatures.ts` is the explicit financial/Pendle signature
  vocabulary. Runtime never discovers selectors from source snapshots or ABIs.
- `uniswap-identity.ts` reserves the known router/position-manager identities;
  the Uniswap wire/action decoders retain their own shared 64-operation budget,
  recipient, hook-data, settlement, full-drain and touched-target rules.
- `uniswap-router.ts` selects both exact `execute` overload ABIs before bounded
  decoding. The two-argument form has no deadline; both retain the same closed
  command language, operation/custody rules and separately granted PM children.
- `uniswap-v4-primitive.ts` binds direct-only pool initialization and incoming
  approved NFT transfers to exact PM ABIs, zero native value, hookless keys,
  wallet-only NFT recipients and empty safe-transfer bytes. PoolManager and
  supplied initialization currencies join initial/final pause checks; stored
  subscribers and receiver callbacks remain possible.
- `merkl.ts` reserves the three reviewed Distributor claim identities and
  requires every per-claim callback-data element to be empty. It reuses the
  bounded recursive wire decoder for all claim/proof arrays; it does not
  simulate proofs, grant operators or admit financial multicall composition.
- `zero-ex-nft.ts` reserves eight exact Ethereum proxy settlement interfaces.
  It excludes all supplied taker/fee callback data and property validators
  before authorizing buys, sells or matching; fixed ERC1155 receiver hooks
  and ordinary token/native recipient behavior remain possible.
- `umami.ts` binds two exact payable request ABIs to zero chosen callback
  addresses; configured hooks and asynchronous settlement are not disabled.
- `flexa.ts` binds empty approval-signature staking to the reviewed proxy and,
  for the cross-pool-shaped selector, its exact self address. It consumes
  existing Anvil collateral/allowance and does not install new permission.
- `velora.ts` binds six exact RFQ settlement ABIs to empty maker/taker permit
  bytes in every supplied item, retaining maker proof and fixed financial
  partial-fill/batch behavior. Targets are recipients, not arbitrary executors.
- `revert-lending.ts` binds three exact empty-Permit2-data lending/repayment
  overloads to existing USDC allowance, without reserving their ordinary
  overload names or widening any existing multicall child graph.
- `napier.ts` binds both collectors to per-input zero permit deadlines,
  skipping authority calls entirely. Factory registration, prior collector
  approval, accrued balances and configured reward/token behavior remain.

Finite self-delegatecall wrappers bind same-chain/same-target active children
by capability ID, ABI hash and, where applicable, execution-scope hash.
Financial roots may compose only explicitly supported empty-callback,
empty-tuple-bytes and fixed-adapter leaf scopes. Pendle optional failures do not
skip authorization of attempted children. V4 manager multicalls compose only
the bound existing `modifyLiquidities` action scope and preserve the original
caller; they do not make arbitrary nested wrappers valid.

Runtime decoding, request/manifest commitments, root/child grants, pauses and
initial/final authorization remain at the DeFi policy boundary. Typed Morpho
market bytes and empty Maple exit bytes constrain execution syntax, not market
eligibility, balances, permissions, liquidity or financial safety.

The exact Enso v8 proposal binds payable
`routeSingle((uint8,bytes),bytes)` to `enso-static-weiroll-v1` and three existing
v7 children. Its source/admission/catalog wiring is locally integrated but has
not passed mandatory Gate 4; no current constructor/runtime, funding,
liquidity or complete-workflow claim follows.
