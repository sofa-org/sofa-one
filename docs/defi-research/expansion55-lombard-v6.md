# Lombard v6 source candidate: Ethereum LBTC redemption

## Roles and pinned source evidence

Pinned official `Lombard-Finance/sdk` commit `f454aa43decc4fb82fc880ac9e3fd9f1c9707bb8`, `packages/sdk/src/tokens/token-addresses.ts`, identifies the Ethereum production LBTC user token/proxy `0x8236a87084f8B84306F72007F36F2618A5634494`.

The address-specific Sourcify shell record exact-matches the proxy (verified 2024-08-08) and its proxy-resolution metadata lists StakedLBTC implementation `0x072072317469ebB6C340a47e41561C9C3b782BD9`. The implementation has a separate Sourcify exact-match record `28242592`, verified 2026-04-24, for `contracts/LBTC/StakedLBTC.sol`, Solidity `0.8.24+commit.e11b9ed9`. That implementation record supplies the exact ABI and source behavior only. It is not the authorized target and neither dated verification claims a current implementation slot/runtime state.

## Selected ordinary methods

Both selected methods are nonpayable and return no data:

* `redeemForBtc(bytes scriptPubkey,uint256 amount)` → `lombard:staked-lbtc-v1:1:0x8236a87084f8b84306f72007f36f2618a5634494:redeem-for-btc`.
* `redeem(uint256 amount)` → `lombard:staked-lbtc-v1:1:0x8236a87084f8b84306f72007f36f2618a5634494:redeem`.

The first method routes caller-selected BTC script bytes and amount to the configured asset router to begin BTC redemption; it is not arbitrary EVM destination/calldata execution. The second routes to NativeLBTC on this chain—not BTC or ETH. Script validity, router configuration, pause, minimums, dust, fees, and route availability are protocol-native conditions. The platform adds no script, amount, owner, price/feed restriction, or approval pairing. ABI-policy acceptance of arbitrary canonical bytes is not proof the protocol will accept a script or complete a withdrawal.

## Exclusions and limits

Legacy redeem overloads, privileged mint, bare burn, permit, operator/admin methods, and unrelated asset-router methods are excluded. The candidate is inactive; the separate active registry builder is for isolated offline tests only, with no production admission, runtime wiring, or automatic grants. BTC withdrawal completion and NativeLBTC liquidity are unverified. These two operations are not the complete Lombard staking, Bitcoin redemption, or rewards lifecycle and do not certify current runtime identity or funded execution.
