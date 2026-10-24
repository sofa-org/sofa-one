# Renzo registry fixture

Explicit source-qualified test fixture for six ordinary Ethereum user deposit/withdraw methods across RestakeManager and WithdrawQueue. Not imported into production admission; raw v5 source stays inactive. Overloaded functions have distinct selector-derived capability IDs. Funding/allowances are separate. All ABI-valid user arguments remain caller-controlled; protocol intrinsic collateral, pause, cooldown, risk-oracle, and asynchronous queue conditions are not platform allowlists or liquidity guarantees. Not complete Renzo coverage or funded/runtime certification.
