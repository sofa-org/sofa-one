# dForce Ethereum iUSDT and iDAI mint/redeem update

This ordinary production-catalog update adds exactly four source-/ABI-bound, scope-free methods to two dated Ethereum iToken targets:

| Market | Target | Method | Capability ID |
|---|---|---|---|
| iUSDT | `0x1180c114f7fadcb6957670432a3cf8ef08ab5354` | `mint(address _recipient,uint256 _mintAmount)` | `dforce-itoken:v2:1:0x1180c114f7fadcb6957670432a3cf8ef08ab5354:mint` |
| iUSDT | `0x1180c114f7fadcb6957670432a3cf8ef08ab5354` | `redeem(address _from,uint256 _redeemiToken)` | `dforce-itoken:v2:1:0x1180c114f7fadcb6957670432a3cf8ef08ab5354:redeem` |
| iDAI | `0x298f243ad592b6027d4717fbe9decda668e3c3a8` | `mint(address _recipient,uint256 _mintAmount)` | `dforce-itoken:v2:1:0x298f243ad592b6027d4717fbe9decda668e3c3a8:mint` |
| iDAI | `0x298f243ad592b6027d4717fbe9decda668e3c3a8` | `redeem(address _from,uint256 _redeemiToken)` | `dforce-itoken:v2:1:0x298f243ad592b6027d4717fbe9decda668e3c3a8:redeem` |

All four use the full named nonpayable inherited ABI with empty outputs. Mint selector/hash: `0x40c10f19` / `0x9fc0f7364ccf5669b21ae3da6d102e41ee47dde89768d65b19550ed745f7fb4a`. Redeem: `0x1e9a6950` / `0x7b00a8c11f3db3cc93aec1dbe34ac479746e38ddf47871763ba61e4bf1f93b7a`. Family/version: `dforce-itoken` / `itoken-v2-blp@126c6d83`. The source snapshot marks both markets and all candidate functions inactive; the update admits only these four exact identities.

## Dated market/source evidence

Pinned `dforce-network/LendingContractsV2` commit `55da73310d196849213da2e2357572afdb6d663a` (2021-08-16) contains `DeployedAddresses.md` (SHA-256 `89b4d7f12043287b5f10ebd4c54ae4e1417e15cee1cff602fc25e4f9b0b5ac0c`), which lists Ethereum USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7` with iUSDT `0x1180c114f7fAdCB6957670432a3Cf8Ef08Ab5354`, and DAI `0x6B175474E89094C44Da98b954EedeAC495271d0F` with iDAI `0x298f243aD592b6027d4717fBe9DeCda668E3c3A8`. These are dated market-role associations, not proof that either proxy's current underlying storage remains configured to that asset.

The retained address-bound proxy/implementation carriers associate each proxy with implementation `0x792254876bdd3eae31bd56a6dc71fa18f778bcf9` for the dated observation. iUSDT proxy/implementation HTML SHA-256: `f65005fb08d80a98acdae45b574f198f7a4c11ef0e73578aaeaba2d21f9e7bae` / `fb90b292c761c1dedb1e08b76273b3a686947ace143e77b7fe727a518bd0de06`; iDAI: `0b15163ce7223f6236e22c091cc211eb7afad0adc4c490b370f0f13a5a24408c` / `5740f205c3a515c10185370e1033e9cd736b1997bc1690964072615c9cc6bf0d`. Both address-bound concrete `iTokenV2BLP` verified source carriers have SHA-256 `126c6d8338877992423529ba26b3616e0bc4b7bb4f2b0d7eec628c4c9c056d61`; inherited `iTokenV2` carrier SHA-256 is `62a3088259e4d3227a67acd6657b6c962bb82fae5e7ae7655fec65ab93875095`. This documents parity of the selected body against the prior iUSDC qualification, not whole-repository source/build equivalence or present runtime/proxy/storage identity.

Each target's retained full ABI carrier SHA-256 is `8b62fa4539dbc455f34e9566be72c101488089db00a896c06eea8312a8a19c2a`. The selected mint carrier SHA-256 is `dc20af7711496d0a69d46aa2907b92c9dc0170bc11bcb598ccb11712575d70bc`; redeem is `b4f125e1d221ecfca8ac179556ec0be79e2c5ac9134601dae04c24bedfd1066a`. Each selected entry deep-matches its target's full ABI by method, full input names/internal types, nonpayable mutability, and empty outputs. The concrete BLP's three-argument bool `mint`/`redeem` refreshEligibility wrappers are distinct and excluded; only inherited two-argument methods are selected.

## Call behavior, trust boundaries, and exclusions

Mint's inherited body calls the configured controller's `beforeMint`, computes the exchange rate, transfers configured underlying from `msg.sender`, calculates iTokens from actual received assets, mints them to caller-selected `_recipient`, checks the supply threshold, then calls `afterMint`. Controller behavior, underlying-token behavior/configuration, interest/rates, balances/allowance, threshold, and protocol conditions may affect or revert execution. Token approval remains separate and is neither paired nor granted.

Redeem computes underlying through the interest-dependent exchange rate, invokes `beforeRedeem`, burns caller-selected `_from` (the inherited `_burnFrom` requires allowance if `_from` differs from `msg.sender`), applies the supply threshold, and calls `_doTransferOut(msg.sender, amount)`. In the V2 override, the configured controller's `beforeTransferUnderlying(iToken, configuredUnderlying, amount, msg.sender)` returns `_dst`; the underlying is transferred to that returned destination. The caller is passed to the hook, but the configured controller selects the actual payout destination. Redeem is not guaranteed to pay either the caller or `_from`. Controller routing/permission/accounting, underlying configuration and token behavior, interest/rates, allowance/balance, market cash, and protocol conditions may redirect or revert.

All `_recipient`/`_from` values (including zero or an address distinct from the execution owner) and uint256 values remain caller-selected within the fixed ABI; protocol logic may reject them. No platform owner/recipient-equality, amount, balance, oracle, or financial gate is added. No approval pairing, automatic grant, profile, or execution scope is added. Other market/admin, borrow, liquidation, market-entry, permit, router, native-asset, and three-argument refreshEligibility methods are excluded. Source role evidence does not establish current proxy implementation/storage, asset/controller configuration, liquidity, funded execution, completed workflows, successful transactions, or financial safety.

## Baseline and limits

The immutable baseline is the saved dForce iUSDC catalog: 735 definitions (712 actions, 23 approvals), 16 scopes, and 69 ordered profiles / 399 IDs. This batch adds four actions, producing 739 definitions (716 actions, 23 approvals); all prior full function objects, scope bindings, and profile selections remain unchanged, and none of the four new IDs is profiled. The accepted versioned v9 catalog remains unchanged.

Source inspection date is 2026-10-06, distinct from the pinned 2021 publication/commit date. The catalog and policy tests are static/mock validation, not PostgreSQL concurrency proof, RPC/runtime identity, current asset/controller configuration, liquidity, or funded-execution evidence.
