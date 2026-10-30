# Hashflow Ethereum RFQ fixture

Test-only Catalog/Policy fragment for two fixed Ethereum router calls: payable `tradeRFQT` and nonpayable `tradeRFQM`, preserving their exact source-defined nested quote tuples. Signed quote data is protocol payload to these fixed router methods and does not authorize arbitrary embedded execution. The raw source candidate is inactive; the builder is not runtime-wired or automatically granted. See [source review](../../../../../docs/defi-research/expansion55-hashflow-v6.md).
