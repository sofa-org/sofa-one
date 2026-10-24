# Bounded lending/staking provenance: Lido Ethereum and Morpho Blue

Research snapshot: 2026-10-03. Scope is Lido Ethereum `submit`, wstETH `wrap`/`unwrap`, independent stETH/wstETH approvals, queue request/claim exits, and Morpho Blue direct `withdraw`, `withdrawCollateral`, and `borrow` on Ethereum and Base. This is source/address/interface provenance for a fixed function catalog, not live execution proof, a safety audit, token implementation identity proof, liquidity assurance, or market recommendation. No RPC, chain write, transaction, funds, new dependency, or implementation change was performed. This is deliberately not a claim of broad protocol or chain coverage. Spark, Venus, other staking providers, and additional vaults are deferred; the parallel DEX provenance artifact is out of scope.

## Admission outcome and fixed ABI

| Chain | Protocol / target | Source-backed action rows | Decision |
|---:|---|---|---|
| 1 Ethereum | Lido `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84` | `submit(address)` payable, returns `uint256` | ADMIT |
| 1 Ethereum | wstETH `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` | `wrap(uint256)` nonpayable, returns `uint256`; `unwrap(uint256)` nonpayable, returns `uint256` | ADMIT |
| 1 Ethereum | stETH (Lido target above) | independent `approve(address,uint256)` nonpayable, returns `bool` | ADMIT separately; never auto-grant |
| 1 Ethereum | wstETH `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` | independent `approve(address,uint256)` nonpayable, returns `bool` | ADMIT separately; never auto-grant |
| 1 Ethereum | WithdrawalQueueERC721 `0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1` | `requestWithdrawals(uint256[],address)` returns `uint256[]`; `requestWithdrawalsWstETH(uint256[],address)` returns `uint256[]`; `claimWithdrawals(uint256[],uint256[])` returns nothing | ADMIT |
| 1 Ethereum | Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | `withdraw((address,address,address,address,uint256),uint256,uint256,address,address)` returns two `uint256`; `withdrawCollateral((address,address,address,address,uint256),uint256,address,address)` no return; `borrow((address,address,address,address,uint256),uint256,uint256,address,address)` returns two `uint256` | ADMIT |
| 8453 Base | Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | same direct methods | ADMIT |

Counts: **12 action definitions** (3 Lido staking/wrapping + 3 queue functions + 3 Morpho methods on 2 chains), **2 independent approvals**. Approvals are not action dependencies.

Canonical JSON ABI fragments (tuple `components` order is significant):

```json
[
  {"type":"function","name":"submit","stateMutability":"payable","inputs":[{"name":"_referral","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
  {"type":"function","name":"wrap","stateMutability":"nonpayable","inputs":[{"name":"_stETHAmount","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]},
  {"type":"function","name":"unwrap","stateMutability":"nonpayable","inputs":[{"name":"_wstETHAmount","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]},
  {"type":"function","name":"approve","stateMutability":"nonpayable","inputs":[{"name":"_spender","type":"address"},{"name":"_amount","type":"uint256"}],"outputs":[{"name":"","type":"bool"}]},
  {"type":"function","name":"requestWithdrawals","stateMutability":"nonpayable","inputs":[{"name":"_amounts","type":"uint256[]"},{"name":"_owner","type":"address"}],"outputs":[{"name":"requestIds","type":"uint256[]"}]},
  {"type":"function","name":"requestWithdrawalsWstETH","stateMutability":"nonpayable","inputs":[{"name":"_amounts","type":"uint256[]"},{"name":"_owner","type":"address"}],"outputs":[{"name":"requestIds","type":"uint256[]"}]},
  {"type":"function","name":"claimWithdrawals","stateMutability":"nonpayable","inputs":[{"name":"_requestIds","type":"uint256[]"},{"name":"_hints","type":"uint256[]"}],"outputs":[]},
  {"type":"function","name":"withdraw","stateMutability":"nonpayable","inputs":[{"name":"marketParams","type":"tuple","components":[{"name":"loanToken","type":"address"},{"name":"collateralToken","type":"address"},{"name":"oracle","type":"address"},{"name":"irm","type":"address"},{"name":"lltv","type":"uint256"}]},{"name":"assets","type":"uint256"},{"name":"shares","type":"uint256"},{"name":"onBehalf","type":"address"},{"name":"receiver","type":"address"}],"outputs":[{"name":"assetsWithdrawn","type":"uint256"},{"name":"sharesWithdrawn","type":"uint256"}]},
  {"type":"function","name":"withdrawCollateral","stateMutability":"nonpayable","inputs":[{"name":"marketParams","type":"tuple","components":[{"name":"loanToken","type":"address"},{"name":"collateralToken","type":"address"},{"name":"oracle","type":"address"},{"name":"irm","type":"address"},{"name":"lltv","type":"uint256"}]},{"name":"assets","type":"uint256"},{"name":"onBehalf","type":"address"},{"name":"receiver","type":"address"}],"outputs":[]},
  {"type":"function","name":"borrow","stateMutability":"nonpayable","inputs":[{"name":"marketParams","type":"tuple","components":[{"name":"loanToken","type":"address"},{"name":"collateralToken","type":"address"},{"name":"oracle","type":"address"},{"name":"irm","type":"address"},{"name":"lltv","type":"uint256"}]},{"name":"assets","type":"uint256"},{"name":"shares","type":"uint256"},{"name":"onBehalf","type":"address"},{"name":"receiver","type":"address"}],"outputs":[{"name":"assetsBorrowed","type":"uint256"},{"name":"sharesBorrowed","type":"uint256"}]}
]
```

Argument semantics / authority: preserve every ABI argument as caller-selected. Queue requests accept user-selected amount arrays and NFT owner and return generated request IDs. Claim accepts request IDs and checkpoint hints; `claimWithdrawals` sends ETH to `msg.sender`, not an arbitrary recipient. Morpho `withdraw` and `borrow` take caller-selected market params, `assets`, `shares`, `onBehalf`, and `receiver`; `withdrawCollateral` has caller-selected market params, amount, owner and receiver. Protocol authorization/revert rules are protocol semantics, not added platform caps or filters. Lido `submit` accepts ETH and arbitrary referral; wstETH wrap/unwrap take caller amount. Each token approval permits any spender and uint256 amount including max, but remains separately and explicitly grantable, never auto-granted or action-coupled.

## Callback and deliberately excluded functions

Morpho callback-bearing `supply`, `supplyCollateral`, `repay`, `liquidate`, and `flashLoan` are excluded in this bounded wave. `supplyCollateral` accepts dynamic `bytes data` and may invoke caller callback; Morpho Blue offers caller-controlled callback hooks in relevant operations. Those are broader callback authority than the requested narrow fixed direct withdrawals; no callback calldata/callback functions are exposed by these rows. No adapter, router, multicall, arbitrary command, or alternate selector is included. Lido `receive()` is also not separately catalogued: the admitted `submit(address)` is the documented staking entry point and accepts ETH explicitly.

## Evidence

### Lido (official docs, live docs snapshot dated 2026-10-03)

- Official [deployed contracts](https://docs.lido.fi/deployed-contracts) page fetched 2026-10-03 (HTTP 200; docs response reported last-modified 2026-09-29): lists Lido/stETH proxy `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84`, wstETH `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0`, and Withdrawal Queue ERC721 proxy `0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1`. Mutable official deployment list snapshot, not pinned Git commit or live execution check.
- Official [Lido contract docs](https://docs.lido.fi/contracts/lido), fetched 2026-10-03: documents `submit(address _referral) payable returns (uint256)` and says it sends ETH to the pool and mints stETH to `msg.sender`.
- Official [wstETH contract docs](https://docs.lido.fi/contracts/wsteth), fetched 2026-10-03: documents `wrap(uint256 _stETHAmount) returns (uint256)` and `unwrap(uint256 _wstETHAmount) returns (uint256)`; the displayed declarations omit a mutability keyword, therefore Solidity nonpayable. The page describes wrap as stETH-to-wstETH and unwrap as wstETH-to-stETH. `wrap`/`unwrap` are not payable.
- Official [Lido contract docs](https://docs.lido.fi/contracts/lido), `approve()` section, fetched 2026-10-03: explicitly declares `approve(address _spender,uint256 _amount) returns (bool)` for the stETH contract and describes setting caller's allowance. Official [wstETH docs](https://docs.lido.fi/contracts/wsteth) document ERC-20 token support and wrap's requirement that user approve stETH to the wrapper; wstETH's token `approve` is admitted against the same official deployment-list address and the standard ERC-20 declaration. Both have no `payable` modifier in displayed declarations, hence nonpayable. This admission does not conflate Lido staking `submit` with approvals or imply allowance.
- Official [WithdrawalQueueERC721 docs](https://docs.lido.fi/contracts/withdrawal-queue-erc721), fetched 2026-10-03: documents request functions with `uint256[] _amounts,address _owner` returning `uint256[] requestIds`; claim function is `claimWithdrawals(uint256[] _requestIds,uint256[] _hints)` with no return and sends ETH to `msg.sender`. All three lack payable and are nonpayable. The docs explain that request transfers tokens, mints an unstETH NFT, and claim burns it after finalization; this is queued withdrawal flow, not an immediate exit guarantee.
- Source cross-check: official `lidofinance/core` master resolved to commit `b71ac05c1546cc7bc37d4fcd6eafec5d2b7f3593` on 2026-10-03 (commit date 2026-09-17). [`WithdrawalQueue.sol` at that commit](https://github.com/lidofinance/core/blob/b71ac05c1546cc7bc37d4fcd6eafec5d2b7f3593/contracts/0.8.9/WithdrawalQueue.sol) declares `requestWithdrawals` and `requestWithdrawalsWstETH` returning `uint256[] memory requestIds`, and `claimWithdrawals(uint256[] calldata _requestIds,uint256[] calldata _hints) external` with no return. The supplied `/contracts/steth` docs URL returned 404; stETH approval declaration is on official `/contracts/lido`. Neither live docs nor source snapshot proves current proxy implementation identity.

### Morpho Blue (official docs + official source)

- Official [Morpho addresses](https://docs.morpho.org/get-started/resources/addresses/) page fetched 2026-10-03 lists the Morpho contract `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` separately under Ethereum (Etherscan source link) and Base (Basescan source link). This is an official mutable deployment directory snapshot; same address appears in both chain-specific rows, but the chain-specific evidence is preserved rather than inferred from address reuse. The page links to `morpho-blue` v1.0.0 source.
- Fixed source used: official [`IMorpho.sol` at morpho-org/morpho-blue commit `8e26ca6a8dbc5089edcd67fb576248810fd2870a`](https://github.com/morpho-org/morpho-blue/blob/8e26ca6a8dbc5089edcd67fb576248810fd2870a/src/interfaces/IMorpho.sol), commit date 2026-09-09. Raw official source was fetched on 2026-10-03. Its `MarketParams` declaration is exactly `address loanToken; address collateralToken; address oracle; address irm; uint256 lltv;`.
- Exact source declarations:

```solidity
function withdraw(
    MarketParams memory marketParams,
    uint256 assets,
    uint256 shares,
    address onBehalf,
    address receiver
) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);

function withdrawCollateral(
    MarketParams memory marketParams,
    uint256 assets,
    address onBehalf,
    address receiver
) external;

function borrow(
    MarketParams memory marketParams,
    uint256 assets,
    uint256 shares,
    address onBehalf,
    address receiver
) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);
```

`external` with no payable modifier means nonpayable. `borrow` has no callback parameter/hook in its declaration; it is a direct function, not the callback-bearing liquidation/supply-collateral family. It returns `(uint256 assetsBorrowed,uint256 sharesBorrowed)`. The interface declares no callback data parameter for these three direct rows. For `withdraw`, outputs are `(uint256 assetsWithdrawn,uint256 sharesWithdrawn)`; `withdrawCollateral` returns nothing. Morpho's official resources describe market params as the market identifier/configuration tuple; all 5 user-provided tuple fields are required inputs. This research does not enumerate markets and does not claim every tuple corresponds to an existing market.
- Official Morpho docs pages reviewed: [contract resources](https://docs.morpho.org/get-started/resources/contracts/morpho) and [address directory](https://docs.morpho.org/get-started/resources/addresses/). Docs are mutable, recorded with this date.

## Interpretation / limitations

These rows meet simple source-admitted address + fixed ABI only. Queue exits are request → protocol finalization → claim, not instant withdrawals; no queue availability, finalization timing, or liquidity is asserted. No provenance claim implies runtime code/hash, proxy implementation identity, balances/allowances, Morpho market existence, oracle correctness, protocol availability, or safety. Direct Morpho rows have no arbitrary callback payload; callback siblings remain excluded. No generic NFT approvals or Permit methods, claim-to-recipient variant, multicall, broad executor, financial caps, argument filters, funded fork, runtime probe, or mandatory action pairing is added. Spark remains unassessed/deferred; no address or ABI admitted.
