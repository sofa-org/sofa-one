/**
 * Official wrapped-native (WETH/WBNB/WMATIC-style) contracts per supported chain.
 * Used only by the static asset-flow classifier for deposit()/withdraw(uint256).
 * Sources: chain canonical wrapped-native deployments (not derived at runtime).
 */
export const SUPPORTED_CHAINS_WETH: Readonly<Record<number, string>> = Object.freeze({
  // Ethereum mainnet WETH9
  1: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  // OP Stack native WETH predeploy
  10: '0x4200000000000000000000000000000000000006',
  // BNB Smart Chain WBNB
  56: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  // Polygon WMATIC / WPOL
  137: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  // Base WETH predeploy
  8453: '0x4200000000000000000000000000000000000006',
  // Arbitrum One WETH
  42161: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  // Base Sepolia WETH predeploy
  84532: '0x4200000000000000000000000000000000000006',
  // Ethereum Sepolia WETH
  11155111: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
  // OP Sepolia WETH predeploy
  11155420: '0x4200000000000000000000000000000000000006',
  // BNB testnet WBNB
  97: '0xae13d989dac2f0debff460ac112a837c89baa7cd',
} as const);
