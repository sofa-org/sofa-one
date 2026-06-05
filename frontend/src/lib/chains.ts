export const SUPPORTED_CHAINS = [
  {
    id: 84532,
    name: 'Base Sepolia',
    nativeCurrencySymbol: 'ETH',
    explorerBaseUrl: 'https://sepolia.basescan.org',
    gasHelpUrl: 'https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet',
  },
  { id: 8453, name: 'Base', nativeCurrencySymbol: 'ETH', explorerBaseUrl: 'https://basescan.org' },
  { id: 1, name: 'Ethereum', nativeCurrencySymbol: 'ETH', explorerBaseUrl: 'https://etherscan.io' },
  {
    id: 11155111,
    name: 'Ethereum Sepolia',
    nativeCurrencySymbol: 'ETH',
    explorerBaseUrl: 'https://sepolia.etherscan.io',
    gasHelpUrl: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia',
  },
  { id: 137, name: 'Polygon', nativeCurrencySymbol: 'POL', explorerBaseUrl: 'https://polygonscan.com' },
  {
    id: 80002,
    name: 'Polygon Amoy',
    nativeCurrencySymbol: 'POL',
    explorerBaseUrl: 'https://amoy.polygonscan.com',
    gasHelpUrl: 'https://faucet.polygon.technology/',
  },
  { id: 42161, name: 'Arbitrum One', nativeCurrencySymbol: 'ETH', explorerBaseUrl: 'https://arbiscan.io' },
  {
    id: 421614,
    name: 'Arbitrum Sepolia',
    nativeCurrencySymbol: 'ETH',
    explorerBaseUrl: 'https://sepolia.arbiscan.io',
    gasHelpUrl: 'https://faucet.quicknode.com/arbitrum/sepolia',
  },
  { id: 10, name: 'OP Mainnet', nativeCurrencySymbol: 'ETH', explorerBaseUrl: 'https://optimistic.etherscan.io' },
  {
    id: 11155420,
    name: 'OP Sepolia',
    nativeCurrencySymbol: 'ETH',
    explorerBaseUrl: 'https://sepolia-optimism.etherscan.io',
    gasHelpUrl: 'https://app.optimism.io/faucet',
  },
  { id: 56, name: 'BNB Smart Chain', nativeCurrencySymbol: 'BNB', explorerBaseUrl: 'https://bscscan.com' },
  {
    id: 97,
    name: 'BNB Smart Chain Testnet',
    nativeCurrencySymbol: 'tBNB',
    explorerBaseUrl: 'https://testnet.bscscan.com',
    gasHelpUrl: 'https://www.bnbchain.org/en/testnet-faucet',
  },
] as const;

function getSupportedChain(chainId: number) {
  return SUPPORTED_CHAINS.find((chain) => chain.id === chainId);
}

export function formatChainName(chainId: number) {
  return getSupportedChain(chainId)?.name ?? `Chain ${chainId}`;
}

export function getExplorerAddressUrl(chainId: number, address?: string | null) {
  const explorerBaseUrl = getSupportedChain(chainId)?.explorerBaseUrl;
  if (!explorerBaseUrl || !address) return null;
  return `${explorerBaseUrl}/address/${address}`;
}

export function getExplorerTransactionUrl(chainId: number, txHash?: string | null) {
  const explorerBaseUrl = getSupportedChain(chainId)?.explorerBaseUrl;
  if (!explorerBaseUrl || !txHash) return null;
  return `${explorerBaseUrl}/tx/${txHash}`;
}

export function getChainGasHelpUrl(chainId: number) {
  const chain = getSupportedChain(chainId);
  return chain && 'gasHelpUrl' in chain ? chain.gasHelpUrl : null;
}

export function getNativeCurrencySymbol(chainId: number) {
  return getSupportedChain(chainId)?.nativeCurrencySymbol ?? 'Native';
}
