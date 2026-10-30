# Beefy standard candidate fixture

The family exports a source-only `DefiRegistryFragment` for two Base Beefy standard vault addresses and their four exact fixed-ABI calls each. The fragment is test-only and is not connected to the production registry. Its independently granted operations have no financial argument bounds; token approvals remain separate. The fixture and tests establish declaration/canonical ABI behavior only, not deployment correspondence, runtime code, liquidity, or funded execution. See [source review](../../../../../docs/defi-research/expansion55-beefy-v5.md).
