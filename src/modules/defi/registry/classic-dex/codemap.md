# Classic DEX registry

Contains the fixed, source-admitted direct-call fragment for Aerodrome's Base classic Router and Velodrome's Optimism classic Router. `index.ts` builds seven independently grantable direct swap/liquidity capabilities per router with the verified official ABI and exact four-field routes tuple. The fragment has no approval rows, runtime evidence, validators, or financial caps; parent assembly owns catalog merging and freezing. `index.spec.ts` covers identities, ABI round-trip and authorization policy.
