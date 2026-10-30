# Gearbox Pool V3.10 — v6 source candidate

## Qualified slice

This candidate records one Ethereum chain-1 Gearbox user USDC pool, `0xC155444481854c60e7a29f4150373f479988F32D`, and four direct pool operations: `deposit`, `mint`, `withdraw`, and `redeem`. The target and direct deposit/withdraw flow are identified by Gearbox's pinned SDK test at commit `5255ab4449555b6ffbecc50b53b701611600b733`, `src/e2e/tests/pool-deposit-withdraw.test.ts`. Its fixture cites block 24736900 and underlying USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`; that is source-test context, not a currently observed block or liquidity assertion.

The same pinned SDK selects `PoolV310` for pool versions 3.10–3.19 and publishes the exact `iPoolV310Abi` in `src/abi/310/generated.ts`. Four complete nonpayable ABI objects are copied into the fixture with their actual parameter/output names, types, and internal types. The pinned core-v3 source at `a53223a54f19a46a5cffd8104d622ac69f49c311` identifies `PoolV3.sol` version 3.10 and the IPoolV3/IERC4626 role. This is a source-linked dated snapshot, not a live code-hash/proxy-slot, liquidity, or funded-execution proof.

## Authority limits and risks

The inactive raw source candidate and active registry fragment used by tests are not runtime grants or production admission. Only these four ordinary pool selectors are represented. CreditFacade leveraged operations, arbitrary batches/general executors, zappers, permits, approvals, and administrative methods are excluded. Caller-controlled ABI-valid amounts, receiver, and owner remain unrestricted by platform financial caps or owner/health-factor/feed policy. Underlying allowance, pool solvency/liquidity, share conversion, and protocol withdrawal limits remain protocol prerequisites/behavior. A published SDK source test is not represented as having been executed in this task, and no current pool activity or successful funded flow is claimed.
