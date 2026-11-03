# Convex registry fixture

This folder contains a test-only Ethereum Mainnet fixture for four Booster methods and two ordinary methods on one historically observed BaseRewardPool. The builder is not connected to production admission or automatic grants. The reward-pool address was linked from the Booster's pool-0 registry read and pinned source role declarations; this is not a current pool inventory, runtime/funded proof, or liquidity guarantee.

Pool IDs, amounts, and the stake/claim booleans remain caller-controlled ABI inputs without added financial limits, allowlists, ownership checks, or approval coupling. The selected `depositAll` and `withdrawAll` operate on the caller's full relevant token balance. ERC-20 approvals are independent and outside this fixture. Foreign reward overloads, `withdrawTo`, admin/governance, zaps, and arbitrary execution are excluded.
