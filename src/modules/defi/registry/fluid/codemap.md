# Fluid registry fixture

An explicitly invoked Base fixture for two pinned fToken deployment artifacts (eight fixed nonpayable ABI overloads each) and one Vault T1 payable `operate` function. Selector-qualified capability IDs distinguish overloads. This builder is not imported into the runtime production registry; source candidacy is not catalog admission or a grant.

Caller-selected shares/assets, owner/receiver, bounds, signed vault deltas, NFT position ID, recipient, and payable value receive only generic ABI/payability checks. No underlying-token approval, asset binding, health-factor rule, or protocol financial constraint is introduced. Artifact evidence does not establish current runtime identity, liquidity, solvency, or funded execution.
