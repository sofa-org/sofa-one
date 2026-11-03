# LFJ Liquidity Book V2.2 Arbitrum One source candidate (v5)

Prepared offline candidate only: not admitted or assembled into the production registry and not currently production-supported. No runtime deployment-bytecode verification, execution, financial safety, pool inventory, liquidity, or whole-family coverage is claimed.

Official deployment documentation: https://developers.lfj.gg/deployment-addresses/arbitrum.md. Exact target 0x18556DA13313f3532c54711497A8FedAC273220E on chain 42161. Address-specific Sourcify ABI record: https://sourcify.dev/server/v2/contract/42161/0x18556DA13313f3532c54711497A8FedAC273220E?fields=abi,sources,metadata. Provider metadata reports verifiedAt `2024-08-08T15:03:35Z`, match `exact_match`, chain/address `42161` / `0x18556DA13313f3532c54711497A8FedAC273220E`. Retrieved 2026-10-04; no Git commit pin is claimed. Factory addresses are source information only and are not authorized targets.

Exactly three ordinary nonpayable functions are represented, with parameter names/types and named outputs copied from the address-specific ABI record: addLiquidity, removeLiquidity, swapExactTokensForTokens. No guessed generic router overloads, approvals, permit, NFT/operator, or arbitrary executor functions are in scope. LP-token approvals remain independent and are not supplied by this registry. Caller ABI arguments are structurally decoded but have no protocol-specific financial bounds. This small selector set does not assert whole-protocol, pair, or market coverage.

The official V2.2 guide explicitly warns that V2.2 is not backwards-compatible with V2.1 pairs. The third source record is the official V2.2 guide. No legacy/testnet configuration is used as deployment proof.
