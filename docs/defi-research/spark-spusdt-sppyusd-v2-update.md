# Spark spUSDT and spPYUSD Savings Vault V2 ordinary update

This update adds exactly four unscoped ordinary Ethereum bindings to each of two user-facing Savings Vault V2 targets:

- spPYUSD: `0x80128dbb9f07b93dde62a6daeadb69ed14a7d354`
- spUSDT: `0xe2e7a17dff93280dec073c995595155283e3c372`

On each target the admitted surface is only `deposit(uint256,address)`, `mint(uint256,address)`, `withdraw(uint256,address,address)`, and `redeem(uint256,address,address)`. The update excludes referral overloads, permits, helpers, admin, route/strategy and cross-chain methods. All eight selected declarations are exact plain entries from the full retained SparkVault implementation ABI.

The source snapshot and plan live in `data/defi-catalog/updates/spark-spusdt-sppyusd-v2/`. Family/version is `spark-vault-v2` / `v1.0.1@0a686ba2`; stable IDs use each exact target and method suffix. The immutable baseline is the accepted spUSDC update catalog, raw SHA-256 `715f091d6ffddf09e5ee0e0cb786689347f9b9516d5467a4b816bf4e6d95d033`, manifest hash `0xd95f5cc6b4821d0696bc6f067598416c56aa481ee925c0aac0c16ee70098d2cf`. This source snapshot's canonical SHA-256 is `135bdeadc374dac8064a72f8b49835644fb4b1ac572fa2accf3795c1949d6588`.

## Product, address, and implementation evidence

The pinned official Spark Ethereum address registry at commit `98091964e0ef9f74bb2b6da3646f8e6d16448588` declares `SPARK_VAULT_V2_SPPYUSD` at the first exact address and `SPARK_VAULT_V2_SPUSDT` at the second. Both are listed with `SPARK_VAULT_V2_IMPL` `0x1b992302652a92611dcd5090d1cb388c6377f455` and the source comment `SparkVault.sol@0a686ba` / v1.0.1. Official product documentation identifies the corresponding spPYUSD/spUSDT Savings products; documentation and registry records are dated product-role evidence, not proof of current proxy/runtime state or initialized storage.

The source and full ABI carrier are the same inspected SparkVault v1.0.1 implementation used by the accepted spUSDC batch, with pinned implementation commit `0a686ba2fcf874bc1542171a323779ba73ac2dc5`. Carrier hashes: source `f34765be4b67b953131b0b8f1ad562a485a73474ba7400786fb0b497140c873d`, full ABI `b8d1cc2f3af24c6daa2dfc3495c3f65093a038c0d3352021ecd719baa0ab09c9`, and Etherscan implementation HTML `80264d8b3a89fd54e4e53f8a2b14b6ce444af9471897d777cc0d1cecee5be101`. Implementation-version correspondence does not establish that either proxy currently uses that implementation.

The four functions are nonpayable with built-in Solidity types and exact outputs: deposit `(assets:uint256, receiver:address) -> shares:uint256`; mint `(shares:uint256, receiver:address) -> assets:uint256`; withdraw `(assets:uint256, receiver:address, owner:address) -> shares:uint256`; redeem `(shares:uint256, receiver:address, owner:address) -> assets:uint256`. Selectors are `0x6e553f65`, `0x94bf804d`, `0xb460af94`, and `0xba087652`; each target's exact full ABI identities are plan-bound.

## Protocol behavior and limits

The fixed implementation converts through its exchange-rate path. Deposit/mint validate receiver, taker roles and protocol cap before transferring the configured asset from `msg.sender` and minting shares. Withdraw/redeem burn the selected owner's shares, check/spend existing share allowance if owner differs from caller, then push the configured asset to the selected receiver subject to liquidity. Protocol state, cap, roles, zero-address restrictions, balances, allowances and available liquidity may reject calls.

Amounts and receiver/owner arguments remain caller-selected; the platform adds no financial cap, owner/recipient equality, balance or feed gate. Underlying-token approval and any third-party share allowance remain separate prerequisites; no approval pairing or automatic grant is added. Product documentation describing the spUSDT deposit asset or USD/USDS liquidity allocation does not establish initialized asset storage for either target. This update does not prove current proxy/runtime identity, initialized asset value, funding, liquidity, successful execution or financial safety.
