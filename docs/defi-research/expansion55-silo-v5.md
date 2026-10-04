# Silo v3 Arbitrum WETH/USDC market vault fixture (v5 expansion)

The source is the official `silo-finance/silo-contracts-v2` repository pinned to commit `f896c9da3a4b292f74d8dcb41f1295661cb7441f` (`PinnedSiloConfig.sol`, `silo-core/contracts/interfaces/ISilo.sol`, and source ArbitrumSilo artifact). The pinned `scripts/tasks/set-permissioned-liquidation/v3_markets_by_chain.json` identifies Arbitrum chain 42161 market 3000 WETH/USDC and config `0xE14CC9C2b2429c85Ab11CaDd8c47a043d56CA149`; this config is not itself a user-call target. `PinnedSiloConfig.getSilos()` returns `_SILO0` and `_SILO1`.

The two target roles below are from a parent-observed read-only `eth_call` to selector `0xaecc90cb` at Arbitrum block `0x1e7e173c` (hash `0x0776cfd41b36a5e4c8fcf3e650f716e652203d164c3e709bab74fe1dfa27aa72`, observed 2026-10-04):

- Silo0: `0x84D1B853C1F34a01c6120013AC7AC704D5383a8D`
- Silo1: `0x5B73fb33c602351664D02ed199847B7A155297B5`

These are source-configured user Silo roles, not implementation artifacts. The observation is a dated role snapshot, not current/funded code, liquidity, security, or a complete market population claim.

Each vault fixture binds six nonpayable source signatures: `deposit(uint256,address,uint8)->uint256`, `mint(uint256,address,uint8)->uint256`, `withdraw(uint256,address,address,uint8)->uint256`, `redeem(uint256,address,address,uint8)->uint256`, `borrow(uint256,address,address)->uint256`, and `repay(uint256,address)->uint256`. The four collateral methods use source enum `ISilo.CollateralType` (Protected=0, Collateral=1); this is not equivalent to standard two-argument ERC-4626 signatures. Full ABI internal types are retained. There are no platform amount/asset/receiver/owner/borrower/health-factor caps. Token funding and approvals remain independent. Protocol enum/state, hooks, solvency, collateral requirements and liquidity may constrain outcomes, but are not platform restrictions or guarantees. No generic hooks/callback handlers, flash loans, permits, transfer/admin methods or arbitrary invoke methods are exposed.

`data/defi-catalog/v5/sources/silo.json` remains inactive; `buildSiloVaultRegistry()` is an explicit test fixture and does not publish production capabilities or grants. Its `silo-vault:v3-market:42161:<target-lowercase>:<method>` identities describe a permission template, not a claim about the deployed implementation version. This is a two-target, six-method subset—not all Silo markets, funded execution, liquidity, or protocol-safety certification.
