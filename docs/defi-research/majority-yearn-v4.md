# Catalog v4: Yearn TokenizedStrategy 3.0.4 source candidate

## Scope and status

This is a bounded source snapshot for one Ethereum `SingleStrategy` instance
admitted to current v4 under exact source-hash and six function-ABI bindings.
Admission is not a grant, deployment/runtime proof, or statement that the
original >=90% coverage objective is complete. The historical candidate is
`0x074134A2784F4F66b6ceD6F68849382990Ff3215`, reported by yDaemon as version
`3.0.4` with USDC asset `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`.
The original selected index observation at 2026-10-04T00:18:05.632Z (HTTP date
00:18:04 GMT) marked it `endorsed=true`, `isRetired=false`, `isHidden=false`,
and `isPool=false`. A later independent observation at 00:23:20Z also
reported that exact record. These are mutable indexer statements, not on-chain
deployment, liquidity, or financial-safety proof.

## Bounded source refresh

Only three known URLs were fetched. At 2026-10-04 around 00:26Z, the yDaemon
endpoint returned HTTP 200 and a parsed array of 200 records; the selected
address was absent from that response. The default page may be limited, so
this is not a complete-population or retirement conclusion, and does not erase
the earlier observed record. No claim is made that the checked-in candidate is
present in the latest response. The response body SHA-256 was
`79edce0c5a92c2cf44adbc4ef1a0ff9173e96ced4199a90d5ebd6262c6d8d912` (hash of
the received body bytes, not parsed/re-serialized JSON).

* Index: <https://ydaemon.yearn.fi/1/vaults/all> — HTTP 200, 200 records;
  response date `Sun, 04 Oct 2026 00:26:16 GMT`.
* Official data-services documentation:
  <https://github.com/yearn/yearn-devdocs/blob/92e3a04de8ae91bbb6c0d16aa20fdf8b5688e524/docs/developers/data-services/ydaemon.md>
  — HTTP 200; body SHA-256
  `5474712f545036f601f3cb22e4da4a8caca1419568b2ed41dafa8e0258423b3a`.
  It describes yDaemon as legacy REST/indexer data and recommends Kong; index
  metadata is not immutable contract evidence.
* Versioned implementation:
  <https://raw.githubusercontent.com/yearn/tokenized-strategy/v3.0.4/src/TokenizedStrategy.sol>
  — HTTP 200; body SHA-256
  `af2cce2ece0a80c52fa431fce193cf6557fa7533bce0486cf6c13d0f9d46a403`.
  The official `v3.0.4` source declares `API_VERSION = "3.0.4"`.

The tag is a mutable label; a version match does not prove this address's
runtime code. No RPC, proxy implementation, funded execution, or broader
instance enumeration was performed. A previously observed WETH instance at
`0xe92ade9eE76681f96C8BB0b352d5410ca5b35D70` reported version 3.0.2, but was
absent from the later page and is deliberately not included. Its absence does
not prove retirement. No Base or other-chain instance is inferred.

## Fixed ABI candidate

`data/defi-catalog/v4/sources/yearn.json` contains six exact, nonpayable
TokenizedStrategy functions, with both overloads retained as separate ABI
entries: `deposit(uint256,address)`, `mint(uint256,address)`,
`withdraw(uint256,address,address)`,
`withdraw(uint256,address,address,uint256)`,
`redeem(uint256,address,address)`, and
`redeem(uint256,address,address,uint256)`. The latter overloads expose the
caller-supplied `maxLoss`; no financial caps or owner binding are implied.
This is a single-strategy TokenizedStrategy interface, not a generic Yearn V3
multi-strategy vault ABI. The existing independent USDC approval capability
remains independent; there is no automatic approval pairing.

Function-level explicit grants are the authorization model, with caller
financial arguments preserved as user choice. These six functions are not six
distinct protocols. The four overloads use selector-qualified IDs so that
`withdraw`/`redeem` signatures remain distinct. No source admission or profile
automatically creates user/API-key grants; a new literal profile is only a
function-selection preview.

## Evidence limitations

The current index response's 200-record bound and address absence leave
population completeness and current membership unresolved. The prior positive
observation remains historical evidence only. Neither yDaemon's endorsement
field nor the source tag proves immutable deployment identity, current
non-retirement, liquidity, suitability, or safety. Absence from the bounded
default page does not establish retirement or latest index membership. No
other target is admitted by inference. See the [M4 delivery and coverage
status](majority-m4-delivery.md) for current catalog and gate state.
