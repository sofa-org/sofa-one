# StakeWise registry fixture

This directory contains a test-only source-qualified fixture for three ordinary calls on the Ethereum Genesis Vault: ETH deposit, asynchronous exit-queue entry, and exited-asset claim. The builder is not wired into runtime/default grants or production admission.

The source snapshot binds the full ABI declarations and official source references. Tests compare source ABIs to fixture ABIs and exercise exact-grant policy, chain/target/selector/canonical calldata, and payability. It does not prove deployed bytecode, current liquidity, queue readiness, or successful funded execution; wider StakeWise deployment and workflow coverage is not claimed.
