# Origin WOETH ERC4626 update

This ordinary catalog update admits exactly four inherited, nonpayable methods on Ethereum WOETH target `0xdcee70654261af21c44c093c300ed3bb97b78192`:

| Method | Signature | Selector | ABI hash |
|---|---|---|---|
| `deposit` | `deposit(uint256,address)` | `0x6e553f65` | `0xacc854348209f31ec6382ea494bded763103e2bbb72cd2578ce1b67ad42044da` |
| `mint` | `mint(uint256,address)` | `0x94bf804d` | `0x6bba0dc0de55f693e4d005c0d24062fa3d723c34f88d39a600586539d56a58fe` |
| `withdraw` | `withdraw(uint256,address,address)` | `0xb460af94` | `0x4d73ece13f94d17f5eca74b24410ce392155416a778c2c2907a6adf6fa7d58a1` |
| `redeem` | `redeem(uint256,address,address)` | `0xba087652` | `0x4e30a5bc7aad2410da25c5cb80c93570e3d36436daa197a7b41c656fbad2d3dd` |

The full source ABI outputs are each `uint256` with the unnamed output name `""`; this is retained exactly, not normalized to a named return. All parameter names and internal types are bound. Family/version: `origin-woeth` / `woeth@696221b4`; IDs are `origin-woeth:v1:1:0xdcee70654261af21c44c093c300ed3bb97b78192:<method>`. The source snapshot marks the contract and methods inactive; the plan admits only these four exact identities with no execution scope.

## Source and deployment evidence

The pinned OriginProtocol/origin-dollar commit is `1d7e1dcb5681327b8037c3df991c27fd7583c643`, published 2026-09-30. `contracts/deployments/mainnet/WOETHProxy.json` records proxy `0xDcEe70654261AF21C44c093C300eD3Bb97b78192` (carrier SHA-256 `6bc13b76f5a501286b86ef32838bb6d6e809ec4ab75134db6a7b41c0a093a75c`); `WOETH.json` records implementation `0x388782b21275F75255f3ee08e23Bd3991d4eB830` (SHA-256 `906e8e4bb2334f6d5977fe1a49732edeaa6c3368da3d892d3e29e774ba2ff788`). Dated Etherscan proxy and implementation HTML carriers are SHA-256 `7344f8f3025a481221a0db85234e5abb37ae3675f2340314c98d7fa17d2c1a2d` and `716636afe773af812d967dd4962ac6edef5283a1a01bee7ce78e9173afa45e53`; they associate the observed proxy with that implementation for the retained observation. These records do not establish present proxy implementation, storage, initialized state, or runtime identity.

Address-bound verified `contracts/token/WOETH.sol` carrier SHA-256 is `696221b444af596e14c5aa3186a6a929bb1cbd388fc2b926ef2f79a15c848285`. It declares `WOETH is ERC4626, Governable, Initializable`, fixes the ERC4626 asset in its constructor, and does not override the four selected methods. The inherited verified ERC4626 body carrier SHA-256 is `f380e4c6ea3cb59714e71d57800bdaa9c35fcb4cf43aebb02c971e064411ae9e`. Full implementation ABI SHA-256 is `82acdd39925c990bd373648db57fbb0e8e773944fa04013c88faae8ac0379569`. Selected full-ABI entry carriers: deposit `5e11f364d577ed672e03d483321fc7272140f95cfe7825d4dbb7d6c5c3e0d3d5`, mint `bca69ddeaed14218430f5450bc740d0c2df0743e40b062886bf7ebcb981d3d09`, withdraw `7b4c3a66a26704c6cf38766614995c6b0c560757d9d5dd264000602176b92640`, redeem `4f39f79b30bc405a21fd7c413d2068b12434887941215accaba005fb1b7c9356`. Each selected ABI was independently deep-matched against the full carrier and selector/hash calculated from its complete ABI object.

Source inspection date is 2026-10-06, distinct from source publication. The source/deployment association is not a whole-repository compiler artifact or proof of current on-chain configuration.

## Method behavior and limits

The WOETH conversion overrides compute shares/assets from OETH's high-resolution rebasing-credit value and `adjuster`; `totalAssets()` is derived from WOETH supply, adjuster, and rebasing credits rather than raw OETH balance. The source describes donations as ignored after adjuster calculation. `initialize()` opts the contract into OETH rebasing; `initialize2()` sets the adjuster. The deployment/source records do not prove these routines' current storage state.

Inherited `deposit(assets,receiver)` uses the constructor-fixed asset, transfers assets from the caller, mints previewed shares to the caller-selected receiver, and returns shares. `mint(shares,receiver)` rounds required assets up, transfers the fixed asset from caller, mints requested shares to receiver, and returns assets. `withdraw(assets,receiver,owner)` previews shares, spends owner allowance when caller differs (except unlimited allowance), burns owner shares, transfers fixed OETH to receiver, and returns shares burned. `redeem(shares,receiver,owner)` similarly spends allowance, burns owner shares, transfers fixed OETH to receiver, and returns assets. These methods make calls only to their configured asset; no caller-selected target or calldata is introduced.

The fixed OETH asset/configuration, rebasing-credit state, adjuster initialization, conversion rounding/overflow, balances/allowances, governance/upgrades, token behavior, and available assets may affect or revert execution. The platform adds no amount, receiver, owner-equality, balance, feed, or financial gate: ABI-valid zero/arbitrary receiver/owner addresses and full uint256 values remain policy-permitted, subject to protocol checks. Token approvals remain independent; no approval is paired or granted. Withdraw/redeem return OETH, not native ETH, and do not guarantee liquidity or a complete OETH-to-ETH workflow. The admission is not proof of current asset/pause configuration, funded execution, successful transactions, or financial safety.

## Batch preservation

The immutable baseline is the saved dForce iUSDT/iDAI catalog: 739 definitions (716 actions, 23 approvals), 16 scopes, and 69 profiles / 399 IDs. This batch adds four actions, for 743 definitions (720 actions, 23 approvals); all prior full function objects, scope bindings, and profiles remain unchanged, and none of the four new IDs is profiled. The accepted versioned v9 catalog remains unchanged.
