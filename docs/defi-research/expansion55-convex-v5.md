# Convex — v5 source-qualified fixture

Snapshot date: 2026-10-04. Official platform source is `convex-eth/platform` at pinned commit `4f22038387ca4ce014dec3d7f5781a8e28051c13` (resolved HEAD on the snapshot date). Official integration documentation identifies Ethereum Booster `0xF403C135812408BFbE8713b5A23a04b3D48AAE31`; pinned `Booster.sol`, `BaseRewardPool.sol`, and `RewardFactory.sol` provide the function and reward-pool role evidence.

A public Ethereum read at historical block `0x18e86c7` returned Booster `poolLength() = 583`; `poolInfo(0)` returned `crvRewards = 0xf34DFF761145FF0B05e917811d488B441F33a968`, with the associated LP/deposit token, gauge, stash, and shutdown fields. The read-result hash recorded in the source snapshot is `0xc8c68c958e0e15b194b153c1889f1c2c1b952ef78efad9b120a59cf6d34a270a`. The pinned source's RewardFactory creates BaseRewardPool instances for a pid/deposit token, and Booster source supplies the operator relationship. This role mapping and historical registry row do not prove current pool state, funded execution, or liquidity.

The inactive snapshot and fixture contain exactly these six declared methods, all `nonpayable` with one unnamed `bool` output:

| Target role | Signature |
| --- | --- |
| Booster | `deposit(uint256,uint256,bool)` |
| Booster | `depositAll(uint256,bool)` |
| Booster | `withdraw(uint256,uint256)` |
| Booster | `withdrawAll(uint256)` |
| Observed BaseRewardPool | `withdrawAndUnwrap(uint256,bool)` |
| Observed BaseRewardPool | `getReward()` |

IDs use `convex:v1:1:<lowercase-target>:<deposit|deposit-all|withdraw|withdraw-all|withdraw-and-unwrap|get-reward>`; `v1` is a permission-template version, not a live implementation version. The ABI snapshot is an exact selected source-declared subset, not a claim to reproduce the full deployed ABI. Source-to-fixture tests compare each exact chain, target, signature and canonical ABI hash. The fixture is not wired to production admission; no grants or automatic approval dependencies are published.

## Limits and omitted flows

Pool ID, amount, `_stake`, and `claim` are caller-controlled ABI values, including zero and maximum uint256 where applicable; no financial caps, PID/token allowlists, owner/receiver policy, or approval coupling are added. Booster `deposit` with `_stake=true` stakes on behalf of the caller; false leaves the Booster deposit token for later withdrawal. `depositAll` uses the caller's full balance of the chosen pool token. `withdrawAll` withdraws the caller's full balance of the pool deposit token. `withdrawAndUnwrap` exits a reward-pool position with the declared optional-claim flag; zero-argument `getReward()` claims for `msg.sender`. The source-declared bool return is not an economic-success guarantee. Pool shutdown, protocol fees, token allowance/balance, liquidity, and protocol eligibility can still determine execution.

The LP/deposit token approval is a separate permission and is not included or inferred. A missing allowance/prefund path means this subset is not a full funding workflow certification. Only one observed reward pool is included, not all pools or all Convex products. Reward-pool-only `withdrawTo`, other `getReward` overloads, administrative/governance methods, CVX locking, zaps, arbitrary callbacks, and multicall are excluded.
