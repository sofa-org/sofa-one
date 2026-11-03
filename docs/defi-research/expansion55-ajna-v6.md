# Ajna v6 source candidate: Ethereum rETH/DAI ERC20 pool

## Target and source evidence

The pinned official `ajna-finance/subgraph` commit `7e61fb814ae4bb63b0669f03098c0d42bc6fa79d` `networks.json` identifies the Ethereum `ERC20PoolFactory` at `0x6146DD43C5622bB6D12A5240ab9CF4de14eDC625`. The selected user target is pool `0x9cdb48fcbd8241bb75887af04d3b1302c410f671`, **not** the factory or the historical Goerli README pool.

The bounded parent read-only record reports an Ethereum observation at block `0x18e8dc8`, hash `0xfccbc823a2a7ef59d6db6b068c2066ea82de024075007a0ae6e49e49dd71f00`: the official factory reported 224 ERC20 pools, index 0 was the selected address, and typed getters identified rETH collateral and DAI quote. This is one dated exact-instance observation, not a complete market inventory, current-code check, or funded/liquidity proof.

The selected ABI is the literal entry from pinned `abis/ERC20Pool.json`; implementation semantics are cross-checked against Ajna core commit `0f59e78031af76d62ad575c18405eb325b28849f`, `src/ERC20Pool.sol`. The addresses, subgraph ABI, and core source are separately referenced in the inactive snapshot. No deployment code hash or current runtime identity is asserted.

## Selected functions

All six functions are nonpayable and use primitive types for `internalType`:

* `addQuoteToken(uint256 amount_,uint256 index_,uint256 expiry_)` returns `(uint256 bucketLP_,uint256 addedAmount_)`.
* `removeQuoteToken(uint256 maxAmount_,uint256 index_)` returns `(uint256 removedAmount_,uint256 redeemedLP_)`.
* `addCollateral(uint256 amountToAdd_,uint256 index_,uint256 expiry_)` returns `uint256 bucketLP_`.
* `removeCollateral(uint256 maxAmount_,uint256 index_)` returns `(uint256 removedAmount_,uint256 redeemedLP_)`.
* `drawDebt(address borrowerAddress_,uint256 amountToBorrow_,uint256 limitIndex_,uint256 collateralToPledge_)` returns nothing.
* `repayDebt(address borrowerAddress_,uint256 maxQuoteTokenAmountToRepay_,uint256 collateralAmountToPull_,address collateralReceiver_,uint256 limitIndex_)` returns `uint256 amountRepaid_`.

**ABI naming discrepancy:** the prompt's paraphrase called the fourth `repayDebt` address `recipient_`. Both the pinned full subgraph ABI and pinned core source call it `collateralReceiver_`; the candidate and test fixture retain that source name. The ABI selector is unaffected by parameter names, but the full ABI hash is not.

## Boundaries

The pool's native bucket-index, expiry, allowance, solvency, and available-liquidity checks remain protocol conditions. The fixture adds no platform amount/index/owner restrictions, approval coupling, or financial screening. All six methods are user-selectable within their exact ABI types; independent approvals remain separate. The source candidate is inactive, while the separate active registry builder is test-only. This single six-method pool does not claim all Ajna markets, a full lending/liquidation workflow, current runtime identity, liquidity, funded execution, or market coverage.
