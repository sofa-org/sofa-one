# Pendle v3 registry fixture

This folder contains a test-only, source-qualified Ethereum fixture with four direct Pendle V3 router functions and two methods from the Standardized Yield interface on one API-identified SY address. The builder is not connected to production admission or automatic grants. Router functions are bound to the official Router V3 deployment role and its source-owned facet interfaces; the SY target comes from one dated official market API record. No runtime facet installation, implementation bytecode, market-wide population, liquidity, or funded execution is established.

Wallet-callable scope deliberately excludes external-swap payloads, arbitrary multicall, zaps, limit orders, and callback executors. Token approvals remain independent. ABI-valid financial arguments and asset selections are caller-controlled without platform-specific limits or allowlists.
