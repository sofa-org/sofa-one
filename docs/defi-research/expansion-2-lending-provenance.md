# Wave 2 lending provenance: Spark and Venus — bounded source pass

Snapshot 2026-10-03. This artifact admits only exact official deployment/address and fixed-interface evidence. It is not live execution proof, runtime code or proxy implementation identity proof, an audit, liquidity assurance, or financial advice. No RPC, chain writes, transactions, funds, dependencies, or implementation changes were used. Financial ABI arguments remain caller-selected; no amount/health/feed/owner restrictions or evidence gates are proposed.

## Admission outcome

| Chain | Protocol / target | Actions admitted | Decision |
|---:|---|---|---|
| 1 Ethereum | SparkLend Pool `0xC13e21B648A5Ee794902342038FF3aDAB66BE987` | `supply`, `withdraw`, `borrow`, `repay` | ADMIT |
| 1 Ethereum | DAI `0x6B175474E89094C44Da98b954EedeAC495271d0F` | independent `approve(address,uint256)` | ADMIT separately |
| 1 Ethereum | Spark Savings sDAI / sUSDS | — | Defer: exact Savings vault + ERC-4626 interface pair not established |
| 56 BNB Chain | Venus vBNB `0xA07c5b74C9B40447a954e1466938b865b6BBea36` | native `mint()`, `redeem(uint256)`, `redeemUnderlying(uint256)`, `borrow(uint256)`, `repayBorrow()` | ADMIT |
| 56 BNB Chain | Venus vBTC `0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B` | five ERC-20 vToken methods | ADMIT |
| 56 BNB Chain | Venus vETH `0xf508fCD89b8bd15579dc79A6827cB4686A3592c8` | five ERC-20 vToken methods | ADMIT |
| 56 BNB Chain | Venus vUSDC `0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8` | five ERC-20 vToken methods | ADMIT |
| 56 BNB Chain | Venus vUSDT `0xfD5840Cd36d94D7229439859C0112a4185BC0255` | five ERC-20 vToken methods | ADMIT |
| 56 BNB Chain | Venus BTCB `0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c` | independent `approve(address,uint256)` | ADMIT separately |
| 56 BNB Chain | Venus ETH underlying `0x2170Ed0880ac9A755fd29B2688956BD959F933F8` | independent `approve(address,uint256)` | ADMIT separately |
| 56 BNB Chain | Venus Core Unitroller proxy `0xfD36E2c2a6789Db23113685031d7F16329158384` | `enterMarkets`, `exitMarket` | ADMIT |

**Counts:** 4 SparkLend + 25 Venus vToken + 2 Venus Comptroller = **31 action definitions**; **3 separately grantable approvals** (DAI on Ethereum; BTCB and ETH underlying on BNB Chain). Existing BNB USDC/USDT approvals are already represented in the baseline and are not duplicated. Approvals permit any spender and any `uint256` including max; no approval is automatic, paired, or required by catalog policy. Spark Pool and implementation addresses are distinct: only the `POOL` target is admitted, never `POOL_IMPL`.

All three approval ABI rows use the fixed standard declaration `approve(address spender,uint256 amount) returns (bool)`, nonpayable. These are standalone exact-token capabilities (`erc20:<chainId>:<lowercase token address>:approve`); no spender list or amount limit is imposed. Standard token ABI support is the interface basis, not an on-chain implementation/return-behavior probe.

```json
{"type":"function","name":"approve","stateMutability":"nonpayable","inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"name":"","type":"bool"}]}
```

## SparkLend fixed ABI

Exact JSON ABI fragments (all nonpayable):

```json
[
 {"type":"function","name":"supply","stateMutability":"nonpayable","inputs":[{"name":"asset","type":"address"},{"name":"amount","type":"uint256"},{"name":"onBehalfOf","type":"address"},{"name":"referralCode","type":"uint16"}],"outputs":[]},
 {"type":"function","name":"withdraw","stateMutability":"nonpayable","inputs":[{"name":"asset","type":"address"},{"name":"amount","type":"uint256"},{"name":"to","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
 {"type":"function","name":"borrow","stateMutability":"nonpayable","inputs":[{"name":"asset","type":"address"},{"name":"amount","type":"uint256"},{"name":"interestRateMode","type":"uint256"},{"name":"referralCode","type":"uint16"},{"name":"onBehalfOf","type":"address"}],"outputs":[]},
 {"type":"function","name":"repay","stateMutability":"nonpayable","inputs":[{"name":"asset","type":"address"},{"name":"amount","type":"uint256"},{"name":"interestRateMode","type":"uint256"},{"name":"onBehalfOf","type":"address"}],"outputs":[{"name":"","type":"uint256"}]}
]
```

The pinned interface declares `external` without `payable`; hence nonpayable. Its exact return behavior is no outputs for supply/borrow and one `uint256` for withdraw/repay. Caller-selected beneficiary/recipient and amounts are not constrained here. This does not assert that any chosen asset is listed, that a market has liquidity, or that a borrow is financially suitable. No implicit or automatic approval is included.

### Evidence

- Official Spark address registry, repository `sparkdotfi/spark-address-registry`, default branch `master` resolved to commit `98091964e0ef9f74bb2b6da3646f8e6d16448588` on 2026-10-03. Full recursive GitHub API tree retrieved (HTTP 200, not truncated); relevant full source file: [`src/SparkLend.sol`](https://github.com/sparkdotfi/spark-address-registry/blob/98091964e0ef9f74bb2b6da3646f8e6d16448588/src/SparkLend.sol) (raw HTTP 200). It declares `POOL = 0xC13e21B648A5Ee794902342038FF3aDAB66BE987` and separately `POOL_IMPL = 0x5aE329203E00f76891094DcfedD5Aca082a50e1b`. The target chosen is explicitly the Pool proxy/designated protocol endpoint from the address registry, not the implementation constant.
- Official Spark interface closure: [`IPool.sol`](https://github.com/sparkdotfi/sparklend-v1-core/blob/900c189feef2fafb97dca24c7b6e502dd035925a/contracts/interfaces/IPool.sol) in `sparkdotfi/sparklend-v1-core`, default `dev` resolved to commit `900c189feef2fafb97dca24c7b6e502dd035925a` on 2026-10-03 (full recursive tree HTTP 200, not truncated; raw interface HTTP 200). The official Spark repository declares exactly the four signatures shown above: `supply(address,uint256,address,uint16)` no outputs; `withdraw(address,uint256,address)` returns `uint256`; `borrow(address,uint256,uint256,uint16,address)` no outputs; `repay(address,uint256,uint256,address)` returns `uint256`. The artifact therefore relies on Spark's own fixed interface source, not the unrelated Aave Origin source. Combined with Spark registry `src/SparkLend.sol`'s explicit `POOL` record, this closes the source/address-to-ABI provenance at the simple catalog threshold; it does not assert runtime code, proxy implementation, build identity, or execution behavior.
- Spark official docs root https://docs.spark.finance/ and deployment route https://docs.spark.finance/dev/deployments were checked as supplemental references. The live docs extraction was broad and did not itself provide the exact Pool row; admission rests on the official address registry source file plus the linked upstream fixed interface above.

## Venus BNB Core basic market workflow

Pinned Venus source repository `VenusProtocol/venus-protocol`, `develop` commit `0cc9211d9722694492553b9c2951724f76c9ee63`, retrieved 2026-10-03. Official `deployments/bscmainnet.json` and `deployments/bscmainnet_addresses.json` each returned HTTP 200; the JSON manifest has `chainId: "56"`. The five exact keys/addresses above are its `vBNB`, `vBTC`, `vETH`, `vUSDC`, `vUSDT` records. The canonical manifest uses **vBTC** (not vBTCB); this artifact preserves the official label and does not relabel it. Unitroller proxy record is distinct from `Unitroller_Implementation` (`0xA66B2b5D50ce68A125bBad6B2265b637868c6E66`); calls target the proxy address, not the implementation. `bscmainnet_addresses.json` did not expose a matching filtered object in the parser shape, so market mapping evidence here is the exact chain-specific deployment manifest.

The five fixed methods on each ERC-20 vToken (20 rows) are nonpayable and return the Venus error-code `uint256`:

```json
[
 {"type":"function","name":"mint","stateMutability":"nonpayable","inputs":[{"name":"mintAmount","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]},
 {"type":"function","name":"redeem","stateMutability":"nonpayable","inputs":[{"name":"redeemTokens","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]},
 {"type":"function","name":"redeemUnderlying","stateMutability":"nonpayable","inputs":[{"name":"redeemAmount","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]},
 {"type":"function","name":"borrow","stateMutability":"nonpayable","inputs":[{"name":"borrowAmount","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]},
 {"type":"function","name":"repayBorrow","stateMutability":"nonpayable","inputs":[{"name":"repayAmount","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]}
]
```

Native vBNB does **not** share the ERC-20 mint/repay signatures; its five admitted fragments are:

```json
[
 {"type":"function","name":"mint","stateMutability":"payable","inputs":[],"outputs":[]},
 {"type":"function","name":"redeem","stateMutability":"nonpayable","inputs":[{"name":"redeemTokens","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]},
 {"type":"function","name":"redeemUnderlying","stateMutability":"nonpayable","inputs":[{"name":"redeemAmount","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]},
 {"type":"function","name":"borrow","stateMutability":"nonpayable","inputs":[{"name":"borrowAmount","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]},
 {"type":"function","name":"repayBorrow","stateMutability":"payable","inputs":[],"outputs":[]}
]
```

Official source files at that same commit: [`VBep20.sol`](https://github.com/VenusProtocol/venus-protocol/blob/0cc9211d9722694492553b9c2951724f76c9ee63/contracts/Tokens/VTokens/VBep20.sol) declares the ERC-20 vToken methods and outputs; [`VBNB.sol`](https://github.com/VenusProtocol/venus-protocol/blob/0cc9211d9722694492553b9c2951724f76c9ee63/contracts/Tokens/VTokens/VBNB.sol) declares payable no-argument mint and repayBorrow, with no outputs; [`ComptrollerInterface.sol`](https://github.com/VenusProtocol/venus-protocol/blob/0cc9211d9722694492553b9c2951724f76c9ee63/contracts/Comptroller/ComptrollerInterface.sol) supplies the fixed Comptroller interface. The deployment manifest's target records and source interfaces together establish these rows; this is not a live proxy-implementation check.

Core market entry/exit on the Unitroller proxy uses:

```json
[
 {"type":"function","name":"enterMarkets","stateMutability":"nonpayable","inputs":[{"name":"vTokens","type":"address[]"}],"outputs":[{"name":"","type":"uint256[]"}]},
 {"type":"function","name":"exitMarket","stateMutability":"nonpayable","inputs":[{"name":"vToken","type":"address"}],"outputs":[{"name":"","type":"uint256"}]}
]
```

Markets remain exact addresses above; no wildcard market list or automatic entry is implied. Caller-selected underlying amounts remain unrestricted by this artifact; no decimals, liquidity, price, or risk conclusions are made. Source `mint`/`borrow`/`redeem` return values are protocol error codes, not ERC-4626 shares/assets. No approval action is added, and none is automatically coupled to a market method.

## Remaining bounded deferrals

The same Venus `bscmainnet.json` commit has explicit token records `BTCB` at `0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c` and `ETH` at `0x2170Ed0880ac9A755fd29B2688956BD959F933F8`, each with a token ABI. The Venus vBTC manifest key remains **vBTC**; it is not renamed vBTCB. The deployment record supplies constructor schema, not actual constructor argument values, so no vBTC-underlying-to-BTCB relationship is asserted. These token approvals are admitted independently against their exact official token records, never coupled to vToken calls. Spark's official `Ethereum.sol` address registry explicitly lists DAI at `0x6B175474E89094C44Da98b954EedeAC495271d0F`; its approval is likewise standalone and does not assert DAI is listed or usable in SparkLend.
The Savings request likewise remains deferred: the registry source retrieved does not establish sDAI and sUSDS as the requested Spark Savings vaults, and this pass did not retrieve their exact official vault deployments paired with the exact ERC-4626 source interface. No address is guessed from a token/product name.

No `liquidate`, flash loans, arbitrary callbacks, multicall, permit, arbitrary deployment, wildcard market, auto-grant, or financial safety/liquidity promise is included. The baseline remains 108 definitions; this artifact records 31 lending actions and 3 additional independent token approvals for parent review/integration. Spark savings vaults remain deferred; there is no claim of sDAI/sUSDS vault coverage. The DAI approval is a standard exact-token approval row and does not assert DAI is listed or usable in SparkLend.
