# Ether.fi v5 expansion fixture research

Snapshot date: 2026-10-04. This reviewed source snapshot is an **inactive candidate and explicit fixture only**. It is not a production admission, grant, runtime-code/proxy-implementation verification, funded-execution proof, or comprehensive Ether.fi/Swell coverage.

## Exact bounded set

Ethereum Mainnet (`chainId: 1`); IDs use the canonical function selector without `0x` to keep overloaded methods distinct:

| Target | Function | ABI summary | Capability ID |
|---|---|---|---|
| LiquidityPool `0x308861A430be4cce5502d0A12724771Fc6DaF216` | `deposit()` | payable; returns unnamed `uint256` | `etherfi:v1:1:0x308861a430be4cce5502d0a12724771fc6daf216:d0e30db0` |
| LiquidityPool | `deposit(address _referral)` | payable; returns unnamed `uint256` | `etherfi:v1:1:0x308861a430be4cce5502d0a12724771fc6daf216:f340fa01` |
| LiquidityPool | `deposit(address _user,address _referral)` | payable; returns unnamed `uint256` | `etherfi:v1:1:0x308861a430be4cce5502d0a12724771fc6daf216:f9609f08` |
| LiquidityPool | `requestWithdraw(address recipient,uint256 amount)` | nonpayable; returns unnamed `uint256` | `etherfi:v1:1:0x308861a430be4cce5502d0a12724771fc6daf216:397a1b28` |
| weETH `0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee` | `wrap(uint256 _eETHAmount)` | nonpayable; returns unnamed `uint256` | `etherfi:v1:1:0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee:ea598cb0` |
| weETH | `unwrap(uint256 _weETHAmount)` | nonpayable; returns unnamed `uint256` | `etherfi:v1:1:0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee:de0e9a3e` |
| WithdrawRequestNFT `0x7d5706f6ef3F89B3951E23e557CDFBC3239D4E2c` | `claimWithdraw(uint256 tokenId)` | nonpayable; no return | `etherfi:v1:1:0x7d5706f6ef3f89b3951e23e557cdfbc3239d4e2c:b13acedd` |

The source fixture constructs each exact full ID as `etherfi:v1:1:<lowercase target>:<four-byte selector without 0x>`. The executable IDs are in the registry builder/tests and are not an operation-name family grant.

## Evidence and boundaries

- Official deployed-contract documentation: `https://etherfi.gitbook.io/etherfi/developers/contracts-and-integrations/deployed-contracts.md`. It identifies the Mainnet LiquidityPool, weETH, and WithdrawRequestNFT proxy targets and explicitly describes UUPS proxy roles. The listed targets are the user-call addresses; implementation-looking entries from earlier deployment JSON are not substituted. This source snapshot does not prove current proxy implementation/runtime state.
- Pinned official interfaces at `https://github.com/etherfi-protocol/smart-contracts/tree/15ff96d4d5e8e6a19a472cd40a7bcb858c9e7a88/src/core/interfaces/ILiquidityPool.sol`, `.../src/core/interfaces/IWeETH.sol`, and `.../src/withdrawals/interfaces/IWithdrawRequestNFT.sol` provide the declarations represented above (repository commit `15ff96d4d5e8e6a19a472cd40a7bcb858c9e7a88`, dated 2026-09-30).
- Withdrawal is queued: `requestWithdraw` creates a request NFT and `claimWithdraw` is a later operation after finalization. It is not an instant exit or guaranteed claim. Claim behavior is tied to request/NFT ownership; the fixture adds no platform owner/recipient limits.
- `wrap` requires caller eETH and independent ERC20 transfer authorization. No eETH approval ABI is added or implied. The eETH contract address/funding requirements were not verified for this bounded source snapshot.
- No financial amount caps are introduced: payable values and the caller-controlled recipient/amount/referral/token ID remain protocol inputs. Protocol minimum/maximum/claimability rules are not platform risk policies.
- No NFT request overload restricted to LiquidityPool/adminOperator, NFT transfer/approval/permit, or extra method is included. Current assets, balances, liquidity, funded execution, and runtime code are outside what this reviewed source fixture establishes.
