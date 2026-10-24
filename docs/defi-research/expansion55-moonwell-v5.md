# Moonwell Base v5 expansion candidate

This is a source-qualified, explicitly built fixture; it is not admitted into production or automatically granted. It declares exactly 17 nonpayable capabilities on Base (8453): mint, redeem, redeemUnderlying, borrow, and repayBorrow on the documented mUSDC (`0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22`), mWETH (`0x628ff693426583D9a7FB391E54366292F509D457`), and mUSDbC (`0x703843C3379b52F9FF486c9f5892218d2a065cC8`) addresses; plus enterMarkets and exitMarket on the Comptroller (`0xfBb21d0380beE3312B33c4353c8936a0F13EF26C`).

## Evidence and limits

The official Moonwell contract directory was retrieved 2026-10-04 and lists the addresses above. Function declarations were transcribed from official Moonwell contracts-v2 commit `6914f05d052e026d909ea14058fc1778bec7bf5a` (`MTokenInterfaces.sol`, `MErc20.sol`, `ComptrollerInterface.sol`, `Comptroller.sol`, and `TokenErrorReporter.sol`). The matching of that source to deployed implementation code has not been independently established. The listed addresses do not prove current enabled-market membership, runtime code, liquidity, or funded execution.

The mToken return value is a protocol error code (`0` is `NO_ERROR`; nonzero indicates protocol failure), not an asset amount. A successful EVM transaction therefore does not prove the intended asset movement or protocol action succeeded. Comptroller codes are separate from mToken codes. Generic transaction status semantics are unchanged.

No underlying token address/binding is established here. Do not infer or automatically issue an approval: any approval remains a separate independently selected capability. The caller chooses all ABI arguments; no financial caps, owner/asset/recipient constraints, health-factor filters, or market-list checks are added. Repayment accepts the caller's amount (including its chosen maximum-debt convention). Flow sketch: supply via mint; opt into collateral using enterMarkets and leave via exitMarket; borrow; repay; withdraw by redeeming mTokens or redeemUnderlying by underlying amount. This is not a claim about all Moonwell markets, solvency, liquidity, paid execution, or production admission.

Native ETH/payable mint or repayment, repayBorrowBehalf, liquidation, and broad operator methods are excluded because this fixed source set does not establish a bounded need for them. No compiler, generated catalog, production registry, grant, or profile is changed by this candidate.
