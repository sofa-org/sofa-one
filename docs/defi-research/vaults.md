# Morpho USDC vault candidates (discovery evidence, not approval)

Snapshot date: 2026-10-02 UTC (API requests made on this date; time not recorded). This is a discovery/provenance note only. Neither candidate is called safe, vetted, or enabled. Parent session owns read-only onchain deployment validation. No transactions or writes to chain performed.

## Official discovery method and sources

Morpho's official docs specify the GraphQL endpoint [`https://api.morpho.org/graphql`](https://docs.morpho.org/developers/api/morpho-vaults) and list/query `vaultV2s` with chain filters and `listed` status ([official tutorial](https://docs.morpho.org/developers/earn/tutorials/get-data)). I submitted read-only GraphQL POST requests with `content-type: application/json` and an operation-name header. Query for current registry inventory:

```graphql
query ListedVaultCandidates {
  vaultV2s(first: 1000, where: { chainId_in: [1, 8453], listed: true }) {
    items {
      address name symbol listed
      asset { address decimals }
      chain { id network }
    }
  }
}
```

At retrieval, API returned 151 listed VaultV2 results across these chains. It exposed, among others, a listed Ethereum USDC candidate and a listed Base USDC candidate below. Listing is a discovery signal, not endorsement or safety judgment. Official API is live and not an immutable snapshot; query text/date are recorded but no response hash or versioned API snapshot is available.

For detailed roles and factory, I queried `vaultV2ByAddress(address,chainId)` including `curator { address }`, `owner { address }`, `factory { address }`, `type`, `asset`, and `adapters`. Official docs describe VaultV2 as ERC-4626-compatible and provide its call signatures. Morpho Vault V2 documentation describes immutable deployments (no upgrades possible after deployment) and a role model where owner appoints curator/sentinels, curator manages risk config (many actions timelocked), and allocator executes allocations. This documents the family design, but does not independently prove candidate bytecode, proxy absence, role state, or address correctness on chain.

## Two USDC candidate records

| Chain | Candidate from official API | Vault | Asset from API (decimals) | Curator / owner from API | Factory / type / adapter |
|---|---|---|---|---|---|
| Ethereum (1) | Keyrock USDC (`kUSDC`), `listed:true` | `0x04422053aDDbc9bB2759b248B574e3FCA76Bc145` | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (6) | curator `0xbA75546ACD56b3a9142f94F179b03970eE4283Fd`; owner same | factory `0xA1D94F746dEfa1928926b84fB2596c06926C0405`; type `MorphoVault`; one API-reported `MorphoMarketV1` adapter `0x7CA32dCD9269b0BeB21a4F364DED5cfFCB7b3635` |
| Base (8453) | Gauntlet USDC Prime (`gtusdcp`), `listed:true` | `0x050cE30b927Da55177A4914EC73480238BAD56f0` | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6) | curator `0x9E33faAE38ff641094fa68c65c2cE600b3410585`; owner `0x5a4E19842e09000a582c20A4f524C26Fb48Dd4D0` | factory `0x4501125508079A99ebBebCE205DeC9593C2b5857`; type `MorphoVault`; one API-reported `MorphoMarketV1` adapter `0x2fEcd40f436CA170D2478a58Da898FcE93988eef` |

Official API point lookups: [`vaultV2ByAddress` Ethereum](https://api.morpho.org/graphql) with `{address:"0x04422053aDDbc9bB2759b248B574e3FCA76Bc145",chainId:1}`; [`vaultV2ByAddress` Base](https://api.morpho.org/graphql) with `{address:"0x050cE30b927Da55177A4914EC73480238BAD56f0",chainId:8453}`. These endpoint links are not prefilled replayable queries; query shape and exact responses are transcribed above. The API is mutable and parent should independently verify explorer address/code, asset(), owner(), curator(), factory, adapter list, and proxy/implementation status before treating as candidates for anything beyond further review.

USDC addresses and decimal values above are API metadata only. They are consistent with canonical Circle USDC on Ethereum/Base as identified in Morpho's asset registry, but this note does not call onchain `decimals()` or independently establish asset identity.

## Narrow ERC-4626 execution ABI to consider (not grant recommendation)

Morpho Vault V2 API docs: [deposit](https://docs.morpho.org/learn/concepts/vault-v2) and [VaultV2 API reference](https://docs.morpho.org/developers/earn/concepts/vault-v2). The documented selectors are:

```solidity
deposit(uint256 assets, address onBehalf) returns (uint256 shares)
withdraw(uint256 assets, address receiver, address onBehalf) returns (uint256 shares)
redeem(uint256 shares, address receiver, address onBehalf) returns (uint256 assets)
```

For any future reviewed call policy: exact per-chain vault and asset allowlist only; finite exact approval of the verified underlying to that vault; `onBehalf = execution owner` on deposit; `receiver = execution owner` and `onBehalf = execution owner` on withdraw/redeem; positive explicitly bounded assets/shares; reject arbitrary receiver/beneficiary and all other selectors. Withdraw/redeem can fail for liquidity/adapter constraints and returns may vary; an ABI whitelist does not promise liquidity or safe strategy. These are Morpho Vault V2-specific names: do not assume they equal vanilla ERC-4626 (`deposit(uint256,address)` happens to match, while third-argument wording differs from standard `owner`).

## Risk / uncertainty requiring parent validation

- Curator branding and Morpho API listing are not a safety endorsement. Candidate strategy, allowed markets, collateral/oracle configuration, caps, and current allocation were not independently reviewed. `MorphoMarketV1` adapter indicates strategy surface but not the exact active market set.
- API owner/curator/factory are reported state, not explorer evidence. The family docs say deployments immutable/no upgrades; verify actual runtime bytecode and proxy status for each exact address before relying on that property.
- API candidate count, listed flag, names, asset metadata, roles, and adapter mappings are mutable; no pinned Git revision applies to the hosted API. No explorer source-code link/API verification, fork validation, or on-chain `eth_call` was performed in this lane.
- This covers only one Ethereum and one Base discovery candidate. The user-requested “at least two candidates if verifiable” is met across those chain slots, but does not establish broad coverage or activation readiness.
