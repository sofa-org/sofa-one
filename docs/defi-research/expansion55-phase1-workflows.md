# Expansion 55 — FIRST20 source-qualified workflow selections

**Status snapshot: 2026-10-04.** The staged v5 catalog integrates the bounded FIRST20 source set: 20 protocol brands, 21 brand/chain profile selections and 138 added capability functions. The catalog has 506 definitions (483 actions and 23 separately grantable approvals) and 15 execution scopes. The previous 368 definitions and 12 literal profiles are retained. This report describes exact function selections, not complete protocol support. Focused publisher checks passed; parent full validation and the mandatory FIRST20 Oracle Gate remain pending. The phase is not deployed, funded, market-certified, or evidence of 90% coverage. No later phase candidates are counted.

## Literal profile inventory

Profiles are fixed v1.0.0 exact-ID selections; memberships are not discovered from runtime family metadata. Each profile is one chain, and users must explicitly choose grants. The new selections total 138 unique IDs; no added ERC-20 approval is implicit. The largest profile has 17 members, below the existing 100-grant key limit. Existing interaction and decoded-node limits are unchanged (10 aggregate execution-plan nodes, including wrapper and children). Profiles do not grant authority to existing keys, bypass default-deny, or alter pause, session, EOA, IAM, budget, or signing-denial controls.

| Brand | Chain | Added functions | Targets | Bounded selected workflow surface / key gap |
|---|---|---:|---:|---|
| QuickSwap | Polygon | 10 | 1 | Finite V2 router swap and direct LP methods; no inventory/economics claim. |
| Camelot | Arbitrum | 3 | 1 | Finite swap and direct LP methods; fee-on-transfer swap has an extra referrer argument and void return. |
| LFJ | Arbitrum | 3 | 1 | Finite Liquidity Book swap and LP methods; no full pool population. |
| Maverick | Arbitrum | 1 | 1 | One exactInputSingle swap only; no LP entry/exit workflow. |
| Maverick | Base | 1 | 1 | One exactInputSingle swap only; no LP entry/exit workflow. |
| DODO | Base | 3 | 1 | Three fixed V2 proxy swaps; externalSwap is excluded. |
| Ambient | Ethereum | 1 | 1 | One payable scoped userCmd root with finite swap AND LP mint/burn grammar. |
| Fluid | Base | 17 | 3 | fToken lending methods plus one VaultT1 operate method; separate interfaces and caller-selected signed deltas. |
| Euler | Ethereum | 16 | 2 vaults + EVC | Six vault methods per sampled vault plus four EVC collateral/controller controls. |
| Silo | Arbitrum | 12 | 2 | Six lending-aware methods per selected vault; asset0/asset1 identities are not individually asserted. |
| Moonwell | Base | 17 | 4 | Bounded mToken and comptroller methods on selected targets; uint returns are protocol error codes. |
| Dolomite | Arbitrum | 6 | 1 | Finite user-router deposit/withdraw methods, not a full market population. |
| Rocket Pool | Ethereum | 2 | 2 | Deposit and rETH burn; the registry/deployment evidence is dated and burn depends on liquidity. |
| Ether.fi | Ethereum | 7 | 3 | Bounded liquidity-pool, token, and queue methods; request/exit is asynchronous. |
| Renzo | Ethereum | 6 | 2 | Four exact deposit overloads and withdrawal/claim; asynchronous and third-party claim behavior is retained. |
| Kelp | Ethereum | 4 | 2 | Deposit and asynchronous initiate/complete withdrawal methods. |
| StakeWise | Ethereum | 3 | 1 | Deposit, exit-queue entry, and later claim; asynchronous lifecycle. |
| Beefy | Base | 8 | 2 | Standard vault methods on two exact vaults; all four method forms per vault return void. |
| Pendle | Ethereum | 6 | 2 | Ordinary SY deposit/redeem, PY mint/redeem, dual-SY/PT LP add/remove; no external zaps. |
| Convex | Ethereum | 6 | 2 | Booster plus one historical pool-0 reward-pool relation; not full inventory/readiness. |
| Aura | Ethereum | 6 | 2 | Booster and sampled pool-0 reward target; no verified open-deposit pool. |

## Workflow interpretation and limitations

- **DEX/router selections:** QuickSwap, Camelot, LFJ, DODO and both Maverick chain profiles expose only the fixed source-qualified router operations listed in their profile. They do not enumerate all pools or claim liquidity, pricing/economic safety, funded execution, or automatic allowance handling. Camelot's selected fee-on-transfer swap includes its actual extra `referrer` input and returns void. DODO's `externalSwap` is excluded. Maverick has one `exactInputSingle` method per chain and no LP workflow.
- **Ambient:** The single payable root grant represents its accepted finite ColdPath command grammar for swaps and LP mint/burn; it is not a swap-only grant or general wallet executor. The nonzero conduit can custody LP and participate in fixed protocol callbacks, creating counterparty asset-loss risk. Governable DEX sidecars remain relevant.
- **Lending/vault selections:** Euler includes six operations on each sampled eWETH/wstETH vault plus EVC `enable/disableCollateral` and `enable/disableController` controls. This grouping does not assert collateral-pair eligibility, LTV compatibility, curated safety, or funded readiness. Silo's two selected vaults are in a WETH/USDC market configuration, but their individual `asset0`/`asset1` assignments have not been resolved; no guessed token identity is made. Fluid's fToken operations and VaultT1 signed-delta `operate` are distinct interfaces; both retain user-chosen arguments and do not represent full Fluid product coverage. Moonwell unsigned integer outputs are protocol error codes (zero means success), not evidence of business success from an EVM receipt. Dolomite's six finite user-router methods are not a complete market enumeration.
- **Staking / asynchronous exits:** Rocket Pool's selected deposit target is tied to a dated deployment/registry snapshot; registry state can change. Burning rETH depends on liquidity. Ether.fi, Kelp, Renzo and StakeWise expose asynchronous request/queue initiation and later finalization, unlock, delay, cooldown, or claim operations; none promises immediate completion. Renzo claims can be triggered for another user and pay that user; no caller-owner restriction is imposed by this selection. These are method sequences, not timing or withdrawal-availability guarantees.
- **Yield:** Beefy's four selected methods per vault return void; `depositAll` acts on underlying-asset balance while `withdrawAll` acts on vault shares. Pendle is the ordinary six-method SY/PY/dual-SY-PT LP subset. SY, PT, YT and LP funding and approvals are independent; pre-expiry redemption requires PT plus YT; external zaps and aggregators are outside the selection. Convex has one historical pool-0 reward relation, not a full inventory or readiness proof. Aura's selected pool-0 was observed shutdown: the chosen reward/withdraw functions concern existing positions. No open-deposit Aura pool was verified; six ABI methods do not certify current deposit readiness, and bounded samples do not prove that every pool is closed.

## Authority boundary

Every new member is an exact chain/address/function/ABI grant. Approval remains an independent capability: the profiles include no implicit approvals, do not require an approval/action pair, and do not limit spender or amount. Caller-selected financial values—including assets, recipients, amounts, minima, routes and protocol parameters—remain as declared by the ABI; no platform owner, price-feed, amount, or protocol-eligibility filter is implied. Existing configured API-key budgets, session/EOA readiness, grant/revocation and pause checks, IAM controls, transaction limits, destination/billing/simulation checks, and disabled generic signing remain independent. Selection or admission is not a claim of funding, current liveness, liquidity, protocol eligibility, financial safety, successful execution, or complete product coverage.
