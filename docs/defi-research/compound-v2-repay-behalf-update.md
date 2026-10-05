# Compound V2 `repayBorrowBehalf` update

Inspection date: 2026-10-05. This ordinary data update admits one ERC20 CToken selector on three existing Ethereum Compound V2 markets. Pinned source and address-map roles are dated qualification, not current deployment, proxy/delegator, or implementation verification.

## Pinned sources

Official `compound-finance/compound-protocol` commit `a3214f67b73310d547e00fc578e8355911c9d376` pins:

- `networks/mainnet.json` for the cDAI, cUSDC, and cUSDT market addresses;
- `contracts/CTokenInterfaces.sol` for the declaration at line 249;
- `contracts/CErc20.sol` for the fixed ERC20 wrapper and transfer-in at lines 102–105 and 161–187; and
- `contracts/CToken.sol` for the repayment path at lines 630–634 and 643–691.

The source inputs and exact URLs are in `data/defi-catalog/updates/compound-v2-repay-behalf/sources/compound-v2.json`. The accepted v2 snapshot records the pinned network-source raw digest. These source references do not establish current runtime identity or market state.

## Selector and fixed behavior

`repayBorrowBehalf(address,uint256)` has selector `0x2608f818`, full ABI hash `0x03d2ed7ac3a5890a630d11b74cee9b475908a97c7b47e95ce94d3b361c11cc0c`, nonpayable mutability, inputs `borrower: address` and `repayAmount: uint256`, and one unnamed `uint256` output. The ABI model follows the pinned Solidity declaration; it is not compiler output.

The fixed CToken path accrues interest, runs comptroller permission checks, accounts repayment against the caller-selected borrower, and transfers the market's fixed underlying token from `msg.sender`. The protocol supports max-uint full repayment; CErc20 transfer-in handles token return behavior and actual received amounts. The method has no caller-chosen execution target, callback, or arbitrary calldata. Borrower and repayment amount remain caller-selected throughout the ABI domain, without platform financial caps, balance/allowance restrictions, or borrower-equals-execution-owner checks. A separate underlying-token approval may be needed; no approval is paired or granted automatically. Protocol permission, debt, balance, allowance, and token return behavior can affect the returned error code or transaction outcome. The uint256 result is a protocol error code, not an amount repaid or proof of successful protocol action.

## Static catalog result and limits

The plan uses the current accepted Aave EMode projection (693 definitions) as the pinned baseline and admits exactly three chain-1 identities:

- `compound-v2:v2-compound:1:0x5d3a536e4d6dbd6114cc1ead35777bab948e3643:repay-borrow-behalf` (cDAI);
- `compound-v2:v2-compound:1:0x39aa39c021dfbae8fac545936693ac917d5e7563:repay-borrow-behalf` (cUSDC); and
- `compound-v2:v2-compound:1:0xf650c3d88d12db855b8bf7d11be6c55a4e07dcc9:repay-borrow-behalf` (cUSDT).

The inactive source candidates are activated only by exact plan-bound admissions. Production becomes 696 definitions (673 actions, 23 approvals), preserving all 16 scopes and 69 profiles / 399 IDs. All prior 693 function objects and all profiles remain unchanged; none of the three new IDs is profiled. No cETH/native target, new market, automatic grant, approval pairing, financial constraint, runtime identity, funded execution, liquidity, successful repayment, or financial-safety guarantee is included.
