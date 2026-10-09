# Velora Augustus RFQ Ethereum bounded source candidate (v7)

This is a source-qualified four-method candidate on the Ethereum Augustus RFQ address `0xe92b586627ccA7a83dC919cc7127196d70f55a06`. The pinned official `VeloraDEX/paraswap-dex-lib` revision `a36949e4d7fcc47c39083ca61622e48cb5be0e6b` (2026-10-01) maps `Network.MAINNET` to this address in `src/dex/augustus-rfq.ts`. Its `src/abi/paraswap-limit-orders/AugustusRFQ.abi.json` has SHA-256 `f506c534b5ad5e3de08249cef66f3eb2cad31dfdd6e69557b65493241cc9f0a3`. The address's Etherscan-verified source/ABI bundle was reviewed by Oracle and matched the pinned ABI; the verified `AugustusRFQ.sol` source bundle SHA-256 is `55152e064eac6b36c1b6f3501e3d6074aae12b067059c4bec85937ceab20ffb9`.

## Selected fixed ABI surface

| Method | Exact selector | Mutability and outputs |
| --- | --- | --- |
| `fillOrder((uint256,uint128,address,address,address,address,uint256,uint256),bytes)` | `0x98f9b46b` | nonpayable; no outputs |
| `partialFillOrder((uint256,uint128,address,address,address,address,uint256,uint256),bytes,uint256)` | `0xc88ae6dc` | nonpayable; `makerTokenFilledAmount:uint256` |
| `cancelOrder(bytes32)` | `0x7489ec23` | nonpayable; no outputs |
| `cancelOrders(bytes32[])` | `0x21c77c96` | nonpayable; no outputs |

The two fill methods take `struct AugustusRFQ.Order order` with fields in exact order: `uint256 nonceAndMeta`, `uint128 expiry`, `address makerAsset`, `address takerAsset`, `address maker`, `address taker`, `uint256 makerAmount`, `uint256 takerAmount`. `fillOrder` adds `bytes signature`; `partialFillOrder` adds `bytes signature` and `uint256 takerTokenFillAmount`, returning `uint256 makerTokenFilledAmount`. ABI names, outputs, component names, internalTypes, ordering and mutability are retained literally in both source and fixture.

## Bounded behavior and evidence limits

The pinned source shows fixed fill settlement: `msg.sender` is the taker and the fill recipient, and taker-side transfer is sourced from `msg.sender`; token movement uses the source's fixed `transferFrom` path. Order checks include signature validation using `SignatureChecker` (including ERC-1271 staticcall behavior); cancellation operates on caller/order state. These are protocol implementation semantics, not new platform filters. Order assets, maker/taker values, amounts, partial fill size and signature bytes remain caller-controlled subject only to canonical ABI encoding; the source candidate introduces no platform financial cap, recipient restriction, feed check, or approval pairing. The selected functions themselves include neither a generic child call nor permit arguments; token approvals remain separate authority.

The wider ABI's batch and NFT methods, permit-bearing methods, and other `WithTarget` methods are outside this four-method selection. The source's `WithTarget` argument is a token-recipient argument, not an arbitrary execution target. Their omission here is only the boundary of this candidate, not a platform security restriction. This snapshot does not establish current runtime identity, current order state, liquidity, user funds, funded execution, transaction success, complete swap/exit workflows, or complete Velora/Augustus v6 coverage. The active builder is isolated to tests and grants no capability by itself.

Sources: [pinned official Augustus RFQ adapter](https://raw.githubusercontent.com/VeloraDEX/paraswap-dex-lib/a36949e4d7fcc47c39083ca61622e48cb5be0e6b/src/dex/augustus-rfq.ts); [pinned full ABI JSON](https://raw.githubusercontent.com/VeloraDEX/paraswap-dex-lib/a36949e4d7fcc47c39083ca61622e48cb5be0e6b/src/abi/paraswap-limit-orders/AugustusRFQ.abi.json); [Etherscan-verified address source and ABI](https://etherscan.io/address/0xe92b586627ccA7a83dC919cc7127196d70f55a06#code).
