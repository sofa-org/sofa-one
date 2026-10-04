# Expansion 55 — Bebop BOP AMM v7 candidate

**Evidence reviewed:** 2026-10-04. This is an inactive, test-only source candidate; it does not modify admissions, generated catalog data, production registry wiring, runtime profiles, or API-key grants. Baseline is unchanged at 74bb052640: 15 finite scopes and 62 profiles.

## Bounded identity

Ethereum chain 1 router `0xB098881c587f623FAC85eAe60809bEE7A174CeE7`, identified in verified Etherscan source as `BopAmmRouter`. The only selected entrypoint is payable `swapWithAllowance(address,address,uint256,uint256,address,uint256,uint256)`, selector `0xa2e6fd72`, returning `uint256 amountOut`. Its exact compiler ABI is copied into `data/defi-catalog/v7/sources/bebop.json`. Full router ABI SHA-256: `c0966bf4c1d9adb707b0eb4f42793c5374a4c0fcdb9d8328c99953108baec609`; selected function ABI identity: `0x5a53829938a28226220683aed1235bb83c74de4aedb3b88b65e17e3c21fb231f`.

## Evidence and scope limits

- Verified router source: [Etherscan contract source](https://etherscan.io/address/0xB098881c587f623FAC85eAe60809bEE7A174CeE7#code), HTTP 200 captured 2026-10-04T17:24:14Z; verified source bundle SHA-256 `3ffbaf4eed40764bf8e914f8fa514d8a6178d95aafea649d1f8aa1e3c8ad0032`. The full source bundle contained 16 files.
- Full ABI artifact is retained locally in the candidate; source ABI provenance is the same verified Etherscan contract page and date. Router source shows `swapWithAllowance` collects caller input/native value, invokes immutable BOP AMM pool swap, checks fee/min-output, then performs fixed token or ETH transfer. Immutables are declared but current constructor/deployment identity was not asserted.
- Official protocol-role context: [BOP AMM introduction](https://docs.bebop.xyz/bopamm/introduction), consulted 2026-10-04.
- Separate Ethereum core address `0xB09AAA8933626d7E4C48D65dAd2D77021CFBCA9a` was reviewed as role context, not an authorized target. Core source SHA-256 `777ed66296d8371a22a0ad94ddeee6202686d8710911e6068593c3436fd0acdc`; its settlement uses fixed payment/token operations and selected maker hooks. `swapWithCallback` is not reached by this router entrypoint and is excluded.

The bounded product label is **BOP AMM**, not all Bebop RFQ. Adapters and core callback entrypoints are excluded. Fees/maker hooks, pool eligibility, governance, trust, and complete workflows remain limitations; this evidence establishes neither current runtime identity nor active liquidity, funded execution, nor safe outcomes. No exact deployment/creation receipt date is claimed. All financial arguments and native value remain caller-controlled without amount caps or token/recipient pairing restrictions; required approvals are separate and never automatically granted.
