# Expansion 55: 1inch AggregationRouterV6 v7 source candidate

## Scope and disposition

This bounded candidate contains exactly twelve Ethereum chain 1 AggregationRouterV6 entries at `0x111111125421ca6dc452d289314280a0f8842a65`: six `unoswap`/`unoswapTo` one-, two-, and three-route methods and their six payable `ethUnoswap` counterparts. It excludes generic `swap`, RFQ, batch, and all other unrelated selectors. This is one exact router address, not pool children or execution scopes. The source contract is `inactive`; the isolated test builder is not production-wired, admitted, or automatically granted.

The complete ABI declarations are copied from pinned official `1inch/1inch-sdk` commit `321b27436ff7f9ca5d3990006e2d88728780eda0`, `constants/abi/aggregationRouterV6.abi.json`, and compared with the verified Etherscan exact-match contract ABI. Every method returns `uint256 returnAmount`; route-word arguments have ABI type `uint256` and documented `internalType: Address`, including `token`, `to`, and `dex`/`dex2`/`dex3` where present. The candidate preserves all exact input names, outputs, internal types, and mutability. Source URLs and retrieval date are recorded in `data/defi-catalog/v7/sources/one-inch.json`.

Selectors recorded by the fixture are `unoswap` `0x83800a8e`, `unoswap2` `0x8770ba91`, `unoswap3` `0x19367472`, `unoswapTo` `0xe2c95c82`, `unoswapTo2` `0xea76dddf`, `unoswapTo3` `0xf7a70056`, `ethUnoswap` `0xa76dfc3b`, `ethUnoswap2` `0x89af926a`, `ethUnoswap3` `0x188ac35d`, `ethUnoswapTo` `0x175accdc`, `ethUnoswapTo2` `0x0f449d71`, and `ethUnoswapTo3` `0x493189f0`.

## Body review and limits

The reviewed router paths dispatch one to three fixed protocol hops using V2/V3/Curve-specific route handling. V2 uses fixed swap calls; V3 uses the fixed swap flow and router-generated payer callbacks; Curve uses fixed exchange selectors and constructs exchange arguments internally. These paths are not arbitrary wallet calls. Permit2/payment handling is protocol code and does not create an API-key grant or wallet approval capability.

Do not infer universal pool authentication: V3 canonical factory/pool validation applies to the external-payer callback branch, not the router-balance branch or every protocol path. Curve's fixed token-transfer callback operates against router-held balances and assumes there are no stranded router funds. Packed route words encode fields, but this fixture does not authenticate their token/pool identities. No claim is made about every pool/path, complete workflows, current runtime, liquidity, funded execution, or financial safety.

All ABI financial arguments remain caller-selected: packed route words, token, amount, minimum return, recipient, directions/fees, and payable native value. No platform amount caps, asset-pairing, recipient, fee, pool, or feed restrictions are imposed. Required allowances/Permit2 conditions remain separate and are never automatic. The function-level fixture tests policy/canonical ABI behavior only; they do not execute protocol swaps or establish economic outcomes.

At baseline `74bb052ec003656e5810d5af42d50a300e94aad3`, production remains 640 definitions (617 actions and 23 independent approvals), 15 scopes, and 62 profiles. No admission, generated catalog/profile, runtime, shared-map, or existing-grant changes are made by this candidate; it does not establish all of 1inch, all of expansion 55, or 90% market coverage.
