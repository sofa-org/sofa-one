# Symbiotic vault — v6 source candidate

## Qualified candidate

The exact Ethereum chain-1 user vault `0x007e0B8E99c6134E81A1eAAE754460E3202cB671` is listed by the pinned official `symbioticfi/metadata-mainnet` commit `0b2722aaf38d46c7c34c77ddc5336bbd861cc0d3` as “Keyrock Flagship USDC”. The pinned official `symbioticfi/core` commit `83a3a9ab8febe868896780a68345dbf820d843ff` provides `IVault.sol` and `Vault.sol`. The factory role at `0xAEb6bdd95c502390db8f52c8909F703E9Af6a346` is recorded only as a metadata-population cross-check, not as an execution target.

The five selected methods preserve the interface declarations' full primitive ABI names, internal types, outputs, and nonpayable mutability: `deposit(address onBehalfOf,uint256 amount)`, `withdraw(address claimer,uint256 amount)`, `redeem(address claimer,uint256 shares)`, `claim(address recipient,uint256 epoch)`, and `claimBatch(address recipient,uint256[] epochs)`. The raw v6 candidate is inactive. A separate explicit registry fixture exists only for offline policy tests and does not add runtime wiring, production admission, or user grants.

## Workflow and limitations

Deposit transfers collateral from the caller and credits the selected `onBehalfOf`. Withdraw/redeem queue the caller's position for a later epoch and assign the selected claimer. Claim operations consume the caller's claim and transfer assets to the chosen recipient. All ABI-valid receivers, amount/share quantities, and epochs remain caller-controlled; this fixture adds no financial caps, owner restriction, feed/health check, or approval coupling. Protocol-configured depositor whitelist, capacity, address/amount validity, token allowance, epoch timing, and claim eligibility remain intrinsic conditions. Any required token approval is an independent capability, never automatically granted.

The metadata is not proof of present whitelist eligibility, capacity, deployed runtime version, current liquidity, or a completed/funded workflow. No claim of complete Symbiotic coverage or market support is made.
