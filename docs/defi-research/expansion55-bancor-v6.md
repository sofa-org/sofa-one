# Bancor V3 — bounded source-qualified fixture

**Snapshot: 2026-10-04.** This phase-2 preparation records six exact user methods on the Ethereum chain-1 BancorNetwork proxy `0xeEF417e1D5CC832e619ae18D2F140De2999dD4fB`. The role is documented by Bancor's official documentation and cross-checked against the project-owned `deployments/mainnet/BancorNetwork.json` artifact at `bancorprotocol/contracts-v3` commit `97d7905b8548470e79d40ce02e09b006f555aa11` (tree `a54ff9dd99ab194b6b4e261417ebef5a74048fe4`; not the commit). The exact interface is from that commit's `contracts/network/interfaces/IBancorNetwork.sol`; implementation comments/flow were checked in `contracts/network/BancorNetwork.sol`. Raw ABI entries preserve the artifact's full parameter/output `internalType`, names, unnamed `uint256` outputs, and payability. This bounded fixture is not wired into runtime, v6 compiler/admission, generated production catalog, or grants.

## Included exact operations

| Operation ID | Exact signature | Mutability | Declared output |
|---|---|---|---|
| `trade-by-source-amount` | `tradeBySourceAmount(address,address,uint256,uint256,uint256,address)` | payable | unnamed `uint256` |
| `trade-by-target-amount` | `tradeByTargetAmount(address,address,uint256,uint256,uint256,address)` | payable | unnamed `uint256` |
| `deposit` | `deposit(address,uint256)` | payable | unnamed `uint256` |
| `init-withdrawal` | `initWithdrawal(address,uint256)` | nonpayable | unnamed `uint256` |
| `cancel-withdrawal` | `cancelWithdrawal(uint256)` | nonpayable | unnamed `uint256` |
| `withdraw` | `withdraw(uint256)` | nonpayable | unnamed `uint256` |

The `deposit` declaration takes `Token pool` and `tokenAmount`; the pinned interface describes a liquidity deposit that returns the respective pool-token amount. The implementation deposits the base token into the master vault and processes a base-token pool deposit. It does **not** take a pool-token receipt as the first input. `initWithdrawal` is a distinct declaration taking `IPoolToken poolToken` and amount; it returns a request ID. `cancelWithdrawal(id)` and `withdraw(id)` operate on existing protocol request state, and completion requires the request to be eligible. The request/claim path can be asynchronous and subject to protocol timing and liquidity; no completion, payout, or timing is guaranteed.

The source snapshot contains exactly these six candidate records and no unresolved rows. It deliberately excludes `depositFor`, `tradeBySourceAmountArb`, `tradeByTargetAmountArb`, flash-loan, and administrative methods. The pure `buildBancorV3Registry()` fixture marks its exact interface active only for focused policy tests; source snapshot records remain `inactive` with candidate provenance. The fixture is not production admission, automatic authorization, pool enumeration, a live-code check, or funded execution.

## Authority and evidence limits

Tokens, pool/base-token address, amounts, min/max return, deadline, beneficiary, and request IDs remain caller-selected ABI values. There are no platform caps, token/pool/beneficiary allowlists, ownership checks, price-feed checks, approval coupling, or financial-safety filters. Payability is the declared ABI property, not an execution/funding assertion. ERC-20 approvals are separate capability grants, absent from this snapshot and never automatically included or paired. Existing exact-grant, default-deny, canonical-ABI, chain/target, payability, pause, session/EOA, key-budget, transaction, and signing-disabled checks remain independent.

Source-qualified deployment role and fixed declared ABI do not prove current proxy implementation/runtime identity, pool eligibility, all-pool population, market coverage, available liquidity, financial safety, funded execution, or transaction success. This is one bounded interface selection, not complete Bancor workflow or protocol coverage; a phase gate and parent integration review remain separate.
