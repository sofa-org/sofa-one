# Rocket Pool v5 expansion fixture research

Snapshot date: 2026-10-04. This is a reviewed source snapshot for an **inactive test fixture**, not a production admission or proof of deployed runtime code, current resolution, funded execution, or transaction safety.

## Bounded scope

Only Ethereum Mainnet (`chainId: 1`) and two exact calls are included:

| Target | Address | Function | ABI | Capability ID |
|---|---|---|---|---|
| Rocket Deposit Pool | `0xDD3f50F8A6CafbE9b31a427582963f465E745AF8` | `deposit()` | payable, no inputs, no outputs | `rocket-pool:v1:1:0xdd3f50f8a6cafbe9b31a427582963f465e745af8:deposit` |
| rETH | `0xae78736Cd615f374D3085123A210448E74Fc6393` | `burn(uint256 _rethAmount)` | nonpayable, no outputs | `rocket-pool:v1:1:0xae78736cd615f374d3085123a210448e74fc6393:burn` |

The Rocket Storage address `0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46` is source context only. Rocket Pool documents resolving contract addresses dynamically using `keccak256(abi.encodePacked("contract.address", name))`, including `rocketDepositPool` and `rocketTokenRETH`; no live resolution was performed. This fixture records reviewed addresses, and updates require a new explicit authority review. No `approve`, arbitrary spender, queue, NFT, or other ABI is admitted.

## Evidence

- Official Rocket Pool integration/deployment documentation, pinned at `https://raw.githubusercontent.com/rocketpool/docs.rocketpool.net/f5ebf7e5b387bd3b10d8ecdeeb37dc6c387688b3/docs/en/protocol/contracts-integrations.md` (repository commit `f5ebf7e5b387bd3b10d8ecdeeb37dc6c387688b3`, observed commit time 2026-10-01T23:25:47Z), identifies the Mainnet Deposit Pool and rETH deployment context.
- Official contracts-usage documentation at the same pinned repository revision documents Rocket Storage keyed lookup and recommends dynamic address discovery.
- Official interfaces at `https://github.com/rocket-pool/rocketpool/blob/fef41a4f7cf99d7d66313c0ba04deb8ba2dabf88/contracts/interface/deposit/RocketDepositPoolInterface.sol` and `.../contracts/interface/token/RocketTokenRETHInterface.sol` declare `deposit() external payable` and `burn(uint256 _rethAmount) external` respectively (repository commit `fef41a4f7cf99d7d66313c0ba04deb8ba2dabf88`).
- The pinned official `RocketTokenRETH.sol` implementation shows burn requires rETH and liquid ETH balances, burns caller rETH, withdraws deposit collateral, then transfers ETH. Redemption thus depends on available liquid ETH; this is not a guaranteed liquidity or execution claim.

The fixture intentionally does not include an ERC20 approval function: the inherited approval ABI was not independently reviewed for this bounded entry, and approval grants are not needed to represent these two calls.
