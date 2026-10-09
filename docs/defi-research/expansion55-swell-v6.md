# Swell Ethereum deposit source candidate (v6)

Prepared as a bounded source candidate and isolated policy-test fixture only. The official [Swell deployed-address guide](https://docs.swellnetwork.io/developers/deployed-addresses.md) identifies these Ethereum targets:

| Token | Address |
| --- | --- |
| swETH | `0xf951E335afb289353dc249e82926178EaC7DEd78` |
| rswETH | `0xfAe103DC9cf190eD75350761e95403b7b8aFa6c0` |

The two fixed ABI references are the interfaces at the pinned `SwellNetwork/v3-core-public` commit `5827c4f1294b00f2939e582b1d3ac448f87fa218`: `contracts/lst/contracts/interfaces/IswETH.sol` and `contracts/lrt/contracts/interfaces/IrswETH.sol`. Each declares only the following selected deposit subset here:

| Method | ABI | Mutability | Output |
| --- | --- | --- | --- |
| `deposit` | `deposit()` | payable | none |
| `depositWithReferral` | `depositWithReferral(address referral)` | payable | none |

The ABI snapshots preserve the source parameter name and `internalType: address` on the referral input. The fixed permission IDs are `swell:v1:1:<lowercase-target>:deposit` and `swell:v1:1:<lowercase-target>:deposit-with-referral`. The source metadata version `v3-core@5827c4f1` denotes the reviewed source revision; it is not a permission-version wildcard.

The raw snapshot `data/defi-catalog/v6/sources/swell.json` keeps both targets inactive and contains only these four declarations. `buildSwellRegistry()` returns an active fixture for offline Catalog/Policy tests; it is not connected to runtime production admission and does not assign grants. Caller-selected native value and any ABI-valid referral address remain unrestricted by this fixture. Existing native-value budgets remain in force, approvals remain independent, and no amount, asset, owner, feed, or funded-execution policy is added.

**Dated source retrieval update:** a later retrieval successfully fetched the official deployed-address page (HTTP 200) and both pinned interface files (HTTP 200). The pinned `IswETH.deposit()` / `IrswETH.deposit()` and referral variants explicitly declare `payable` and have no return values, as represented above. An earlier docs retrieval returned HTTP 403; that historical failure is superseded for source-retrieval availability, not erased as chronology. These docs and source declarations remain address/interface evidence, not live runtime-code, current implementation, liquidity, or funded-execution verification.

This is not a complete Swell deposit/withdraw workflow. The swETH `burn` declaration only burns swETH and does not withdraw ETH. `IswEXIT.createWithdrawRequest` / `finalizeWithdrawal` declarations do not qualify an exact canonical EXIT deployment address here, and rswETH withdrawal details remain unqualified. No generic NFT operation, permit, multicall, or other token method is included. No runtime-code correspondence, current liquidity, funded execution, or successful economic outcome is certified.
