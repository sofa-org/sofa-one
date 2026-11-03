# Origin v6 source candidate: Ethereum OETH Vault

## Source and target roles

Pinned official source is `OriginProtocol/origin-dollar` commit `1d7e1dcb5681327b8037c3df991c27fd7583c643`, retrieved 2026-10-04. `contracts/deployments/mainnet/OETHVaultProxy.json` identifies the caller-facing Ethereum user proxy `0x39254033945AA2E4809Cc2977E7087BEE48bd7Ab`. The pinned `OETHVault.json` at `0x0E979edF516f88119fa2843fA3f08A9643F8e575` supplies the ABI/source evidence only; it is explicitly not a grant target. `InitializeGovernedUpgradeabilityProxy.sol` establishes initialization delegatecall and fallback delegation behavior, providing a dated source-role bridge, not a claim about current implementation slot or live code.

## Exact operations

The inactive candidate records these four nonpayable deployment ABI functions, retaining source names and primitive `internalType` values:

| Signature | Stable capability ID suffix | Inputs / outputs |
|---|---|---|
| `mint(uint256)` | `mint` | `_amount`; no outputs |
| `requestWithdrawal(uint256)` | `request-withdrawal` | `_amount`; `requestId`, `queued` |
| `claimWithdrawal(uint256)` | `claim-withdrawal` | `_requestId`; `amount` |
| `claimWithdrawals(uint256[])` | `claim-withdrawals` | `_requestIds`; `amounts`, `totalAmount` |

IDs are `origin:oeth-v1:1:0x39254033945aa2e4809cc2977e7087bee48bd7ab:<suffix>`.

Pinned VaultCore source shows mint pulls a supported ERC20 asset and mints OETH. It is nonpayable; no native-ETH input is implied. Withdrawal requests burn OETH and enqueue asynchronous withdrawals; claims transfer assets after protocol queue rules. Minimum delay, available queue liquidity, supported-asset and capital-pause conditions are intrinsic protocol behavior. Financial values and request identifiers remain caller-controlled within ABI types: no platform amount/owner/feed/counterparty restrictions or approval pairing are introduced. ERC20 approvals remain independent.

## Scope limits

Legacy `mint(address,uint256,uint256)` (including ignored inputs), strategy/admin mint/burn, permit, general executor, and unverified extra targets are excluded. These four functions are not whole-Origin or whole-workflow coverage. The candidate is inactive; the separate active fixture builder is for offline tests only, not runtime publication, user grants, current proxy implementation/code, liquidity, or funded-execution certification.
