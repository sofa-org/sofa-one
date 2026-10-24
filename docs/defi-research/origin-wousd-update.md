# Origin Wrapped OUSD inherited ERC4626 update

This static, ordinary-source update admits exactly four inherited nonpayable functions on Ethereum Wrapped OUSD proxy `0xd2af830e8cbdfed6cc11bab697bb25496ed6fa62`:

| Function | Full signature | Selector | Full ABI hash |
|---|---|---|---|
| `deposit` | `deposit(uint256,address)` | `0x6e553f65` | `0xacc854348209f31ec6382ea494bded763103e2bbb72cd2578ce1b67ad42044da` |
| `mint` | `mint(uint256,address)` | `0x94bf804d` | `0x6bba0dc0de55f693e4d005c0d24062fa3d723c34f88d39a600586539d56a58fe` |
| `withdraw` | `withdraw(uint256,address,address)` | `0xb460af94` | `0x4d73ece13f94d17f5eca74b24410ce392155416a778c2c2907a6adf6fa7d58a1` |
| `redeem` | `redeem(uint256,address,address)` | `0xba087652` | `0x4e30a5bc7aad2410da25c5cb80c93570e3d36436daa197a7b41c656fbad2d3dd` |

Full source ABI entries are retained exactly: named inputs with matching `internalType`/`type`, nonpayable mutability, and one unnamed (`name: ""`) `uint256` output. Each ABI entry was independently deep-matched to exactly one entry in the retained full implementation ABI; selectors and hashes were calculated from the full entry. Family/version is `origin-wousd` / `wrapped-ousd@6277dd68`; IDs are `origin-wousd:v1:1:0xd2af830e8cbdfed6cc11bab697bb25496ed6fa62:<method>`. The source contract/method snapshots are inactive; the pinned plan admits only these four exact identities, with null execution scopes.

## Source and address-role evidence

The OriginProtocol/origin-dollar repository is pinned at commit `1d7e1dcb5681327b8037c3df991c27fd7583c643` (published 2026-09-30). Its exact mainnet deployment paths are `contracts/deployments/mainnet/WrappedOUSDProxy.json` and `contracts/deployments/mainnet/WrappedOusd.json`, with retained carrier SHA-256 values `b55145258a3518b7e224138bfd3f5b9e0d7aa77a4777b197a742d1e5318d3637` and `9f4f32bfdbb430b302969c811691f73600ef215c4c4a749ea1533cf1a23d8dae`. They record proxy `0xD2af830E8CBdFed6CC11Bab697bB25496ed6FA62` and implementation `0xdeABEB7DFdA1dEFf8a90fDe8A16D7A42D316E632` respectively.

Dated Etherscan proxy and implementation HTML carriers SHA-256 `831f54b27a27cb458aa98634d5dfbffe629ea6bd4bc7abe23e157b96f5c85dca` and `a9509a74c2c87c3848e8c6cd02fb7ed74c7627d7e1f7e926d1140e83c9b9473a` associate the target and implementation for the retained observation. `WrappedOusd.sol.verified.sol` is address-bound carrier SHA-256 `6277dd680bc3c97f4a7ac4466db1bd087767369a682ed9aa6b2afa24143b174e`; it declares `WrappedOusd is WOETH`, forwards `underlying_` to `WOETH(underlying_)`, overrides only `name()` and `symbol()`, and does not override the four admitted methods.

The verified inherited WOETH body carrier SHA-256 `696221b444af596e14c5aa3186a6a929bb1cbd388fc2b926ef2f79a15c848285` and ERC4626 carrier SHA-256 `f380e4c6ea3cb59714e71d57800bdaa9c35fcb4cf43aebb02c971e064411ae9e` are byte-identical to the source-reviewed carriers for the preceding WOETH admission. They are separately retained and inspected for this source lineage. Full implementation ABI carrier SHA-256 is `82acdd39925c990bd373648db57fbb0e8e773944fa04013c88faae8ac0379569`; selected ABI carrier hashes: deposit `5e11f364d577ed672e03d483321fc7272140f95cfe7825d4dbb7d6c5c3e0d3d5`, mint `bca69ddeaed14218430f5450bc740d0c2df0743e40b062886bf7ebcb981d3d09`, withdraw `7b4c3a66a26704c6cf38766614995c6b0c560757d9d5dd264000602176b92640`, and redeem `4f39f79b30bc405a21fd7c413d2068b12434887941215accaba005fb1b7c9356`.

Inspection/retrieval date is 2026-10-06, distinct from source publication. Deployment and address-page observations are dated role association only, not compiler-artifact proof, current proxy implementation/runtime identity, storage, initialization, or live underlying-asset configuration. The constructor argument evidences source-declared configuration, not current proxy storage.

## Behavior and limitations

WrappedOusd inherits WOETH's ERC4626 methods. The inherited deposit/mint bodies transfer the constructor-configured underlying from the caller and mint shares to the caller-selected receiver. Withdraw/redeem burn shares from caller-selected owner and transfer configured underlying to caller-selected receiver; allowance is spent if caller differs from owner, except an unlimited allowance. WOETH conversion/accounting uses rebasing credits and an adjuster rather than raw asset balance. `withdraw` and `redeem` return the configured underlying asset, not a promised USD/USDC/native-ETH payout, issuer redemption, or complete exit workflow.

Underlying configuration and token behavior, rebasing-credit and adjuster state, conversion rounding/overflow and preview/max checks, balances/allowances, governance/upgrades, and asset availability may affect or revert execution. Platform policy adds no amount, receiver/owner equality, balance, feed, or financial gate; ABI-valid zero/arbitrary receiver/owner values and full uint256 amounts remain policy-permitted subject to protocol checks. Approval remains separate; no approval is paired or granted. This is not proof of current proxy/storage/asset state, funds, liquidity, successful/funded execution, full workflow, issuer redemption, USD value, or financial safety.

## Preservation

The immutable baseline is the saved Origin WOETH catalog (743 definitions, 720 actions, 23 approvals; 16 scopes; 69 profiles / 399 IDs). This batch adds four actions for 747 total (724 actions, 23 approvals), without changing prior full function objects, scope bindings, or ordered profile objects/memberships. None of the four WOUSD capabilities is profiled. The accepted versioned v9 catalog remains unchanged.
