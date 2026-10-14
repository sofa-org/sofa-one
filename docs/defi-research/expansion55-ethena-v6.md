# Ethena sUSDe V2 — v6 source candidate

## Qualified scope

Official Ethena key-address documentation identifies Ethereum sUSDe at `0x9d39a5de30e57443bff2a8307a4256c8797a3497` and underlying USDe at `0x4c9edd5852cd905f086c759e8383e09bff1e68b3`. The address-specific Sourcify full record is `exact_match`, verified 2024-08-08, compilation `StakedUSDeV2` with Solidity 0.8.19. It supplies the complete ABI objects for seven selected nonpayable methods: `deposit(uint256 assets,address receiver)`, `mint(uint256 shares,address receiver)`, `cooldownAssets(uint256 assets)`, `cooldownShares(uint256 shares)`, `unstake(address receiver)`, `withdraw(uint256 assets,address receiver,address _owner)`, and `redeem(uint256 shares,address receiver,address _owner)`. The empty output names on deposit/mint/withdraw/redeem, typed cooldown outputs, and void unstake output are preserved exactly. No upstream Git commit is claimed for this verified record.

The raw v6 candidate remains inactive. A separate explicit fixture is active only for offline policy tests; it does not wire production, add admissions, or grant API keys. Privileged issuance, admin/permit/signature flows, and generic execution are outside this selected ordinary-user surface.

## Conditional exit workflow and limits

The exact-match implementation source says positive cooldown duration enables cooldownAssets/cooldownShares and disables direct withdraw/redeem. At zero duration the inverse applies. Its constructor initializes the duration to 90 days and an admin can change it; neither fact establishes the present value. `unstake(receiver)` pays the caller-associated accumulated silo assets to the selected receiver after cooldown expiry, or when cooldown duration is zero. Blacklisting and the protocol's state checks remain intrinsic behavior.

Amounts, shares, receivers, and `_owner` are caller-selected within the ABI without platform caps, owner filters, feed rules, or approval pairing. Any USDe approval remains a separate independent capability and is not included or automatic. Documentation and source do not establish current cooldown mode, current duration, available balances/liquidity, successful funding, or a complete market workflow.
