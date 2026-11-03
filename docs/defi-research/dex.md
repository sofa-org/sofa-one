# Bounded DEX deployment evidence (research only)

Retrieved 2026-10-02. These are official-repository/documentation claims, **not** live-chain code/proxy verification or approval to activate. Pin/recheck deployment docs and perform read-only explorer/RPC bytecode, proxy and implementation checks before any catalog entry. No transaction was sent.

## Newly reconciled Uniswap V3 / SwapRouter02

Official deployments are per-chain pages; absence from older v3-periphery `deploys.md` must not be read as evidence of no Base/Monad deployment. The official docs repo revision retrieved was `Uniswap/docs@1c7597d73be0e9a3a4e44aa75b8fb212b40ea136` (2026-09-02). Pages: [Base](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-base-deployments.mdx), [Monad](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-monad-deployments.mdx), [Optimism](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-optimism-deployments.mdx), [Ethereum](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-ethereum-deployments.mdx), [Arbitrum](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-arbitrum-deployments.mdx), [Polygon](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-polygon-deployments.mdx), [BNB](https://github.com/Uniswap/docs/blob/1c7597d73be0e9a3a4e44aa75b8fb212b40ea136/content/protocols/v3/deployments/v3-bnb-deployments.mdx). Address values transcribed from these official pages:

| Chain ID | Network | Router | Official source |
|---:|---|---|---|
| 8453 | Base | `0x2626664c2603336E57B271c5C0b26F421741e481` | Base deployment page |
| 143 | Monad | `0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900` | Monad deployment page |
| 1 | Ethereum | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | Ethereum deployment page |
| 42161 | Arbitrum | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | Arbitrum deployment page |
| 10 | Optimism | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | Optimism deployment page |
| 137 | Polygon | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | Polygon deployment page |
| 56 | BNB Chain | `0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2` | BNB deployment page |

### Exact SwapRouter02 v3 function ABI (no deadline)

Source code: [`IV3SwapRouter.sol` at Uniswap/swap-router-contracts@70bc2e40dfca294c1cea9bf67a4036732ee54303](https://github.com/Uniswap/swap-router-contracts/blob/70bc2e40dfca294c1cea9bf67a4036732ee54303/contracts/interfaces/IV3SwapRouter.sol); repository main commit SHA obtained via GitHub API (commit date 2024-06-28). Solidity interface uses calldata structs and `external payable`; outputs are `uint256`.

```solidity
struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}
function exactInputSingle(ExactInputSingleParams calldata params)
    external payable returns (uint256 amountOut);

struct ExactOutputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 amountOut;
    uint256 amountInMaximum;
    uint160 sqrtPriceLimitX96;
}
function exactOutputSingle(ExactOutputSingleParams calldata params)
    external payable returns (uint256 amountIn);
```

Canonical ABI tuple signatures are `exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))` and `exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))`. **Neither tuple includes `deadline`** (unlike original V3 SwapRouter's 8-field tuples). These endpoints are fixed selectors, but their tuple includes `sqrtPriceLimitX96`; safest narrow capability constrains it to zero unless explicitly reviewed. Input means fixed input and minimum output; output means fixed desired output and maximum input. Both include recipient. A restrictive catalog validator should reject zero amounts, zero/unsafe min-out, invalid/same tokens, recipient other than wallet, and invalid fee/price limit. ExactOutput must bound input maximum. Standard ERC20 allowance spender is this specific SwapRouter02 address, finite and no broader than the bounded input amount; no permit/Permit2 path is needed. Solidity `payable` is interface stateMutability; restrict native `value` to zero for ERC20-only capability.

### Deployment/capability caveats

Official Base page lists SwapRouter02 and says the deployment package is `@uniswap/swap-router-contracts@1.1.0`; it links the `SwapRouter02.sol` source. Monad page lists SwapRouter02 address above. Official source interface and ABI are obtained from later repository main revision; ensure that deployed runtime bytecode/verified source corresponds to that interface, particularly on Monad. Do not infer immutable/non-proxy status from the address table. Read-only explorer/RPC work remains: chain ID, code nonempty, verified source/compiler/constructor, proxy/beacon/implementation status, implementation code and selector/interface match. Some pages mark the universal router as preferred; that is deliberately excluded because arbitrary command execution is outside this scope. No address generated by CREATE2 is assumed.

## Previously researched bounded families (carried forward, not re-researched)

### Original Uniswap V3 SwapRouter (8-field deadline ABI)

Official periphery source: [`ISwapRouter.sol` at v1.0.0](https://github.com/Uniswap/v3-periphery/blob/v1.0.0/contracts/interfaces/ISwapRouter.sol); deployment list [`deploys.md`](https://github.com/Uniswap/v3-periphery/blob/main/deploys.md). Shared official router address for chain IDs 1, 10, 137, 42161: `0xE592427A0AEce92De3Edee1F18E0157C05861564`. It does not establish Base or Monad.

```solidity
struct ExactInputSingleParams {
  address tokenIn; address tokenOut; uint24 fee; address recipient;
  uint256 deadline; uint256 amountIn; uint256 amountOutMinimum;
  uint160 sqrtPriceLimitX96;
}
function exactInputSingle(ExactInputSingleParams calldata params)
  external payable returns (uint256 amountOut);
struct ExactOutputSingleParams {
  address tokenIn; address tokenOut; uint24 fee; address recipient;
  uint256 deadline; uint256 amountOut; uint256 amountInMaximum;
  uint160 sqrtPriceLimitX96;
}
function exactOutputSingle(ExactOutputSingleParams calldata params)
  external payable returns (uint256 amountIn);
```

### PancakeSwap V3 SwapRouter

Official repository [BSC mainnet deployment artifact](https://github.com/pancakeswap/pancake-v3-contracts/blob/main/deployments/bscMainnet.json) lists BNB chain ID 56 `SwapRouter` `0x1b81D678ffb9C0263b24A97847620C99d213eB14`. Official [ISwapRouter docs](https://github.com/pancakeswap/pancake-v3-contracts/blob/main/projects/v3-periphery/docs/interfaces/ISwapRouter.md) specify eight-field `ExactInputSingleParams`: tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96; `exactInputSingle` is external payable returning amountOut. No other Pancake deployments asserted here. Verify source revision/runtime and proxy status before activation.

## Explicit gaps / exclusions

- No reliable official Monad Uniswap deployment page content was located by the earlier limited search; this follow-up found it in the official per-chain page (address above).
- Aerodrome Base simple route-array ABI had official docs, but no sufficiently verified official router address/immutability evidence was captured; excluded pending evidence.
- Do not treat source/docs lookup as live chain verification, safety approval, or liquidity/market-quality assessment. Fixed swap selector is not sufficient alone: code/proxy status, token behavior, fee policy, recipient and bounds must be reviewed.
