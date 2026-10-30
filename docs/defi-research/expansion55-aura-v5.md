# Aura — v5 source-qualified fixture

Snapshot date: 2026-10-04. The official `aurafinance/aura-contracts` deployment manifest and Phase 6 `tasks/deploy/mainnet-config.ts`, pinned at `36599d53946aab701e2a1757e164261f49529399`, identify Ethereum Booster `0xA57b8d98dAE62B26Ec3bcC4a365338157060B234`. The main repository's official `aurafinance/convex-platform` submodule resolves to `e7c23cfeec5ef9beb4873d87069363ee458fc184`; Aura-owned `Booster.sol` and `BaseRewardPool.sol` at that commit are the ABI source, not an old deployment-phase guess or the conflicting unused interface's ambiguous `withdrawAll(bool)` declaration.

A parent-reported public read-only Ethereum call at block `0x18e885f` (decimal 26118239; block hash `0xcfea8ff67458aebace1f255e4d6bd3ac38c24f8658a65345401ab7687b4455dd`) returned `poolLength() = 283`. `poolInfo(0)` returned LP token `0xCfCA23cA9CA720B6E98E3Eb9B6aa0fFC4a5C08B9`, deposit token `0x70751c02db1a5e48eD333c919A7B94e34a4E07E2`, gauge `0x275dF57d2B23d53e20322b4bb71Bf1dCb21D0A00`, `crvRewards` `0x712CC5BeD99aA06fC4D5FB50Aea3750fA5161D0f`, stash `0xE61df2CE6CC89467bb30f44E0d5cABfCEdc115BE`, and `shutdown=true`. This is a historical role-binding record; it is not a current-liquidity, funded-execution, or asset-safety proof. Additional bounded reads of PIDs 1, 2, 10, 25, 50, 75, 100, 125, 150, 175, 200, 225, and 230–282 also reported shutdown for those sampled rows. These samples do not establish the state of all 283 pools. **No currently open Aura deposit pool was verified.** Therefore this source snapshot must not be described as a live/deposit-ready Aura workflow.

The inactive source snapshot and test fixture contain exactly six declarations, all nonpayable and all returning unnamed `bool` with matching `internalType: bool`:

| Target role | Signature |
| --- | --- |
| Phase 6 Booster | `deposit(uint256,uint256,bool)` |
| Phase 6 Booster | `depositAll(uint256,bool)` |
| Phase 6 Booster | `withdraw(uint256,uint256)` |
| Phase 6 Booster | `withdrawAll(uint256)` |
| Historical pool-0 BaseRewardPool | `withdrawAndUnwrap(uint256,bool)` |
| Historical pool-0 BaseRewardPool | `getReward()` |

IDs use `aura:v1:1:<lowercase-target>:<deposit|deposit-all|withdraw|withdraw-all|withdraw-and-unwrap|get-reward>`; `v1` is a permission-template label, not an implementation-version assertion. The builder is fixture/test-only, verified in its local source provenance, and not wired to the production registry. No source admission or API-key grant is published.

## Role and workflow limits

The Aura-owned `BaseRewardPool.withdrawAndUnwrap` implementation reaches Booster `withdrawTo(pid,amount,receiver)`. Booster checks that caller against `poolInfo(pid).crvRewards`; its reward-claim route similarly requires the reward-pool role (or the separately configured lock-reward role). This bridges the selected pool-0 reward-pool target to the Booster role without authorizing an arbitrary reward-pool address. These two reward-pool methods are scoped to exiting or claiming an existing position at that historical target, **not new-stake readiness**.

All Booster PIDs, amounts, `_stake`, reward-pool amounts, and `claim` remain caller-selected ABI inputs with no platform amount/PID filters or owner/counterparty conditions added. Protocol shutdown and other intrinsic conditions may reject calls. ERC-20 approval is independent and is not included or automatically granted. An ABI-declared `bool` is not a promise of economic success.

Operator-only `withdrawTo`, admin/earmark/keeper/governance calls, CVX locking, zaps, arbitrary callbacks, and ambiguous `withdrawAll(bool)` / `withdrawAllAndUnwrap(bool)` void-return variants are excluded. This is one exact Booster and one exact historical reward-pool target, not all pools or proof that any deposit is presently open.
