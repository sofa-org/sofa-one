# Kelp registry fixture

This folder contains an explicit Ethereum Mainnet source fixture for four ordinary user entrypoints on the documented LRTDepositPool and LRTWithdrawalManager proxies. The builder is test/fixture-only and is not connected to production registry admission or automatic grants. It excludes operator-only completion, queue administration, and unconfirmed instant-withdrawal flows. Withdrawal completion is asynchronous and dependent on operator unlock, delay, and liquidity; source proxy roles do not prove current implementation or runtime code.
