# DeFi catalog workflow

The current catalog source is `data/defi-catalog/catalog.json`. Offline tooling validates this reviewed input and deterministically generates the static TypeScript module consumed by the runtime. Runtime authorization does not discover or load source snapshots or plans.

## Lean admission path

Use a contract-first inventory: **chain and exact deployed address → matching ABI → function inventory → capability records → existing catalog workflow**. Establish the chain/address from a reliable deployment source and bind the ABI to that deployment using a reliable ABI source. Where a proxy is involved, match the proxy address and the applicable implementation/interface; record the relevant implementation identity when available. These are inventory evidence, not proof of current runtime bytecode identity, funding, or executable behavior.

Enumerate ABI `function` entries as the callable interface surface. ABI entries do not say whether a function was declared `public` or `external`; either appears as a function. Internal/private functions are not part of this ABI surface. Do not create function capabilities for constructors, `fallback`, or `receive`. Retain `view`/`pure` mutability metadata, without implying that a read endpoint exists. Identify functions by their full canonical signature, not name alone: include canonical tuple component types and array suffixes (for example, `f((address,uint256)[],uint8)`). Overloads are supported when their selectors differ; the manifest rejects selector collisions, not repeated function names.

The capability identity remains the existing chain + exact address + full canonical signature, bound to the fixed ABI fragment and existing catalog ID/schema. Inventory is not automatic activation: ordinary entries can be recorded without requiring full-workflow, market-coverage, liquidity, funding, or financial-safety research as admission prerequisites. Keep security-sensitive functions and opaque multicall/executor surfaces unactivated unless they fit the existing independently required execution controls; give every unactivated entry a specific reason. This is not a new per-function financial-review process.

The inventory helper emits schema-v1 per-function records for manual review; it does not import into or write `catalog.json`. It requires explicit chain, address, protocol, deployment evidence and ABI evidence. Both evidence records carry `sourceRef`, `verifiedAt`, `chainId`, and `address`, and must match the supplied deployment identity. Input is a local JSON file with those fields and the ABI array; run `npm run defi:catalog:inventory -- path/to/input.json`. The helper makes no network/RPC/database calls and writes only drafts to stdout. Drafts and their hierarchy are inactive, provenance is `candidate`, and each function has an explicit review reason. Review/edit selected records and merge them into `data/defi-catalog/catalog.json` manually; never activate an ABI wholesale or write API-key grants. In `capabilityMode: all`, active, unpaused reviewed capabilities may be used subject to all independent gates; `custom` uses exact configured IDs and `custom` with `[]` denies catalog capabilities.

Minimal draft → review → generate/check workflow, from the repository root:

```sh
npm run defi:catalog:generate
npm run defi:catalog:check
```

Optionally run `npm run defi:catalog:diff` to review catalog changes. `generate` updates the generated runtime module; `check` validates that it matches the catalog. Review the diff, generated output and each record before admission. Catalog entries are function metadata, not API-key grants. Profiles are reviewed metadata groupings only.

These commands are offline and make no network, RPC, or database calls. Profiles do not grant capabilities, expand effective permissions, or prove a complete workflow.

Catalog admission records deployment-source and ABI-binding evidence. It does not establish deployed runtime identity, funding, balances, liquidity, successful execution, complete workflows, or financial safety. Preserve canonical ABI decoding, authorization, pause checks, final rechecks, and signing/execution boundaries; catalog membership does not bypass any independent control.

## Router additions reviewed 2026-10-16

Ethereum mainnet (`chainId: 1`) now includes these exact deployments:

| Protocol | Router | Active functions | Evidence |
| --- | --- | --- | --- |
| `uniswap-v2` | `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` | 14 | [Official deployments](https://developers.uniswap.org/docs/protocols/v2/deployments), [deployment/source binding](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/archive/docs/contracts/v2/reference/smart-contracts/06-router02.md), [pinned Router02 source](https://github.com/Uniswap/v2-periphery/blob/69617118cda519dab608898d62aaa79877a61004/contracts/UniswapV2Router02.sol), [published ABI](https://unpkg.com/@uniswap/v2-periphery@1.1.0-beta.0/build/UniswapV2Router02.json) |
| `fraxswap-v2` | `0xC14d550632db8592D1243Edc8B95b0Ad06703867` | 10 | [Official deployments](https://docs.frax.finance/fraxswap/fraxswap-contract-addresses), [address-bound verified source/ABI](https://etherscan.io/address/0xC14d550632db8592D1243Edc8B95b0Ad06703867#code), [pinned router source](https://github.com/FraxFinance/frax-solidity/blob/9ec3e9cebe52de9cbe623efe62f0c3ee997a0792/src/hardhat/contracts/Fraxswap/periphery/FraxswapRouter.sol) |

Both admit the six ordinary exact-input/exact-output token/ETH swaps and four ordinary token/token or token/ETH add/remove-liquidity functions. Uniswap additionally admits three fee-on-transfer swap variants and `removeLiquidityETHSupportingFeeOnTransferTokens`. Fraxswap's fee-on-transfer variants are outside this admission; its ABI was bound independently, not copied from Uniswap.

Permit/signature entry points are excluded from both additions. Read-only getters/quotes do not add transaction capabilities or a read API. Fraxswap's state-changing TWAMM quote helpers and separate opaque Multihop router are also excluded; ordinary swaps/liquidity can still settle existing pool virtual orders, but these capabilities do not create long-term orders. Neither addition admits arbitrary `execute`/`multicall` surfaces.

These are direct router deployments, not proxy admissions. Uniswap's published implementation and router interfaces matched the pinned source; Fraxswap's verified router body matched the pinned official source after newline normalization. No live bytecode or execution attestation is implied.

The dashboard's catalog metadata exposes these functions through the existing catalog service. Custom API keys must select the exact capability IDs; `all` mode includes active, unpaused additions dynamically. Token/LP approvals, balances, gas, liquidity, slippage, recipient and deadline remain caller responsibilities subject to independent policies. Payable functions can spend native ETH; nonpayable functions still reject nonzero value. Fee-on-transfer tokens have additional tax/nonstandard-behavior risk.

## ShibaSwap V1 addition reviewed 2026-10-16

Ethereum mainnet (`chainId: 1`) admits 14 ordinary swap/liquidity functions at the exact ShibaSwap V1 router [`0x03f7724180AA6b939894B5Ca4314783B0b36b329`](https://etherscan.io/address/0x03f7724180aa6b939894b5ca4314783b0b36b329#code), protocol ID `shibaswap-v1`. The [official deployment mapping](https://docs.shib.io/shibaswap/shibaswap-v1/deployed-address) was retrieved through its search index because direct requests returned HTTP 530; the exact Ethereum explorer independently corroborates attribution and supplies the verified deployment ABI/source. No generic fork ABI was substituted.

The reproducible evidence, full ABI and 24-function review inventory are in `data/defi-catalog/sources/shibaswap-v1-router.json`: nine explicit swaps and five non-permit liquidity actions are active; seven getters/quotes and three permit/signature variants are excluded. Constructors and `receive` create no capabilities. This is the direct V1 router, not a proxy or the separate V2 deployment.

Four payable functions can spend native ETH. Fee-on-transfer variants retain tax/accounting risk: supporting token/ETH removal forwards the router's entire token balance, and supporting token-to-ETH swaps unwrap its entire WETH balance. Removal minimums do not guarantee net post-tax tokens at the recipient. Paths, recipient, amounts, minimums, deadlines, token/LP allowances and financial outcomes remain caller responsibilities under independent controls. `all` mode dynamically includes active, unpaused functions; custom keys must select exact IDs. Admission does not attest current bytecode, funding, liquidity or execution.


## Biswap legacy router addition reviewed 2026-10-16

BSC (`chainId: 56`) admits 14 ordinary swap/liquidity functions at the exact legacy Biswap Router02 [`0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8`](https://bscscan.com/address/0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8#code), protocol ID `biswap-v2`. The [address-bound Sourcify record](https://sourcify.dev/server/v2/contract/56/0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8?fields=all) supplies the deployed ABI and source. Its router body matches the [pinned official Router02 source](https://github.com/biswap-org/periphery/blob/824b144dfb9d5095e65d26e92d9169ebac364bbb/contracts/BiswapRouter02.sol) after newline normalization. Router01 was not used; the official build artifact's extra `sqrt(uint256)` is absent from the deployed ABI and was rejected. The [current official Smart Router](https://docs.biswap.org/biswap/general-information/biswap-smart-contracts.md) is a different address and is not admitted by this addition.

`data/defi-catalog/sources/biswap-v2-router.json` preserves the full deployed ABI, source-binding details and all 30 function decisions: nine explicit swaps and five non-permit liquidity actions are active; ten getters/quotes, three permit/signature paths and three administrative functions are excluded. Four payable functions spend native BNB despite their ABI's ETH/WETH names. The constructor-bound wrapped native asset is WBNB.

Swaps read pair-specific fees and can invoke the owner's configurable `swapFeeReward` hook per hop; source admission does not attest the current hook address or its behavior. Fee-on-transfer removal and native-output swaps retain whole-router-balance and post-tax accounting risks. Administration, arbitrary executors and signature entry points gain no capabilities. Existing grant modes, pauses, ABI/value validation and independent safety policies remain unchanged.

## Skipped candidate: KyberSwap aggregator execution scope

The next reviewed candidate, Ethereum [`MetaAggregationRouterV2` at `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`](https://etherscan.io/address/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5#code), remains **unadmitted**. [Official deployment documentation](https://docs.kyberswap.com/developer-guide/aggregator-api/contracts.md) binds that address; the verified ABI exposes `swap`/`swapGeneric` with `callTarget`, `approveTarget` and opaque `targetData`, plus `swapSimpleMode` with a caller-selected executor and opaque `executorData`. A function selector and canonical outer ABI alone do not authorize the nested execution.

None of the existing closed `DefiExecutionScope` languages binds this executor format. Admitting these swap functions requires a human-approved executor/target scope and nested-call authorization design, followed by its implementation and verification; it is not a catalog-only expansion. Do not activate the aggregator wholesale, treat API-generated calldata as trusted, or weaken child grant/pause checks. No KyberSwap record, API-key grant or execution control was changed. This candidate is explicitly skipped while other protocol admissions continue.


## ApeSwap, WOOFi and Sushi V3 additions reviewed 2026-10-16

| Protocol ID | Chain | Exact deployment | Active / excluded functions |
| --- | --- | --- | --- |
| `apeswap-v2` | BSC 56 | `0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7` | 14 / 10 |
| `woofi-v2` | Polygon 137 | `0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7` | 1 / 14 |
| `sushiswap-v3` | Ethereum 1 | `0x2E6cd2d30aa43f40aa81619ff4b6E0a41479B13F` | 4 / 13 |

Each `data/defi-catalog/sources/<protocol-id>-router.json` preserves the full deployment-bound ABI, source evidence and every function's admission/exclusion reason. Runtime still consumes only the generated catalog. Existing `all` mode dynamically includes active, unpaused additions; custom keys require exact capability IDs. These additions assign no grants and attest neither current runtime configuration nor execution readiness.

**ApeSwap:** the [pinned official BSC configuration](https://github.com/ApeSwapFinance/apeswap-swap-periphery/blob/1bde4de06ff38c24599b0bd8b7d1bd72927511ae/migration-config.js) binds router/factory/WBNB; [exact-address Sourcify evidence](https://sourcify.dev/server/v2/contract/56/0xcf0febd3f17cef5b47b0cd257acf6025c5bff3b7?fields=all) supplies the ABI and deployed dependencies. Nine swaps and five non-permit liquidity actions are active. The official router body matches, but its pinned repository library has a different pair init-code hash: the verified deployment library is authoritative, not a whole-repository identity claim. ETH-named payable functions spend BNB; fee-supporting removal and token/native swaps retain whole-router-balance and post-tax-output risks. Getters/quotes and permit entry points are excluded.

**WOOFi:** [official Polygon deployment docs](https://learn.woo.org/dev-docs/references/readme/polygon-pos) and the [exact-address ABI/source](https://sourcify.dev/server/v2/contract/137/0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7?fields=all) bind the direct WooRouterV2. Only explicit `swap(address,address,uint256,uint256,address,address)` is active; opaque `externalSwap`, administration and getters/quotes are excluded. The owner can replace `wooPool`; constructor and currently documented pool differ, with live configuration unattested. The router funds its configured pool atomically from the caller; no raw-pool prefunding is admitted. There is no deadline. Native input should send exactly `fromAmount`; ERC20 input should send zero native value. This deployed version wraps all attached native input, retains surplus without automatic refund, and has owner recovery; these are warnings, not new parameter enforcement.

**Sushi V3:** the [pinned official Ethereum deployment artifact](https://github.com/sushiswap/v3-periphery/blob/5c4e99c9af11adcc03e0255a15d378d432b74ec0/deployments/ethereum/SwapRouter.json) binds address, ABI, constructor factory/WETH and deployment receipt; the adjacent `.chainId` is `1`. The [reviewed router](https://github.com/sushiswap/v3-periphery/blob/5c4e99c9af11adcc03e0255a15d378d432b74ec0/contracts/SwapRouter.sol) admits four exact-input/output single/multihop swaps. Packed path bytes contain token addresses and pool fees, not arbitrary executor data; exact-output paths reverse token order. Permit, callback, multicall and whole-balance settlement helpers remain excluded. Use a nonzero intended token recipient; zero redirects output to router custody. Unspent native value is not automatically refunded, and this admission does not include `refundETH`/sweep/unwrap helpers; pre-approved WETH/ERC20 with zero native value avoids relying on those helpers. Nonzero price limits can permit partial exact-output-single receipt. This is not RouteProcessor admission or a complete native-settlement workflow guarantee.


## BabySwap legacy router addition reviewed 2026-10-16

BSC 56 adds `babyswap-v2` at `0x325E343f1dE602396E256B67eFd1F61C3A6B38Bd`: 14 active ordinary swap/liquidity functions and 15 individually excluded functions. `data/defi-catalog/sources/babyswap-v2-router.json` retains its complete 29-function ABI inventory. Attribution comes from the [archived official legacy deployment mapping](https://web.archive.org/web/20211017144751id_/https://docs.babyswap.finance/developers/smart-contracts); [exact-address Sourcify ABI/source](https://sourcify.dev/server/v2/contract/56/0x325e343f1de602396e256b67efd1f61c3a6b38bd?fields=all) binds the direct BabyRouter. Live docs/repository were unavailable; a surviving third-party mirror is supplementary, not substituted for official attribution or deployed ABI evidence.

Nine swaps and five non-permit liquidity actions are active; getters/quotes, permits and administration are excluded. The owner-configurable `swapMining` hook can affect/revert swaps. ETH-named payable functions spend native BNB; fee-supporting removal/native-output swaps retain whole-router-balance and post-tax risks. Removal source also contains fixed Hardhat console staticcalls; no live execution compatibility is claimed. The separate Smart Router at `0x8317c460c22a9958c27b4b6403b98d2ef4e2ad32`, including its delegating fallback, remains unadmitted. Grants, pauses and execution controls are unchanged.


## Dfyn V1 and Resolv wstUSR additions reviewed 2026-10-16

| Protocol ID | Chain | Exact deployment | Active / excluded functions |
| --- | --- | --- | --- |
| `dfyn-v1` | Polygon 137 | `0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429` | 14 / 15 |
| `resolv-wstusr` | Ethereum 1 | `0x1202F5C7b4B9E47a1A484E8B270be34dbbC75055` | 12 / 56 |

**Dfyn:** [official deployment mapping](https://docs.dfyn.network/technical/contracts) was retrieved through its search index after direct requests failed; [exact-address Sourcify ABI/source](https://sourcify.dev/server/v2/contract/137/0xa102072a4c07f06ec3b4900fdc4c7b80b6c57429?fields=all) preserves deployed meta-transaction additions absent from the older official repository router. Nine explicit swaps and five non-permit liquidity actions are active. Eleven read-only helpers, three permits and opaque signed `executeMetaTransaction` self-calls are excluded. ETH-named functions refer to Polygon native currency, but constructor-bound `WETH` is **`0x4c28f48448720e9000907BC2611F73022fdcE1fA`, not canonical WMATIC/WPOL**. Its current behavior and safety are unattested. PolygonScan's suspicious-token label is unverified third-party metadata, not a finding established here. The explorer's proxy heuristic differs from Sourcify's non-proxy report and direct immutable-router source; no fresh bytecode attestation is claimed. Whole-router balances and taxed-token output risks remain documented.

**Resolv:** [official deployment documentation](https://docs.resolv.xyz/litepaper/for-developers/smart-contracts.md) binds the Ethereum wstUSR proxy. [Proxy-resolution evidence](https://sourcify.dev/server/v2/contract/1/0x1202F5C7b4B9E47a1A484E8B270be34dbbC75055?fields=all) and [exact implementation ABI/source](https://sourcify.dev/server/v2/contract/1/0x4d021a0949086d156746c6DFE9fA8d121A090279?fields=all) bind the interface to reported implementation `0x4d021a0949086d156746c6DFE9fA8d121A090279`, not the initial implementation. Both ordinary overloads of each `deposit`, `mint`, `withdraw`, `redeem`, `wrap` and `unwrap` are active, with distinct full-signature capability IDs. USR deposit/mint/withdraw/redeem differ from rebasing-stUSR wrap/unwrap. All require zero native value; another owner's withdrawal/redemption needs the on-chain allowance.

The full 68-function implementation ABI, separate proxy ABI and every decision are in `data/defi-catalog/sources/resolv-wstusr-router.json`; Dfyn's full 29-function review is in its corresponding evidence file. Resolv permits, approvals/transfers, initialization, role/blacklist/confiscation administration and getters are excluded. Proxy upgrades, underlying-token dependencies, share-offset conversion/rounding, blacklist powers and seeding/share-price risks remain explicit. Ordinary calls have no caller-set deadline or min-output/max-input guard; positive small wrap input can mint zero output. No implementation persistence, rate, backing, balance, liquidity, seeding, execution or financial-safety guarantee is implied. Existing authorization modes, pauses and independent execution controls remain unchanged.


## BakerySwap direct router reviewed 2026-10-17

BSC 56 adds `bakeryswap-v1` at `0xCDe540d7eAFE93aC5fE6233Bee57E1270D3E330F`: 14 active explicit functions (nine swaps and five non-permit liquidity actions), with seven getters/quotes and three signature/permit entries excluded. The complete 24-function ABI and decisions are in `data/defi-catalog/sources/bakeryswap-v1-router.json`.

[Exact-address Sourcify deployment/ABI/source](https://sourcify.dev/server/v2/contract/56/0xcde540d7eafe93ac5fe6233bee57e1270d3e330f?fields=all) binds the direct, non-proxy router. The [indexed BscScan name tag](https://bscscan.com/address/0xcde540d7eafe93ac5fe6233bee57e1270d3e330f#code) attributes it to BakerySwap; deployed router body matches the [pinned official implementation](https://github.com/BakeryProject/bakery-swap-periphery/blob/57302536083c08ec5cde90ea2b3e2cf3d4d6149c/contracts/BakerySwapRouter.sol) after newline normalization. Direct BscScan retrieval returned 403; source-service `match` is recorded without relabeling it `exact_match` or asserting a fresh runtime check. The deployed library remains authoritative; no generic Uniswap ABI or whole-repository identity assumption is made.

ABI native methods explicitly use BNB/WBNB names. Four payable functions spend native BNB; caller financial parameters and token/LP approvals remain independent responsibilities. Fee-supporting removal forwards the entire router token balance; supporting token-to-BNB swaps unwrap the entire router WBNB balance. Net taxed-token receipts, liquidity and execution success are not guaranteed. The former official site serves a lander, so the frontend directory links to the official source repository instead. No API-key configuration, pause or execution control changed.

## mStable exit-only savings and Alchemix V3 reviewed 2026-10-17

| Protocol ID | Chain | Exact proxy | Reported implementation | Active / excluded functions |
| --- | --- | --- | --- | --- |
| `mstable-savings` | Ethereum 1 | `0x30647a72Dc82d7Fbb1123EA74716aB8A317Eac19` | `0x0bc67971b49F7c23704c064F57B40d42A9B6f2B6` | 4 / 40 |
| `alchemix-v3` | Ethereum 1 | `0xeB83112d925268BeDe86654C13D423a987587e3E` | `0xd5F26C90EAD033554BF36227d0bbe993F6f76570` | 6 / 75 |

**mStable:** [official legacy SAVE documentation](https://developers.mstable.org/contracts/imassets-save.md) attributes the proxy; [exact implementation ABI/source](https://sourcify.dev/server/v2/contract/1/0x0bc67971b49F7c23704c064F57B40d42A9B6f2B6?fields=all) identifies the deprecated, exit-only implementation. Only `redeem(uint256,address,address)`, `withdraw(uint256,address,address)`, `redeemCredits(uint256)` and `redeemUnderlying(uint256)` are active. Historical documentation's deposit/mint methods do not exist in this implementation and remain denied. Full implementation plus proxy ABI and all 44 function decisions are retained in `data/defi-catalog/sources/mstable-savings-router.json`; catalog fragments omit only redundant legacy `constant`/`payable` flags after checking their consistency with `stateMutability`.

The underlying is mUSD, not USDC. Exchange-rate rounding can produce zero output for small redemptions; exact-asset withdrawal adds one share after division, including at exact divisibility. No caller-set deadline or slippage bound exists. Optional external interest collection, connector rebalancing/poke cadence, liquidity and upgrades can affect or revert exits. The frontend links to the attributable legacy reference, not an assertion that historical deposit flows remain available.

**Alchemix V3:** [official Ethereum deployment mapping](https://docs.alchemix.fi/dev/contracts/ethereum), [proxy explorer resolution](https://etherscan.io/address/0xeB83112d925268BeDe86654C13D423a987587e3E#code) and [exact implementation ABI/source](https://sourcify.dev/server/v2/contract/1/0xd5F26C90EAD033554BF36227d0bbe993F6f76570?fields=all) bind the Mix USDC/alUSD Alchemist. The complete 81-function implementation inventory and separate proxy ABI are in `data/defi-catalog/sources/alchemix-v3-router.json`. Ordinary `deposit`, `withdraw`, `mint`, `burn`, `repay` and owner-only `selfLiquidate` are active; delegated minting, approval management, third-party liquidation, privileged/transmuter-only methods, initialization and getters are excluded.

Deposit, withdrawal and repayment amounts are MYT shares, not raw USDC. Existing positions can receive third-party collateral deposits; withdrawal/mint/self-liquidation require the NFT owner, not merely an approved NFT operator. Burn repays unearmarked debt; MYT repayment handles earmarked debt and fees differently. Same-block mint/repay restrictions, health and locked-collateral checks, debt caps, pause state, rounding, mutable dependencies and upgrades remain authoritative. `selfLiquidate` closes the owner's healthy indebted position using its collateral; it is not third-party liquidation. No caller-set deadline/minimum residual or live dependency/balance/rate/execution guarantee is implied.

Alchemix V2 is **not admitted**: `data/defi-catalog/sources/alchemix-v2-router.json` records proxy `0x5C6374a2ac4EBC38DeA0Fc1F8716e5Ea1AdD94dd`, reported implementation `0x0f17d856Ecc7C8CE9Bd7d5b3e52A47ecA5e8955a`, full ABI inventories and zero selected functions. Its ordinary lifecycle methods unconditionally revert in the reviewed implementation; the frontend's single Alchemix card represents the V3 admission only.

All admitted calls retain existing exact-function grants, canonical calldata checks, pause scopes and independent execution controls. Source admission does not attest current deployed implementation identity, configuration, backing, liquidity, financial safety or execution success.

## Alpaca ibUSDT admission blocked on implementation evidence

`data/defi-catalog/sources/alpaca-vault-router.json` records the official BSC ibUSDT proxy `0x158Da805682BdC8ee32d52833aD41E74bb951E59` and source-service-reported implementation `0x7684966f3A3d679939622eF0260EC9A20318e981`. Only the proxy's five administrative ABI functions could be bound and inventoried; all are excluded. No implementation-function inventory is claimed, and neither runtime capabilities nor a frontend card are added.

Implementation Sourcify v2 and full/partial metadata requests returned 404; explorer read-contract surfaces reported no matching implementation ABI/source. The implementation page returned 403/human verification, and the explorer API requires a key. Pinned official repository and deployment-manifest searches did not bind this exact implementation. Historical `Vault.sol` interfaces are not substituted. Continuing this candidate requires trustworthy ABI/source or official build/deployment artifacts binding that implementation to this proxy. KyberSwap remains skipped independently.

## THENA classic router and Saddle proportional exit reviewed 2026-10-17

| Protocol ID | Chain | Exact target | Active / excluded functions |
| --- | --- | --- | --- |
| `thena-v2` | BSC 56 | `0xd4ae6eCA985340Dd434D38F470aCCce4DC78D109` | 12 / 14 |
| `saddle-usd` | Ethereum 1 | `0x3911F80530595fBd01Ab1516Ab61255d75AEb066` | 1 / 37 |

**THENA:** [official links](https://docs.thena.fi/thena/official-links) identify the [deployment spreadsheet](https://docs.google.com/spreadsheets/d/1nk-OLHL6yZ3rvTYo2-OXTVpjgfo5PVyufmM1U4S8geA/edit#gid=0), whose Classic Factory and Router section explicitly names Router V2. [Exact-address Sourcify ABI/source](https://sourcify.dev/server/v2/contract/56/0xd4ae6eca985340dd434d38f470accce4dc78d109?fields=all) binds the direct router; deployed source matches the pinned official RouterV2 source after whitespace removal, not byte-for-byte. This is neither the separate Algebra router nor the frontend aggregator.

`data/defi-catalog/sources/thena-v2-router.json` retains all 26 function decisions: seven explicit exact-input swaps and five non-permit liquidity actions active; ten getters/helpers, three permits and specialized caller-supplied per-hop `UNSAFE_swapExactTokensForTokens` excluded. Routes are explicit `(from,to,stable)` tuples; pair calls use empty callback data. ETH-named payable calls spend BNB through constructor-bound WBNB. Caller-selected stable/volatile routes, minimums, deadlines, recipient and token/LP approvals remain independent responsibilities. Fee-supporting removal/native-output paths retain whole-router-balance and post-tax risks. The fee-supporting loop chooses the larger stable/volatile quote while executing the caller-selected pool type; this discrepancy can revert calls. No compatibility, liquidity or success guarantee is implied.

**Saddle:** [official contract documentation](https://docs.saddle.finance/contracts.md), pinned exact-pool deployment artifact, and explorer creation/clone resolution bind the original USDPool to immutable minimal-clone implementation `0x98D2aFc66DE1F73598c6CFa35cbdfebB135fb8FA`. [Implementation ABI/source](https://sourcify.dev/server/v2/contract/1/0x98D2aFc66DE1F73598c6CFa35cbdfebB135fb8FA?fields=abi,compilation,deployment,sources,proxyResolution,metadata) and its linked SwapUtils source establish the reviewed interface; source-service `match` is not relabeled `exact_match`.

The [official wind-down notice](https://docs.saddle.finance/readme.md) reports all-pool pausing and advises withdrawal. Only `removeLiquidity(uint256,uint256[],uint256)` is active: source deliberately allows proportional removal while paused. Swap, deposit, single-token withdrawal and imbalanced withdrawal retain their exact historical signatures in the inventory but remain excluded, as do flash loans, LP accounting callbacks, initialization, administration and getters. `data/defi-catalog/sources/saddle-usd-pool.json` retains the complete 38-function review. Calls target the clone, not its implementation or USDPoolV2; require caller LP balance/allowance, zero native value, per-asset minimums and deadline; send outputs to caller. Deployment token order was DAI/USDC/USDT with differing decimals. Fees, rounding, taxed receipts and available balances remain relevant. Frontend links to the legacy official documentation, not renewed trading availability.

Neither admission attests fresh deployed runtime identity, configuration, balances, backing, liquidity, execution or financial safety. Existing grants, canonical ABI/value checks, pauses and independent execution controls remain unchanged.

## Synapse router blocked on nested-execution scope

`data/defi-catalog/sources/synapse-router.json` binds Ethereum router `0x7E7A0e201FD38d3ADAA9523Da6C109a07118C96a` using the [official router header](https://docs.synapseprotocol.com/docs/Contracts/Synapse-Router), exact-address explorer and deployed Sourcify ABI/source. The chain table below that header lists bridge addresses; those are not interchangeable router targets. All 36 functions are inventoried, with zero selected: 23 read-only functions, ten administration methods and three nested execution entries excluded.

`swap` and the origin path of `bridge` accept caller-selected `SwapQuery.swapAdapter` and opaque `rawParams`; deployed `_adapterSwap` transfers input to that adapter and invokes it with native value. Direct `adapterSwap` decodes an action and caller-selected pool, can approve the pool without a reviewed target binding, and invokes pool swaps/liquidity operations. Inner pool calls use zero minimum and maximum deadline, relying on an outer caller. Canonical outer calldata and API/quote-generated parameters do not authorize these nested operations.

Continuing this router requires a human-approved closed, versioned Synapse execution scope with adapter/pool/action bindings and independent child grant/pause checks, then implementation and verification. No current execution-scope language interprets these payloads. No Synapse capability or frontend card is added; previously skipped KyberSwap and Alpaca remain unchanged.

