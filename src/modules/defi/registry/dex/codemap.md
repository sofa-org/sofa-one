# DEX registry family

`index.ts` assembles 12 source-attributed, exact-address `exactInputSingle` functions for original Uniswap V3, Uniswap SwapRouter02, and PancakeSwap V3. Original Uniswap/Pancake use their eight-field deadline tuple; Router02 uses its distinct seven-field tuple without deadline. All three interfaces are payable. These are function grants, not route/asset/amount templates; the caller supplies ABI arguments and protocol behavior is unchanged.
