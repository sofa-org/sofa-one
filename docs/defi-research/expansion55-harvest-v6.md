# Harvest Finance fUSDC vault candidate (v6)

This bounded candidate is pinned to official `harvest-finance/harvest` commit `14420a4444c6aaa7bf0d2303a5888feb812a0521`. The pinned README identifies Ethereum fUSDC vault `0xf0358e8c3CD5Fa238a29301d0bEa3D63A17bEdBE` and USDC underlying. The interface is `contracts/hardworkInterface/IVault.sol`; the selected implementation is `contracts/Vault.sol`. This is a dated source snapshot, not evidence of current proxy/code identity, present liquidity, or every Harvest vault/workflow.

Exactly two ordinary nonpayable methods are included, with their complete declared ABI:

| Method | Inputs | Outputs |
| --- | --- | --- |
| `deposit` | `uint256 amountWei` | none |
| `withdraw` | `uint256 numberOfShares` | none |

Pinned implementation behavior is caller-funded: deposit pulls the underlying from the caller and mints vault shares to the caller; withdraw redeems the caller's vault shares for underlying. `doHardWork` is privileged and excluded. This bounded pair does not imply `depositFor` or other unselected methods are universally forbidden. The selected ABI arguments remain caller-controlled `uint256` values without platform caps, owner/feed restrictions, approval pairing, or funded-runtime admission gates. Token allowance, protocol-level access and amount checks, fees, vault state and available assets are intrinsic independent prerequisites. Any token approval is an independent capability and is not included or automatically paired.

The source snapshot and test fixture do not certify current runtime code, liquidity, strategy state, complete workflows, or funded execution. The raw catalog candidate remains inactive. `buildHarvestRegistry()` is active only for isolated Catalog/Policy tests, not production wiring or automatic user grants. Stable IDs are `harvest:v1:1:<lowercase-vault>:deposit` and `harvest:v1:1:<lowercase-vault>:withdraw`.
