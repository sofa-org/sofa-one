# Lending registry family

`index.ts` defines the fixed-ABI Aave V3 Pool and Compound III USDC Comet function catalog from pinned official address/interface sources. All 34 exact function definitions are active in the simplified function-level model; callers control ABI arguments and protocol contracts enforce their native semantics. Debt-capable Aave borrow and Comet withdraw carry risk warnings. Approval capabilities are independently cataloged in the sibling `approvals.ts`.
