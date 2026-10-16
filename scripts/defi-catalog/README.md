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

## Automation stop: KyberSwap aggregator execution scope

The next reviewed candidate, Ethereum [`MetaAggregationRouterV2` at `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`](https://etherscan.io/address/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5#code), remains **unadmitted**. [Official deployment documentation](https://docs.kyberswap.com/developer-guide/aggregator-api/contracts.md) binds that address; the verified ABI exposes `swap`/`swapGeneric` with `callTarget`, `approveTarget` and opaque `targetData`, plus `swapSimpleMode` with a caller-selected executor and opaque `executorData`. A function selector and canonical outer ABI alone do not authorize the nested execution.

None of the existing closed `DefiExecutionScope` languages binds this executor format. Admitting these swap functions requires a human-approved executor/target scope and nested-call authorization design, followed by its implementation and verification; it is not a catalog-only expansion. Do not activate the aggregator wholesale, treat API-generated calldata as trusted, or weaken child grant/pause checks. No KyberSwap record, API-key grant or execution control was changed. This is a stop for this candidate, not a claim that all other protocols have been exhausted.

