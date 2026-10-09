# Rocket Pool staking and rETH redemption: bounded source provenance

Research snapshot: 2026-10-03. Scope is Ethereum mainnet only and at most the direct user staking and redemption methods plus an independent rETH ERC-20 approval. This is source/address/interface provenance for fixed calls, not proof of live code identity, safety, liquidity, execution, availability, or financial suitability. Research used read-only official GitHub/API and Rocket Pool documentation requests; no RPC, transactions, funds, dependencies, or implementation changes.

## Admission outcome

| Chain | Target role | Fixed call | Decision |
|---:|---|---|---|
| 1 Ethereum | Rocket Pool deposit pool | `deposit()` payable, no outputs | **DEFER address; do not admit yet.** The retrieved official source defines it, but this pass did not retrieve an authoritative current Ethereum deployment record tying the current pool address to that source. |
| 1 Ethereum | rETH token | `burn(uint256)` nonpayable, no outputs | **DEFER address; do not admit yet.** The retrieved official source defines semantics/signature, but no authoritative current Ethereum address record was retrieved. |
| 1 Ethereum | rETH token | `approve(address,uint256)` nonpayable, returns `bool` | **DEFER address; do not admit yet** for the same missing exact address evidence. This is a distinct explicit-grant candidate, not automatic. |

This is intentionally a truthful incomplete source outcome, not a deployable capability set. No address is proposed or inferred from memory, third-party listings, or source-tree contents. In particular, a tree containing contracts does not identify the current mainnet deployment address or prove that a deployment uses that source revision.

## Verified source declarations

The official repository `rocket-pool/rocketpool` `master` commit endpoint was fetched 2026-10-03 and returned commit `fef41a4f7cf99d7d66313c0ba04deb8ba2dabf88` (commit date 2026-04-17) and tree `4f5cdc28f9d680560aeeeef1d8fcb319384dddf0`. The recursive tree endpoint for that exact tree returned `truncated: false`; paths below were taken from that response, not guessed.

At that commit, `contracts/interface/deposit/RocketDepositPoolInterface.sol` declares:

```solidity
function deposit() external payable;
```

Thus the canonical ABI fragment is `{"type":"function","name":"deposit","stateMutability":"payable","inputs":[],"outputs":[]}`. `contracts/contract/deposit/RocketDepositPool.sol` implements the same signature and documents it as accepting user deposits and minting rETH to the caller. The implementation checks protocol deposit settings, minimum deposit, and deposit-pool capacity; these are protocol behavior, not app-imposed caller financial limits. The source alone does not authorize using any particular deployed address.

At the same commit, `contracts/interface/token/RocketTokenRETHInterface.sol` declares:

```solidity
function burn(uint256 _rethAmount) external;
```

Canonical fragment: `{"type":"function","name":"burn","stateMutability":"nonpayable","inputs":[{"name":"_rethAmount","type":"uint256"}],"outputs":[]}`. The contract implementation documents burning caller-held rETH for ETH, computes ETH value from the protocol exchange calculation, checks available collateral, withdraws deposit-pool collateral if required, burns caller tokens, then transfers ETH to caller. It may revert for insufficient rETH/collateral or protocol conditions. Do **not** infer a fixed 1:1 ETH redemption: rETH's source comment explicitly says its value reflects a variable exchange rate and is subject to liquidity.

The same rETH interface inherits official `contracts/interface/util/IERC20.sol`, which declares `approve(address spender,uint256 amount) external returns (bool)`. Canonical fragment: `{"type":"function","name":"approve","stateMutability":"nonpayable","inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"name":"","type":"bool"}]}`. The implementation is inherited through `contracts/contract/util/ERC20.sol` and returns true after setting the caller's allowance. This is a standalone approval for caller-selected spender/amount and should only ever be independently granted; it is not required or auto-coupled by a platform workflow.

## Source records and limitation

- Official commit JSON: <https://api.github.com/repos/rocket-pool/rocketpool/commits/master> (retrieved 2026-10-03; commit SHA above; response last-modified 2026-04-17).
- Official recursive tree JSON: <https://api.github.com/repos/rocket-pool/rocketpool/git/trees/4f5cdc28f9d680560aeeeef1d8fcb319384dddf0?recursive=1> (retrieved 2026-10-03; `truncated:false`). Relevant paths: `contracts/interface/deposit/RocketDepositPoolInterface.sol`, `contracts/contract/deposit/RocketDepositPool.sol`, `contracts/interface/token/RocketTokenRETHInterface.sol`, `contracts/contract/token/RocketTokenRETH.sol`, `contracts/interface/util/IERC20.sol`, and `contracts/contract/util/ERC20.sol`.
- Pinned official source links: [deposit pool interface](https://github.com/rocket-pool/rocketpool/blob/fef41a4f7cf99d7d66313c0ba04deb8ba2dabf88/contracts/interface/deposit/RocketDepositPoolInterface.sol), [deposit pool implementation](https://github.com/rocket-pool/rocketpool/blob/fef41a4f7cf99d7d66313c0ba04deb8ba2dabf88/contracts/contract/deposit/RocketDepositPool.sol), [rETH interface](https://github.com/rocket-pool/rocketpool/blob/fef41a4f7cf99d7d66313c0ba04deb8ba2dabf88/contracts/interface/token/RocketTokenRETHInterface.sol), [rETH implementation](https://github.com/rocket-pool/rocketpool/blob/fef41a4f7cf99d7d66313c0ba04deb8ba2dabf88/contracts/contract/token/RocketTokenRETH.sol), [IERC20](https://github.com/rocket-pool/rocketpool/blob/fef41a4f7cf99d7d66313c0ba04deb8ba2dabf88/contracts/interface/util/IERC20.sol), and [ERC20 implementation](https://github.com/rocket-pool/rocketpool/blob/fef41a4f7cf99d7d66313c0ba04deb8ba2dabf88/contracts/contract/util/ERC20.sol).
- The official docs site was reachable at <https://docs.rocketpool.net/developers/usage/contracts>, but returned the generic documentation landing content, not a deployment record or contract ABI. This pass therefore has **no official deployment-address evidence** for any target. A guessed/stale historical address is deliberately omitted.

No generated/min-output/ETH-per-rETH guarantee, user cap, owner pin, price/liquidity gate, runtime-code check, funded fork, availability check, or safety claim is introduced. The next source pass must first obtain the official current Ethereum deployment-address record and pair that exact record with the source/interface before any of these functions can be admitted. No node-operator or minipool methods, registry calls, arbitrary executor, or proxy-upgrade action are in scope.
