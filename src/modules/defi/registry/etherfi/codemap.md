# Ether.fi registry fixture

This folder holds an explicitly source-qualified Mainnet fixture for seven functions on the documented LiquidityPool, weETH, and WithdrawRequestNFT proxy addresses. The builder is test/fixture code only and is not connected to a production registry or automatic grants.

Capability IDs include the exact four-byte selector because the LiquidityPool has overloaded `deposit` functions. The bounded set excludes NFT request/transfer/approval methods and eETH approval. A withdrawal is asynchronous: the LiquidityPool request produces a request NFT, and a distinct later NFT claim depends on finalization. Proxy addresses are documentation evidence, not proof of current implementation or runtime code.
